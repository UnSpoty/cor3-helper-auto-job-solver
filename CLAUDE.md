# CLAUDE.md

Quick orientation for an AI assistant entering this codebase. Detailed
references live in `docs/`.

## TL;DR

COR3 Helper is a Chrome MV3 (and Firefox-compatible) extension for the
[cor3.gg](https://cor3.gg) game. Modular architecture, ~70 files in `src/`.
Every feature is a `COR3.Module` registered with `COR3.Registry`. Five
execution contexts share a global `window.COR3.*` namespace via classic
IIFE-loaded scripts. No build step.

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
└── src/
    ├── core/             Bus, Store, Logger, Module, Registry, Settings
    ├── shared/           platform, constants, dom, ws-frames, errors
    ├── interceptors/     ws-interceptor, http-interceptor, solver-loader
    ├── modules/
    │   ├── data/         9 modules — one per WS payload
    │   ├── automation/   9 modules — timers, auto-jobs, auto-send-merc, …,
    │   │                  auto-decrypt, auto-ice-wall, daily-ops, runtime-bridge
    │   ├── game/         network-map, server-connect, sai-navigator, flows-core, 9 flows
    │   ├── solvers/      decrypt, daily-ops, ice-wall
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
| Tune the decrypt minimax | `src/modules/solvers/decrypt.js` |
| Add a new popup section | new file in `src/ui/sections/`, `<script>` tag in `src/ui/popup.html`, entry in `TABS` array in `src/ui/shell.js` |
| Add a new chrome.storage.sync user-pref | enum in `STORAGE_SYNC.*`, UI control in `src/ui/sections/overview.js` (or `expeditions.js` if expedition-related), listener in the consuming module |
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
   `Logger.subscribe` handler, you will burn the renderer's stack and
   freeze the page (F12 won't even open). Logger gates its tracer on
   `HAS_STORAGE`; preserve the gate.

## Behaviour notes

- Auto-jobs full state machine (idle/accepting/solving/completing) with
  3 watchdogs, K/D blacklist (parsed from timer text + 5 min buffer),
  bugged-job 2 h TTL, server priorities, debug confirmation gate.
- 9 job flow types: file_decryption, ip_injection, ip_cleanup,
  file_upload, log_deletion, log_download, file_elimination, data_download,
  decrypt_extract.
- Decrypt solver: minimax algorithm against `ParameterCells` (arrow-key
  driven). Submit layer is click-on-cell + ArrowUp + click-SendButton
  (see [docs/glossary.md](docs/glossary.md) → solver-decrypt).
- `solver-daily-ops` (Game Center one-shot): full DOM navigation (open
  Game Center → open Daily Ops card → Start), generic intro click,
  puzzle-type routing, `setReactInputValue` + submit click, WS-readiness
  gates around Start and Submit (`__cor3IsWsReady` / `__cor3WaitForWs`),
  and a post-submit `awaitSubmitFeedback()` scanning verified/reward/fail
  text within 5 s.
- ICE WALL Break solver — SAI's Porter-lite r4 minigame. Cells parsed in
  grid coords (col*31.5, row*54). Matcher works on any target-preview
  shape. MutationObserver-driven loop with 80ms debounce; commits when
  (a) some candidate has full match, (b) exactly one candidate from
  positive matching, or (c) elimination matcher narrows to a unique
  survivor. Click target = LOWEST cell (max row) of the matched shape,
  tie-broken by closest-to-median col. If a click doesn't advance the
  counter within 4s, the anchor is added to an `excludeSet` and the
  matcher re-runs; up to 20 retries per round. Overlay outlines every
  cell of the predicted shape and brightens the click cell.
- Auto-send-merc with cheapest-AVAILABLE selection + stash-full re-enable.
- Multi-alarm system (alarms tick every second, audio via Web Audio API).
- Pop-out window mode (`?mode=popout`).

## Module ID reference

Quick list of every registered module ID and its world:

**MAIN content_scripts (world: 'MAIN'):**
- `network-map`, `server-connect`, `sai-navigator`, `flows-core` — game core
- `loadout-panel` — site-embedded UI: pill anchored next to cor3.gg's
  Notifications widget (via Sentry data-attr, language-independent).
  Opening it auto-powers the system off (`localStorage["loadout-powered"]`
  client-side flag, restored on close — toggleable via AUTO mini-pill),
  then renders equipped/owned hardware + software, resources usage bars
  with hover-delta preview when picking alternatives, and a dynamically
  discovered capability list (DECRYPT/HACK/SEARCH targets — file
  extensions or server types — coloured green=active / grey=available).
  Mutations (equip/unequip software, swap hardware) go via plain WS
  RPCs in src/interceptors/ws-interceptor.js (`__cor3Loadout*` helpers
  — `loadout/equip.software`, `unequip.software`, `equip.hardware`,
  all with options.compress=true). Pre-flight floor-check on install +
  snapshot-diff watchdog + in-panel toast notifications surface
  resource conflicts and silent server rejections.
- `flow-file-decryption`, `flow-ip-injection`, `flow-ip-cleanup`,
  `flow-file-upload`, `flow-log-deletion`, `flow-log-download`,
  `flow-file-elimination`, `flow-data-download`, `flow-decrypt-extract`
- `solver-decrypt`, `solver-daily-ops`, `solver-ice-wall`

**Isolated content_scripts:**
- `auth`, `expeditions`, `decisions`, `market`, `dark-market`, `stash`,
  `loadout`, `mercenaries`, `merc-config`, `expedition-config` — data
- `timers`, `auto-refresh`, `auto-send-merc`, `auto-choose-decision`,
  `auto-decrypt`, `auto-ice-wall`, `daily-ops`, `auto-jobs`,
  `runtime-bridge` — automation
- `appearance-system-messages`, `appearance-background`,
  `appearance-network-fog`, `appearance-map-fx` — appearance

Plus synthetic ID `bus` (used by Logger to record traced bus traffic) and
`registry` (used by Registry's own warn/error logs).
