# CLAUDE.md

Quick orientation for an AI assistant entering this codebase. Detailed
references live in `docs/`.

## TL;DR

COR3 Helper is a Chrome MV3 (and Firefox-compatible) extension for the
[cor3.gg](https://cor3.gg) game. Modular architecture, ~70 files in `src/`.
Every feature is a `COR3.Module` registered with `COR3.Registry`. Five
execution contexts share a global `window.COR3.*` namespace via classic
IIFE-loaded scripts. No build step.

The legacy monolith (`content.js`, `popup.js`, `job-manager.js`, etc.)
was retired in May 2026; if you find references to those files anywhere,
they're stale.

## Documentation map

Read these in order when ramping up:

| Doc | What's in it |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Execution contexts, boot order, module lifecycle, cross-world topology |
| [docs/module-spec.md](docs/module-spec.md) | Module contract; templates for each kind of module (data / automation / game / flow / solver / appearance / UI section) |
| [docs/messaging.md](docs/messaging.md) | Exhaustive enum of MSG / STORAGE_LOCAL / STORAGE_SYNC / FLOW / CATEGORY / LIMITS with payload shapes and producer/consumer mapping |
| [docs/pipelines.md](docs/pipelines.md) | Diagrams of auto-jobs state machine, auto-send-merc, auto-choose-decision, NM→SC→SAI startup, daily-ops fetch, alarms, auto-refresh, Logger |
| [docs/debugging.md](docs/debugging.md) | Live state probes, chrome-devtools-mcp runbook, common issues, smoke-test script |
| [docs/glossary.md](docs/glossary.md) | Game terms (K/D, SAI, Network Map, etc.), DOM selector reference, Socket.IO frame primer |
| [plans/todo.md](plans/todo.md) | Cross-session checklist; what was done in the rewrite, what's next |

## Project layout

```
cor3-helper/
├── manifest.json
├── README.md
├── CLAUDE.md
├── docs/
│   ├── architecture.md   ← layer diagram, boot order, lifecycle
│   ├── module-spec.md    ← contract + templates
│   ├── messaging.md      ← all MSG / STORAGE / FLOW
│   ├── pipelines.md      ← flow diagrams for each pipeline
│   ├── debugging.md      ← runbook + common issues
│   └── glossary.md       ← game terms + DOM selectors
├── plans/
│   └── todo.md
└── src/
    ├── core/             Bus, Store, Logger, Module, Registry, Settings
    ├── shared/           constants, dom, ws-frames, errors
    ├── interceptors/     ws-interceptor, http-interceptor, solver-loader
    ├── modules/
    │   ├── data/         9 modules — one per WS payload
    │   ├── automation/   9 modules — timers, auto-jobs, auto-send-merc, …
    │   ├── game/         network-map, server-connect, sai-navigator, flows-core, 9 flows
    │   ├── solvers/      decrypt, daily-hack
    │   └── appearance/   4 CSS/DOM toggles
    ├── ui/               popup.html + popup.css + components/ + sections/
    └── entry/            content-early.js, content.js, background.js
```

## Quick orientation: where does feature X live?

| If you want to... | Look at |
|---|---|
| Change how WS frames are parsed | `src/shared/ws-frames.js` |
| Add a new game-data field to track | new file in `src/modules/data/` + entry in `MSG.WS.*` + entry in `STORAGE_LOCAL.*` |
| Tweak auto-jobs scheduling | `src/modules/automation/auto-jobs.js` (the big one) |
| Add a new job type | docs/module-spec.md → "Job flow"; touch `auto-jobs.js`'s `JOB_TYPE_KEYWORDS`, `FLOW_DISPATCH`, `resolveJobParams`; new file in `src/modules/game/flows/` |
| Adjust the SAI navigation pipeline | `src/modules/game/server-connect.js` (login flow), `src/modules/game/sai-navigator.js` (tab switching, helpers) |
| Tune the decrypt minimax | `src/modules/solvers/decrypt.js` (algorithm verbatim from legacy) |
| Add a new popup section | new file in `src/ui/sections/`, `<script>` tag in `src/ui/popup.html`, entry in `TABS` array in `src/ui/shell.js` |
| Add a new chrome.storage.sync user-pref | enum in `STORAGE_SYNC.*`, UI control in `src/ui/sections/settings.js`, listener in the consuming module |
| Toggle an appearance feature | `src/modules/appearance/<feature>.js` (CSS injection, MutationObserver patterns) |

## Development workflow

No build step. Vanilla JavaScript. Manifest's `content_scripts.js` array
loads files in dependency order; modules register on `window.COR3.*`.

```bash
# Syntax-check the whole tree
find src -name '*.js' -exec node --check {} \;

# Reload the extension after a change:
# chrome://extensions/ → click reload icon → refresh cor3.gg tab
```

## When making changes

1. **Read the relevant doc first.** Especially [pipelines.md](docs/pipelines.md)
   for anything touching auto-jobs or auto-send-merc.
2. **Use the constants.** Any new MSG type or storage key must be added
   to `src/shared/constants.js` first; never inline strings in module code.
3. **Use `this.track()` for every subscription.** Otherwise `stop()` /
   reload leaks listeners. See [module-spec.md](docs/module-spec.md).
4. **Touch the manifest.** Adding a module means adding the file path to
   the right `content_scripts[i].js` array. Loaded in order; deps must
   come first.
5. **Verify in chrome-devtools-mcp.** See [debugging.md](docs/debugging.md)
   for the probes and smoke test.
6. **Beware sync-recursion through `Bus.setTrace`.** The Logger trace fires
   synchronously from every `Bus.window.post` / `Bus.runtime.send`. If you
   add anything that calls `Bus.window.post` from inside a tracer or a
   `Logger.subscribe` handler, you will burn the renderer's stack — the
   May 2026 page-freeze incident (see
   [debugging.md → cor3.gg tab freezes solid](docs/debugging.md#cor3gg-tab-freezes-solid-the-moment-the-extension-loads--f12-wont-even-open))
   was exactly this. Logger now gates its tracer on `HAS_STORAGE`; preserve
   the gate.

## Decisions baked into this codebase

**Dropped (not migrated):**
- 6-theme system → single cor3-style theme
- Custom decision modifier sliders → `riskThreshold` (0..10) + fixed formula
- Version-mismatch GitHub banner
- Archived expeditions UI tab (WS event still relayed; storage key still written)
- Standalone WS message debug log → centralized Logger

**Preserved with care:**
- Auto-jobs full state machine (idle/accepting/solving/completing) with
  3 watchdogs, K/D blacklist (parsed from timer text + 5 min buffer),
  bugged-job 2 h TTL, server priorities, debug confirmation gate
- All 9 job flow types: file_decryption, ip_injection, ip_cleanup,
  file_upload, log_deletion, log_download, file_elimination, data_download,
  decrypt_extract
- Decrypt minimax algorithm — verbatim port from legacy
- Daily-hack pattern detection (System Log Integrity + Signal Hack)
- Auto-send-merc with cheapest-AVAILABLE selection + stash-full re-enable
- Multi-alarm system (alarms tick every second, audio via Web Audio API)
- Pop-out window mode (`?mode=popout`)

## Known limitations / next-session priorities

See [plans/todo.md](plans/todo.md) for the full list. High-impact:

1. **Cross-world Module Manager state sync.** Master switches in the UI
   only affect the isolated/SW/popup contexts. MAIN-world Registry doesn't
   subscribe to `chrome.storage.sync.modules` (no `chrome.*` access). Fix
   = `Settings.onChange` listener in `src/entry/content.js` that posts
   `Bus.window` envelopes; corresponding `Bus.window.on` in
   `src/entry/content-early.js` calls `Registry.setModuleState`.
2. **`__cor3Dump()` has no isolated-world handler.** F12 helper still
   posts `COR3_REQ_DUMP` but nobody listens. Add a handler in
   `auto-jobs.js` or a dedicated debug module.
3. **Per-job-type UI toggles.** `autoJobsSettings.enabledJobTypes` is
   honored but no UI controls. Add to Auto-Jobs section.
4. **`debugTriggerJobType`** legacy debug feature: not migrated. Pre-trigger
   one job of a given type from the popup for testing.

## Module ID reference

Quick list of every registered module ID and its world:

**MAIN content_scripts (world: 'MAIN'):**
- `network-map`, `server-connect`, `sai-navigator`, `flows-core` — game core
- `flow-file-decryption`, `flow-ip-injection`, `flow-ip-cleanup`,
  `flow-file-upload`, `flow-log-deletion`, `flow-log-download`,
  `flow-file-elimination`, `flow-data-download`, `flow-decrypt-extract`
- `solver-decrypt`, `solver-daily-hack`

**Isolated content_scripts:**
- `auth`, `expeditions`, `decisions`, `market`, `dark-market`, `stash`,
  `mercenaries`, `merc-config`, `expedition-config` — data
- `timers`, `auto-refresh`, `auto-send-merc`, `auto-choose-decision`,
  `auto-decrypt`, `auto-daily-hack`, `daily-ops`, `auto-jobs`,
  `runtime-bridge` — automation
- `appearance-system-messages`, `appearance-background`,
  `appearance-network-fog`, `appearance-map-fx` — appearance

Plus synthetic ID `bus` (used by Logger to record traced bus traffic) and
`registry` (used by Registry's own warn/error logs).
