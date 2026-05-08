# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**COR3 Helper** is a Chrome extension (Manifest V3) that enhances the [cor3.gg](https://cor3.gg) game by intercepting WebSocket data and presenting an enriched popup/side-panel UI with timers, market info, auto-solvers, and mercenary management.

**Status: full modular rewrite complete (Phases 1–6).** All legacy monolith files have been replaced. Plan in `C:\Users\Admin\.claude\plans\glistening-beaming-dawn.md`; cross-session log in `plans/todo.md`.

## Development Workflow

No build step. Vanilla JavaScript. Manifest's `content_scripts.js` array loads files in order; modules register on the global `COR3.*` namespace.

**Reload after changes:**
1. Edit source files
2. Go to `chrome://extensions/` (Developer Mode on)
3. Click reload on COR3 Helper
4. Reopen popup or refresh game tab

**Syntax check:**
```bash
find src -name '*.js' -exec node --check {} \;
```

## Architecture

```
┌────────────────────────────────────────────────┐
│ UI (src/ui/popup.html)                         │
│  • shell.js: tabs, mode detection              │
│  • components/: timer, module-card, log-viewer │
│  • sections/: overview, stash, mercs,          │
│              auto-jobs, alarms, modules,       │
│              logs, settings                    │
├────────────────────────────────────────────────┤
│ Isolated content world (src/entry/content.js)  │
│  • 9 data modules (one per WS payload)         │
│  • 9 automation modules (timers, auto-jobs,    │
│    auto-send-merc, auto-choose, auto-decrypt,  │
│    auto-daily-hack, daily-ops, runtime-bridge, │
│    auto-refresh)                               │
│  • 4 appearance modules (system-msgs, bg, fog, │
│    map-fx)                                     │
├────────────────────────────────────────────────┤
│ MAIN content world (src/entry/content-early.js)│
│  • interceptors: ws, http, solver-loader       │
│  • game core: network-map, server-connect,     │
│    sai-navigator                               │
│  • flows-core + 9 flow modules                 │
│  • 2 solver modules (decrypt, daily-hack)      │
├────────────────────────────────────────────────┤
│ Background SW (src/entry/background.js)        │
│  • keep-alive ping                             │
│  • expedition polling for auto-features        │
├────────────────────────────────────────────────┤
│ CORE (src/core/)                               │
│  bus · store · logger · module · registry      │
│  · settings                                    │
└────────────────────────────────────────────────┘
```

## Module Contract

Every feature is a class extending `COR3.Module`. See [docs/module-spec.md](docs/module-spec.md) for the full contract.

```js
class FooModule extends COR3.Module {
    constructor() {
        super({
            id: 'foo',
            name: 'Foo Feature',
            category: COR3.constants.CATEGORY.AUTOMATION,
            dependsOn: ['network-map'],
            owns: { storageKeys: ['fooSetting'], busTypes: [] },
        });
    }
    async start() { this.track(Bus.window.on('FOO_EVT', () => {/*...*/})); }
}
COR3.Registry.register(new FooModule());
```

## Core primitives (`src/core/`)

| File | Purpose |
|---|---|
| `bus.js` | `Bus.window.{post,on}` (postMessage MAIN↔isolated) and `Bus.runtime.{send,on}` (chrome.runtime). Accepts both `{type, payload}` and legacy `{action, ...}` envelopes. |
| `store.js` | Promise-based `Store.local` / `Store.sync` over chrome.storage. `getOne`, `setOne`, `onChanged`. |
| `logger.js` | Per-module ring buffer (200 entries) under `chrome.storage.local.cor3_logs`. MAIN-world entries auto-forward via `COR3_LOG_REMOTE` window envelope; isolated-world Logger ingests them. |
| `module.js` | Base class. `track(unsubscribe)` for auto-cleanup. `info/debug/warn/error` log helpers. |
| `registry.js` | `register()`, topo-sort by `dependsOn`, `boot()`, `setModuleState(id, partial)` with cascade stop/start. |
| `settings.js` | Persists `{[id]: {enabled, logsEnabled}}` to `chrome.storage.sync.modules`. |

## Shared utilities (`src/shared/`)

