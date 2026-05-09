# Architecture

This document describes COR3 Helper's modular architecture: the execution
contexts the extension runs in, how modules boot, and how data flows between
worlds. For an exhaustive reference of message types and storage keys, see
[messaging.md](messaging.md). For the Module contract, see
[module-spec.md](module-spec.md).

## Execution contexts

A Chrome MV3 extension can run code in five distinct contexts. COR3 Helper
uses every one of them.

| Context | When | Globals available | Where the code lives |
|---|---|---|---|
| **MAIN content world** | `document_start` on `cor3.gg` / `os.cor3.gg` | `window`, full `WebSocket`, `fetch`, page DOM | `src/entry/content-early.js` (entry); manifest `content_scripts[0]` |
| **Isolated content world** | `document_idle` on `cor3.gg` / `os.cor3.gg` | `chrome.*`, page DOM (separate JS realm), `window.postMessage` | `src/entry/content.js`; manifest `content_scripts[1]` |
| **Background service worker** | always (Chrome) / on demand | `chrome.*`, NO DOM, NO `window` | `src/entry/background.js` |
| **Popup** (toolbar action) | when toolbar button clicked | `chrome.*`, popup DOM | `src/ui/popup.html` + `src/ui/shell.js` |
| **Side panel** | when user opens it | same as popup | same `popup.html` (controlled by `?mode=popout`) |

The MAIN world is the only context that can directly observe the page's
WebSocket frames and `fetch()` calls. The isolated world has `chrome.storage`
and the runtime API. They communicate over `window.postMessage`.

## Layer diagram

```
┌────────────────────────────────────────────────┐
│ UI  (src/ui/popup.html + popup.css + shell.js) │
│  • 5 sections — Overview, Expeditions,         │
│    Auto-Jobs, Modules, Logs                    │
│  • 4 components — icons, timer, module-card,   │
│    log-viewer                                  │
├────────────────────────────────────────────────┤
│ Isolated content (src/entry/content.js)        │
│  • 9 data modules (auth, expeditions, market,  │
│    dark-market, stash, mercenaries, decisions, │
│    merc-config, expedition-config)             │
│  • 9 automation modules (auto-jobs, auto-send- │
│    merc, auto-choose-decision, auto-refresh,   │
│    auto-decrypt, auto-ice-wall, daily-ops,     │
│    timers, runtime-bridge)                     │
│  • 4 appearance modules                        │
├────────────────────────────────────────────────┤
│ MAIN content   (src/entry/content-early.js)    │
│  • interceptors: ws-interceptor (wraps WS),    │
│    http-interceptor (wraps fetch + XHR),       │
│    solver-loader                               │
│  • game core: network-map, server-connect,     │
│    sai-navigator                               │
│  • flows-core + 9 flow modules                 │
│  • 3 solver modules (decrypt, daily-ops,       │
│    ice-wall)                                   │
├────────────────────────────────────────────────┤
│ Background SW  (src/entry/background.js)       │
│  • keep-alive ping                             │
│  • expedition polling                          │
├────────────────────────────────────────────────┤
│ CORE  (src/core/, loaded into every context)   │
│   bus · store · logger · module · registry     │
│   · settings                                   │
└────────────────────────────────────────────────┘
```

## Boot order

For every content-script context the manifest lists files in **strict load
order**. Each file is an IIFE that registers itself onto `window.COR3.*`.
The order matters: core primitives must exist before modules use them.

### MAIN content_scripts (`content_scripts[0]`, `world: MAIN`, `run_at: document_start`)

