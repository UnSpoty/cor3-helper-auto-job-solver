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
│  • 6 tabs — Overview, Expeditions, Auto Jobs,  │
│    Auto Jobs, Modules, Logs                 │
│  • components — icons, timer, module-card,     │
│    log-viewer, network-map                     │
│  • Auto Jobs UI: sections/auto-jobs/*    │
│    (network-map, job-list, flow-map, log-      │
│    export) on COR3.uiComponents.*            │
├────────────────────────────────────────────────┤
│ Isolated content (src/entry/content.js)        │
│  • 13 data modules (auth, expeditions,         │
│    archived-expeditions, decisions, market,    │
│    dark-market, srm-market, usol-market,       │
│    stash, loadout, mercenaries, merc-config,   │
│    expedition-config)                          │
│  • automation: timers, auto-refresh, auto-send-│
│    merc, auto-choose-decision, auto-decrypt,   │
│    auto-ice-wall, auto-simple-decrypt, daily-  │
│    ops, auto-jobs (+ auto-jobs/ helpers),      │
│    auto-jobs (+ auto-jobs/pipeline),     │
│    runtime-bridge                              │
│  • 4 appearance modules                        │
├────────────────────────────────────────────────┤
│ MAIN content   (src/entry/content-early.js)    │
│  • interceptors: ws-interceptor (wraps WS),    │
│    http-interceptor (wraps fetch + XHR),       │
│    solver-loader                               │
│  • game core: desktop-window, auto-jobs-bridge,│
│    loadout-panel                               │
│  • 9 Auto Jobs flow modules (+ _sai-flow base) │
│  • 4 solver modules (decrypt, daily-ops,       │
│    ice-wall, simple-decrypt)                   │
├────────────────────────────────────────────────┤
│ Background SW  (src/entry/background.js)       │
│  • keep-alive ping                             │
│  • expedition polling + ext-update probe       │
├────────────────────────────────────────────────┤
│ CORE  (src/core/, loaded into every context)   │
│   bus · store · logger · module · registry     │
│   · settings   (+ shared: i18n, build-info)    │
└────────────────────────────────────────────────┘
```

## Boot order

For every content-script context the manifest lists files in **strict load
order**. Each file is an IIFE that registers itself onto `window.COR3.*`.
The order matters: core primitives must exist before modules use them.

### MAIN content_scripts (`content_scripts[0]`, `world: MAIN`, `run_at: document_start`)

```
1.  src/shared/platform.js           ← isFirefox / isChromium runtime detect
2.  src/shared/constants.js          ← MSG, STORAGE_*, FLOW, CATEGORY, AJ enums
3.  src/shared/build-info.js         ← commit/date stamp
4.  src/shared/dom.js                ← sleep, waitForEl, click, react-input
5.  src/shared/ws-frames.js          ← Socket.IO v4 parser
6.  src/shared/errors.js             ← cor3LogError + back-compat aliases
7.  src/core/bus.js                  ← Bus.window.{post,on}; Bus.runtime.{send,on}
8.  src/core/store.js                ← Store.local / Store.sync facade
9.  src/core/logger.js               ← per-module ring buffer; forwards from MAIN
10. src/core/module.js               ← base class
11. src/core/settings.js             ← module-state persistence
12. src/core/registry.js             ← topo-sort, boot()
13. src/shared/i18n.js               ← translation table
14. src/shared/i18n-bridge.js        ← page-language detect → i18n
15. src/interceptors/ws-interceptor.js
16. src/interceptors/http-interceptor.js
17. src/interceptors/solver-loader.js
18. src/modules/game/desktop-window.js       ← COR3.game.desktop window helper (plain IIFE, not a Module)
19. src/modules/game/auto-jobs-bridge.js     ← Auto Jobs NM context-menu endpoint (plain IIFE, not a Module)
20. src/modules/game/loadout-panel.js        ← site-embedded loadout UI
21-30. src/modules/game/flows/auto-jobs/*    ← 9 Auto Jobs flow modules (file-decryption first, then _sai-flow base + 8 SAI flows)
31. src/modules/solvers/decrypt.js
32. src/modules/solvers/daily-ops.js    ← Game Center Daily Ops solver
33. src/modules/solvers/ice-wall.js     ← SAI Porter-lite r4 ICE WALL solver
34. src/modules/solvers/simple-decrypt.js
35. src/entry/content-early.js       ← Registry.boot()
```

### Isolated content_scripts (`content_scripts[1]`, isolated world, `run_at: document_idle`)

```
1-14. shared/* + core/* + i18n (same prelude as MAIN, minus interceptors)
15.  src/modules/data/auth.js
16-27. src/modules/data/*            ← 12 more data modules (incl. srm-market, usol-market, loadout, archived-expeditions)
27.  src/modules/automation/timers.js
28.  src/modules/automation/auto-refresh.js
29.  src/modules/automation/auto-send-merc.js
30.  src/modules/automation/auto-choose-decision.js
31.  src/modules/automation/auto-decrypt.js
32.  src/modules/automation/auto-ice-wall.js
33.  src/modules/automation/auto-simple-decrypt.js
34.  src/modules/automation/daily-ops.js
35.  src/modules/automation/auto-jobs/pipeline.js  ← Auto Jobs pipeline stages (plain objects)
36.  src/modules/automation/auto-jobs.js           ← Auto Jobs orchestrator (Module)
37.  src/modules/automation/runtime-bridge.js
38-41. src/modules/appearance/*      ← 4 appearance modules
42.  src/entry/content.js            ← Registry.boot() + log-bridge
```

> Load order matters: `auto-jobs/pipeline.js` must load **before**
> `auto-jobs.js` — the orchestrator reads the stages off
> `COR3.autoJobs.pipeline` at `start()`.

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

## Auto Jobs subsystem (orchestrator + stages)

Auto Jobs is a ground-up rewrite of the job pipeline and uses a different
shape from the rest of the codebase — worth understanding before touching it.
(Rules and status live in [CLAUDE.md → Active work](../CLAUDE.md); the full
pipeline diagram lives in [pipelines.md](pipelines.md).)

- **One Module, many stages.** Exactly one registered `COR3.Module`
  (`auto-jobs`, the *orchestrator*, in
  `src/modules/automation/auto-jobs.js`) owns START/STOP and runs an
  infinite loop. The pipeline "modules" are NOT registered modules — they are
  plain stage objects on `COR3.autoJobs.pipeline.stages.*`
  (`src/modules/automation/auto-jobs/pipeline.js`), each with the uniform
  contract `async run(packet, ctx) -> packet`.
- **Packet envelope.** A single growing object (`type: 'aj/packet'`) flows
  stage→stage, getting enriched at each hop. The orchestrator owns ordering,
  cancellation (a generation token invalidates an in-flight cycle on STOP),
  and Flow-Map highlighting.
- **Node ids are shared truth.** `constants.AJ.NODE.*` names every flowchart
  node. The orchestrator stamps the active node onto
  `STORAGE_LOCAL.AJ_PIPELINE_STATE`; the popup Flow Map
  (`COR3.uiComponents.flowMap`) reads the same ids to highlight the live
  stage.
- **Isolation.** The orchestrator runs in the isolated world, owns only
  `AJ_*` / `AUTOJOBS_SETTINGS` keys, logs under id `auto-jobs`, and reads only
  shared read-only game state (`NM_GRAPH` + the four market envelopes). The
  commands it posts are generic `MSG.GAME.*` (REFRESH_*, ACCEPT_JOB,
  COMPLETE_JOB, REVERT_ENDPOINT_TO_HOME, REQUEST_NM_MAP) + its own
  `MSG.AUTOJOBS.*`.
- **MAIN-world bridge.** `src/modules/game/auto-jobs-bridge.js` (a plain
  IIFE, not a Module) is the MAIN endpoint for the Network-Map context menu
  (Open SAI / Open Market). It drives the flows through client functions + direct
  WS rather than DOM coordinate clicks: `COR3.game.desktop`
  (`src/modules/game/desktop-window.js`) opens the windows via React handlers,
  `__cor3SetEndpoint` connects (`network-map.set.endpoint`), and its `saiAccess()`
  gains server access via **Active Access** (`__cor3SaiGetLoginStatus` →
  `__cor3SaiLoginWithAccess`) or, with no grant, by **hacking** the server
  (`COR3.game.loadout.ensureHack` installs HACK software → click the hack-tool →
  the standalone solver wins the minigame → use the granted access). Phase 2's job
  execution (`JOB_FLOW` → `flow-*`) will extend this bridge.

## Cross-world communication

Two transports, **same envelope shape** `{ type, payload }`:

| Direction | Transport | API |
|---|---|---|
| MAIN ↔ isolated content | `window.postMessage` | `Bus.window.post(type, payload)` / `.on(type, handler)` |
| Isolated ↔ popup ↔ SW | `chrome.runtime` | `Bus.runtime.send(type, payload)` / `.on(type, handler)` |

`Bus.runtime.on` accepts both `{type, payload}` (Bus-style) and
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

### Bus tracer recursion

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

Before doing it, verify with `chrome-devtools-mcp` that toggling the UI
switch doesn't already cascade through some other code path you missed.