| File | Purpose |
|---|---|
| `constants.js` | Single source of truth for `MSG.*`, `STORAGE_LOCAL.*`, `STORAGE_SYNC.*`, `FLOW.*`, `CATEGORY.*`, `LOG_LEVEL.*`, `LIMITS.*`. **Never inline message-type strings.** |
| `dom.js` | `sleep`, `waitForEl`, `clickEl`, `dblClickEl`, `setReactInputValue`, `findByText`, `requery`, `retry`. |
| `ws-frames.js` | Socket.IO v4 frame parser/encoder. |
| `errors.js` | `COR3.errors.logError(source, error, ctx)` + back-compat `cor3LogError/Get/Clear` and stubbed `cor3LogWsMessage`. |

## Cross-world communication

- **MAIN ↔ isolated**: `window.postMessage` via `Bus.window`. Type names from `MSG.*`.
- **Popup → content script**: `chrome.tabs.sendMessage(tab.id, {action, ...})`. The runtime-bridge module forwards each known action to MAIN via Bus.
- **SW → content script**: `chrome.tabs.sendMessage(tab.id, {action})`.
- **Storage as pub/sub**: `Store.local.onChanged` / `Store.sync.onChanged`.
- **Logger trace**: `Bus.setTrace(fn)` — Logger automatically traces all bus traffic under module id `bus`.

## Decisions locked in for this rewrite

**Dropped:**
- 6-theme system → single cor3-style theme
- Custom decision modifier sliders → `riskThreshold` (0–10) + fixed formula
- Version-mismatch banner (GitHub poll)
- Archived expeditions tab
- Standalone WS message debug log (`cor3_ws_messages`) — replaced by centralized Logger

**Preserved:** Auto-jobs (9 flow types), Auto-send/choose merc, Auto-choose decision, Auto-refresh, Auto-decrypt, Auto-daily-hack, multi-alarms, side-panel + pop-out modes, game-appearance toggles, bugged-jobs blacklist, server priority list, bearer-token capture.

## Storage Keys

All keys enumerated in [src/shared/constants.js](src/shared/constants.js). Highlights:

**Local (game data + runtime):**
- Data: `expeditionsData`, `expeditionDecisions`, `marketData`, `darkMarketData`, `darkMarketAvailable`, `stashData`, `mercenariesData`, `expeditionConfigData`, `mercConfigData`, `dailyOpsData`, `dailyRewardsData`, `bearerToken`, `webVersion`, `systemVersion`
- Auto-jobs runtime: `autoJobsState`, `autoJobsQueue`, `autoJobsLog`, `buggedJobIds`, `autoJobsPendingConfirm`, `autoJobsConfirmResult`, `networkMapServers`
- New: **`cor3_logs`** — `{ [moduleId]: [{ts, level, msg, ctx}, …] }` (200 per module)

**Sync (user prefs):**
- `selectedTheme`, `alarms`, `autoSendMerc`, `autoJobsSettings`, `serverPriorities`, `autoRefresh`, `autoDecryptEnabled`, `autoDailyHackEnabled`, `disableSystemMessages`, `disableBackground`, `disableNetworkFog`, `disableMapFxEnabled`
- New: **`autoChooseEnabled`**, **`riskThreshold`** (replaces `decisionModifiers`)
- New: **`modules`** — `{ [moduleId]: {enabled, logsEnabled} }` (Module Manager state)

## Known patterns & constraints

- **Socket.IO v4 frames**: WS messages start with `"42"`. Use `COR3.wsFrames.parseFrame(raw)`.
- **K/D detection**: A `MaintenanceTimer` containing a `[data-sentry-component="TimerIcon"]` SVG indicates K/D — emit `COR3_JOB_KD_DETECTED`. Plain text-only timer = cooldown, not K/D.
- **Server unreachable**: `network-map` posts `COR3_SERVER_UNREACHABLE` when Connect button reappears OR `window.__serverPathFailed` is set by WS interceptor (no-path-to-server). Auto-jobs blacklists the server for 30 min (or longer if K/D in chain).
- **Virtual-scroll re-query**: After IP-list deletes in SAI Transit, re-query the scroll container — React replaces the DOM. Use `COR3.dom.requery()`.
- **React inputs**: Always use `COR3.dom.setReactInputValue(el, value)` — direct `el.value =` doesn't trigger React onChange.
- **Bugged-job skip**: Timed-out jobs are written to `buggedJobIds` with 2h TTL (`LIMITS.BUGGED_JOB_TTL_MS`).
- **Auto-jobs state TTL**: `autoJobsState` is restored on reload only if its `updatedAt` is younger than `LIMITS.AUTOJOBS_STATE_TTL_MS` (5 min).