```
1.  src/shared/platform.js           ← isFirefox / isChromium runtime detect
2.  src/shared/constants.js          ← MSG, STORAGE_*, FLOW, CATEGORY enums
3.  src/shared/dom.js                ← sleep, waitForEl, click, react-input
4.  src/shared/ws-frames.js          ← Socket.IO v4 parser
5.  src/shared/errors.js             ← cor3LogError + back-compat aliases
6.  src/core/bus.js                  ← Bus.window.{post,on}; Bus.runtime.{send,on}
7.  src/core/store.js                ← Store.local / Store.sync facade
8.  src/core/logger.js               ← per-module ring buffer; forwards from MAIN
9.  src/core/module.js               ← base class
10. src/core/settings.js             ← module-state persistence
11. src/core/registry.js             ← topo-sort, boot()
12. src/interceptors/ws-interceptor.js
13. src/interceptors/http-interceptor.js
14. src/interceptors/solver-loader.js
15. src/modules/game/network-map.js
16. src/modules/game/server-connect.js
17. src/modules/game/sai-navigator.js
18. src/modules/game/flows/_shared.js
19-27. src/modules/game/flows/*      ← 9 flow modules
28. src/modules/solvers/decrypt.js
29. src/modules/solvers/daily-ops.js    ← Game Center Daily Ops solver
30. src/modules/solvers/ice-wall.js     ← SAI Porter-lite r4 ICE WALL solver
31. src/entry/content-early.js       ← Registry.boot()
```

### Isolated content_scripts (`content_scripts[1]`, isolated world, `run_at: document_idle`)

```
1-10. shared/* + core/* (same as MAIN, minus interceptor families)
11.  src/modules/data/auth.js
12-19. src/modules/data/*            ← 8 more data modules
20.  src/modules/automation/timers.js
21.  src/modules/automation/auto-refresh.js
22.  src/modules/automation/auto-send-merc.js
23.  src/modules/automation/auto-choose-decision.js
24.  src/modules/automation/auto-decrypt.js
25.  src/modules/automation/auto-daily-hack.js
26.  src/modules/automation/daily-ops.js
27.  src/modules/automation/auto-jobs.js
28.  src/modules/automation/runtime-bridge.js
29-32. src/modules/appearance/*      ← 4 appearance modules
33.  src/entry/content.js            ← Registry.boot() + log-bridge
```

### Service worker (`background.service_worker`, Chrome) / `background.scripts` (Firefox)

```
1-7. shared + core (subset — no DOM helpers needed)
8.   src/entry/background.js         ← keep-alive, expedition polling
```

The SW uses `importScripts(...)` for the prelude when running as a real
service worker. The same file is also listed in `background.scripts` (with
the prelude expanded) for Firefox builds where SW is disabled.

### Popup / side panel

`src/ui/popup.html` loads the same shared+core trio plus the UI components
and sections. Each section module registers itself onto `window.COR3.ui.<id>`
and exposes `mount(el)` / `activate(el)` / `deactivate(el)` lifecycle hooks
the shell calls when switching tabs.

## Module lifecycle

Every feature is a class extending `COR3.Module`. The Registry drives:

```
register(mod)
   └─ Module instance saved to Registry's map

boot()
   └─ Settings.load() → hydrate enabled/logsEnabled per module
   └─ topoSort() by dependsOn
   └─ for each module in topo order:
        └─ init()           ← runs once, regardless of `enabled`
   └─ for each module in topo order:
        └─ if enabled and not started → _runStart()
                                          ↓
                                       start()

setModuleState(id, {enabled, logsEnabled})
   ├─ if enabled flipped to FALSE:
   │     └─ stop dependents first (reverse topo)
   │     └─ then stop the module itself (_runStop)
   └─ if enabled flipped to TRUE:
         └─ start upstream deps first
         └─ then start the module itself
```

The Module base class provides:

- `track(unsub)` — accumulates cleanup callbacks; auto-runs all on `_runStop()`
- `info(msg, ctx)` / `debug` / `warn` / `error` — go through `Logger.push()`,
  honor the per-module `logsEnabled` toggle

## Cross-world communication

Two transports, **same envelope shape** `{ type, payload }`:

| Direction | Transport | API |
|---|---|---|
| MAIN ↔ isolated content | `window.postMessage` | `Bus.window.post(type, payload)` / `.on(type, handler)` |
| Isolated ↔ popup ↔ SW | `chrome.runtime` | `Bus.runtime.send(type, payload)` / `.on(type, handler)` |