## Adding a new module

1. Create `src/modules/<category>/<id>.js` with the IIFE pattern (see `docs/module-spec.md`).
2. If isolated-world: append the file path to `manifest.json → content_scripts[1].js` (after core/, before `entry/content.js`).
3. If MAIN-world: append to `content_scripts[0].js` (after core/, before `entry/content-early.js`).
4. If background: append to `background.scripts` (Firefox) — Chrome SW uses importScripts in `src/entry/background.js`.
5. If popup: add `<script>` tag to `src/ui/popup.html` and a `mount(el)` method on `COR3.ui.<id>`.
6. New storage keys → register in `src/shared/constants.js`.
7. New bus types → register in `src/shared/constants.js`.

## Debugging via chrome-devtools-mcp

`.claude/.mcp.json` and `.vscode/mcp.json` register the chrome-devtools-mcp server. From a Claude session you can:
- Open the cor3.gg tab via the MCP browser
- Run `window.COR3.Registry.list()` in either MAIN or ISOLATED world to see registered modules
- Read `chrome.storage.local.cor3_logs` directly
- Verify storage keys, check live state without round-tripping the popup

## Game layer detail

```
network-map  ←  server-connect  ←  sai-navigator  ←  flows-core
                                                       │
                                                       └─→ 9 flow modules
solver-decrypt    (independent — listens for COR3_START_DECRYPT_SOLVER)
solver-daily-hack (independent — listens for COR3_START_DAILY_HACK)
```

Helpers exposed on `window.COR3.game.*`:
- `COR3.game.networkMap.{findServerItemByName, checkServerKD, listServersOnKD, ensureNetworkMapOpen, openServerMarket, scrapeAndPostServers, SEL}`
- `COR3.game.serverConnect.{connect, getSaiForServer}`
- `COR3.game.sai.{findOrOpenSai, navigateToSection, waitForSaiContent, addIpViaModal, downloadsWatcher, find* row helpers, SEL}`
- `COR3.game.flows.{isWatching, setWatching, sendDone, sendTimeout, userLog, startFlow}`

## Auto-jobs orchestrator (state machine)

States: `idle` → `accepting` → `solving` → `completing` → `idle`

| Watchdog | Threshold | Action |
|---|---|---|
| `accepting` stuck | 60s | reset to idle, drop bulk, drain queue |
| `solving` stuck | 3 min | bug job, abort flow, reset to idle, next from queue after 3s |
| `completing` stuck | 45s | reset to idle, refresh market |
| K/D blacklist | 2h | parsed from `MaintenanceTimer` text |
| Bugged-job blacklist | 2h | timed-out job IDs skipped on next scan |
| Cooldown after timeout | 20s | no new accepts |

**Resume on reload**: `autoJobsState.status === 'solving'` (with `jobId` set) ⇒ re-dispatch START_*_FLOW after `JOB_MANAGER_READY`.

**Resume in-progress (TAKEN jobs from market data)**: `tryResumeInProgress()` runs after every market refresh; pulls TAKEN jobs back into the queue if they're not bugged and not in the queue already.

## Limitations / future work

- **Cross-world Module Manager state sync**: master switches only affect the isolated/SW/popup contexts. MAIN-world Registry doesn't subscribe to `chrome.storage.sync.modules` because it has no chrome.* APIs. To fully control MAIN modules from UI, add a Bus.window broadcast from isolated entry to MAIN on settings change. (See `plans/todo.md`.)
- **`debugTriggerJobType`** legacy debug feature: not exposed in new UI. Add a per-type test button to the Auto-Jobs tab if needed.
- **Per-job-type toggle UI**: `autoJobsSettings.enabledJobTypes` is honored by the orchestrator but no UI controls exist yet.