`Bus.runtime.on` accepts both `{type, payload}` (Bus-style) and legacy
`{action, ...flat}` envelopes — the popup uses the latter via
`chrome.tabs.sendMessage(tab.id, {action: 'foo', ...})` because messages
must target a specific tab to reach the content script.

`Bus.setTrace(fn)` lets the Logger snoop on all bus traffic; trace entries
are written under module id `bus`.

## Cross-world logging

The MAIN world has no `chrome.storage`. Logger detects this on construction
(`HAS_STORAGE = !!chrome?.storage?.local`) and switches strategy:

```
[MAIN module] this.info('msg')
   └─ Logger.push(moduleId, 'info', 'msg', ctx)
       └─ if HAS_STORAGE: ingestLocal() → buffer + flush
       └─ else: Bus.window.post('COR3_LOG_REMOTE', {moduleId, entry})
                          ↓
[isolated entry/content.js]
   Bus.window.on('COR3_LOG_REMOTE', ({moduleId, entry}) => {
       Logger.ingest(moduleId, entry);   ← writes to chrome.storage.local.cor3_logs
   });
```

End result: every log line, regardless of which world emitted it, lands in
`chrome.storage.local.cor3_logs[moduleId]` and is visible in the popup's
Logs tab.

### Bus tracer recursion (resolved May 2026)

Logger also installs `Bus.setTrace(...)` to record every cross-world Bus
event under the synthetic module id `bus`. Critically, this registration is
gated on `HAS_STORAGE`. **Do not remove that gate.** Without it, MAIN world
hits unbounded synchronous recursion on the first log line:

```
push('mod', INFO, 'msg')           // any module logs
  → Bus.window.post('COR3_LOG_REMOTE', …)   // MAIN forwards (no chrome.storage)
    → trace('send', 'window', 'COR3_LOG_REMOTE', env)   // sync inside winPost()
      → push('bus', DEBUG, 'SEND window COR3_LOG_REMOTE', env)
        → Bus.window.post('COR3_LOG_REMOTE', …)   // and around again
          → trace(…) → push(…) → … stack overflow
```

This froze the cor3.gg tab so hard that DevTools couldn't open. The fix is
threefold: gate `setTrace` on `HAS_STORAGE`, keep an `inTrace` re-entry
guard, and skip `COR3_LOG_REMOTE` inside the tracer (it's already ingested
under its real `moduleId`, no need to dup as `bus` debug). The receiving
isolated side still traces `recv`, so bus traffic is still visible.

## Storage as pub/sub

Each data module owns a small set of `chrome.storage.local` keys. UI sections
subscribe via `Store.local.onChanged((changes) => ...)` so when a module
writes to its key, the UI rerenders without explicit polling.

User preferences live in `chrome.storage.sync` under fixed keys (see
`STORAGE_SYNC.*`). Changing a sync key from the UI is automatically picked up
by the relevant module via `Store.sync.onChanged()`.

The full storage key catalog is in [messaging.md](messaging.md).

## Cross-world Module Manager: known limitation

The Module Manager UI persists per-module state to
`chrome.storage.sync.modules`. The isolated-world Registry subscribes via
`Settings.onChange()` and reacts. **The MAIN-world Registry does not** —
MAIN has no `chrome.*` access. So toggling a MAIN-world module's master
switch in the UI persists the state but doesn't actually start/stop the
module.

To finish this, add to `src/entry/content.js`:

```js
Settings.onChange((id, next) => {
    Bus.window.post('COR3_MODULE_STATE_CHANGE', { id, state: next });
});
```

and to MAIN-world registry init:

```js
Bus.window.on('COR3_MODULE_STATE_CHANGE', ({id, state}) => {
    Registry.setModuleState(id, state);
});
```

This is tracked in [`plans/todo.md`](../plans/todo.md). Before doing it,
verify with `chrome-devtools-mcp` that toggling the UI switch doesn't
already cascade through some other code path you missed.
