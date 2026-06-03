# Glossary

Game-side terminology used in the codebase. Useful when reading the
auto-jobs orchestrator, flow modules, or DOM selectors.

## Game terms

**cor3.gg** — the game itself; in-browser hacking simulator. Most logic
runs on the front-end with state synced via Socket.IO over WebSocket.

**os.cor3.gg** — apparently a related domain. Manifest matches both.

**Network Map (NM)** — the in-game UI panel listing all servers the
player can interact with. Each server is a tile (`ServerItem`). Clicking
a tile selects it and reveals a side panel with Connect / Login icons.

**Server** — a node on the Network Map. Has a name like `RM7-S4L4`,
`D4RK RM7MI`. The "home" server is the player's own (no Connect needed).
Servers can be on **K/D**.

**K/D (Killswitch / Countdown / Kingdom-Down)** — a server's maintenance
state. While active the server is unreachable. It is read from the
`network-map.get.map` WS frame: each server carries an `isInMaintenance` flag,
surfaced on `NM_GRAPH.servers[]` and consumed by the pipeline's `checkAccess`
stage as `onCooldown`. A job whose server is on K/D is **postponed** by
`jobServerReachable()` (never bugged) until the next rescan clears it.

**Markets** — four job boards. **Home Market** (id
`019d3ea4-85bd-7389-904d-8f7c85841134`) is the player's own. **Dark Market
(D4RK)** (market `019d3ea4-…-908ba9194aa0`, server
`019d29c5-4b37-79bf-b23e-304d8ea03c15`), **SRM7-M (SOYUZ)** (market
`019da731-…`, server `019da6f1-…`) and **URM7-M (USOL)** (market `019e4065-…`,
server `019e4052-…`) are remote: fetching them flips the WS endpoint to their
server, runs `get.jobs`, then reverts to home. Each may be unreachable
(no-path-to-server) — the `darkMarketAvailable` / `srmMarketAvailable` /
`usolMarketAvailable` flags track this.

**Job** — a task on the market. Has a `name`, `category`, `relatedServers`
(IDs of servers needed to complete it), and `conditions` (the params:
file names, IPs, log seqs, etc.). Statuses: `AVAILABLE`, `TAKEN` (in-progress),
`FAILED` (surfaced on the Job List, dismissable), `COMPLETED`.

**Job type** — derived from job name keywords. We support 9 types — see
[messaging.md → FLOW](messaging.md#flow--job-type-identifiers).

**SAI (Server Administration Interface)** — the in-game server admin
subsystem (Logs, Files, Transit Access). The extension no longer scrapes the
SAI terminal DOM: the flows read + mutate it **purely over WS** via the
`__cor3Sai*` helpers (`get.transit`/`get.files`/`get.logs` + the
`transit/file/log` mutations), resolving each reply off `MSG.WS.SAI_*`.

**Active Access** — a `task_access` grant that lets the player log into a
server without a password. Read from `sai.get.login.status` (`activeAccesses[]`)
and used headlessly by `__cor3SaiLoginWithAccess`. With no grant the flow HACKS
the server instead (install HACK software → solve the hack minigame → use the
freshly-minted grant).

**Container** — reward chest at the end of a successful expedition. Must
be opened (`open.container`) before items can be `collect.all`'d into the
stash.

**Mercenary (merc)** — a hireable agent for expeditions. Has `status`
(`AVAILABLE`, `RESTING`, etc.), `callsign`, and after `configure` a per-merc
`{totalCost, riskScore, …}`.

**Expedition** — multi-step sci-fi mission with mercenary, location, zone,
objective. Has `endTime`, may have pending `decisionOptions` mid-run.

**Decision** — branching choice during an expedition. Each option has
`lootModifier` (positive, more reward) and `riskModifier` (positive, more
risk). Auto-choose-decision picks the option with highest score given a
single user threshold.

**Stash** — player inventory. Has `currentUsage`, `maxCapacity`. Auto-send
disables itself when stash doesn't have ≥ 2 free slots.

## Code abbreviations

**MSG** — message type enum (see `constants.js`).

**STORAGE_LOCAL / STORAGE_SYNC** — chrome.storage key enums.

**FLOW** — job type identifier enum.

**CATEGORY** — module category for Module Manager UI grouping.

**LIMITS** — tunables (ring-buffer sizes). Auto Jobs loop/timeout tunables live
under `AJ.LOOP.*`, not `LIMITS`.

**AJ** — Auto Jobs constant group (`constants.AJ`): `NODE` (flowchart
node ids), `LOOP` (cadence), `PACKET_TYPE`. Storage keys are `STORAGE_LOCAL.AJ_*`.

**orchestrator** — the single registered Module `auto-jobs` that owns
START/STOP and runs the pipeline loop. Distinct from the **stages** it drives.

**stage** — a plain object on `COR3.autoJobs.pipeline.stages.*` with
`async run(packet, ctx) -> packet`. NOT a registered module.

**packet** — the single growing envelope (`type:'aj/packet'`) that flows
stage→stage, enriched at each hop.

**TAKEN / in-progress** — a job we've accepted. It leaves the market board's
`jobs[]` and appears in `recentJobs[]` with `status:'TAKEN'`. The available board
(`jobs[]`) carries no status — being on the board IS "available".

**Downloads widget** — an on-screen panel in the game desktop (see
`loadout.html`), NOT a filesystem directory. data_download/upload flows interact
with it.

**Bus** — cross-context message bus (`Bus.window` for postMessage,
`Bus.runtime` for chrome.runtime).

**Store** — chrome.storage facade.

**MAIN world** — page's JS realm. Has `window`, `WebSocket`, page DOM.
No `chrome.*`.

**Isolated world** — extension's content-script realm. Has `chrome.*` and
its own copy of the page DOM. Cannot see MAIN-world `window` properties
directly, but can post messages to it via `window.postMessage`.

## DOM selectors of note

The SAI flow is now driven purely over WS (no SAI-terminal / server-connect /
Add-IP / file-picker / market-window DOM scrape), so the only DOM the code still
touches is: the Network-Map tiles (to tap a server — the map exposes no callable
selection handler), the dock launcher (to open windows via React handlers), and
the minigame / puzzle roots the solvers watch. Selectors still referenced in
code:

| Selector | What it identifies | Used by |
|---|---|---|
| `[data-sentry-component="ServerItem"]` | one tile in the Network Map | `desktop-window.js` `findServerTile` / `selectServerTile` |
| `[data-sentry-component="HomeServerIcon"]` | marks the home server tile | `desktop-window.js` |
| `[data-sentry-component="NetworkMapApplication"]` | the NM window itself (panel-button search root) | `desktop-window.js` |
| `[data-onboarding-300-id="…"]` | panel buttons (`ServerInfoPanelLoginButton`) + the `SaiHackTools` section | `desktop-window.js` `findPanelButton`, `_sai-flow.js` hack path |
| `[data-component-name="TabBarItem-<APP>"]` | dock launcher per desktop app (e.g. `TabBarItem-NETWORK_MAP`) | `desktop-window.js`, `solver-daily-ops` |
| `[data-component-name="FolderApplication"]` | Downloads folder window | `file-decryption.js` |
| `[data-sentry-component="ConfigHackApplication"]` | the decrypt (config-hack) minigame app (watch root) | `solver-decrypt`, `_sai-flow.js` presence probe |
| `[data-sentry-component="ParameterCells"]` | the decrypt minigame's parameter row (4 cell buttons + Send) | `solver-decrypt` |
| `[data-sentry-element="SendButtonStyled"]` | the decrypt minigame's Send button (mousedown+mouseup+click submits) | `solver-decrypt` |
| `[data-sentry-element="LogContentStyled"]` | log panel inside ConfigHackApplication (also the minigame-presence probe) | `solver-decrypt`, `file-decryption.js`, `_sai-flow.js`, `auto-jobs-bridge.js` |
| `[data-sentry-component="IceWallBreakApplication"]` | the ICE WALL break minigame | `solver-ice-wall`, `_sai-flow.js` presence probe |
| `[data-sentry-component="SimpleDecryptApplication"]` / `[data-component-name="SimpleDecryptApplication"]` | the one-click Simple Decrypt minigame | `solver-simple-decrypt`, `_sai-flow.js` presence probe |
| `.pulse-timeline` / `.pulse-group` / `.pulse-bar` | Signal Hack puzzle DOM | `solver-daily-ops` |
| `.log-entries` (or variants) / `.log-entry` | System Log Integrity puzzle | `solver-daily-ops` |
| `.confirm-button` / `.error-type-button` / `.fix-error-button` / `.error-analysis-block` | log-integrity solver UI | `solver-daily-ops` |

## Solver-specific maps

`solver-decrypt` (config-hack):
- 4 fields × N options each (e.g. `[[v1.0,v1.1,v2.0],[GET,PUT,POST],…]`)
- Submits guesses; reads `Mismatched <n>` from the log
- Uses minimax with memoization; cached solver state for the standard
  4-field layout
- Submit layer: the puzzle uses arrow-key-driven `ParameterCells`. Solver:
  - **Focuses a cell** by dispatching `mousedown + mouseup + click` on its
    button (React onMouseDown is the focus handler — `.click()` alone
    doesn't fire it)
  - **Cycles a cell's value** with `ArrowUp` keydown/keyup events
    targeted at `[data-sentry-component="ConfigHackApplication"]`
  - **Submits** by clicking `[data-sentry-element="SendButtonStyled"]`
    with the same mouse sequence (Enter via JS dispatch only fires
    submit when focus is on the LAST cell — fragile; clicks work from
    any state)

`solver-daily-ops`:
- **System Log Integrity:** picks 2 worst log lines, fills in error fixes
- **Signal Hack:** decodes pulse groups as Morse (5-pulse) or Binary (4-pulse), reports value

Maps:
```js
MORSE_MAP: {LLLLL: '0', SLLLL: '1', SSLLL: '2', SSSLL: '3', SSSSL: '4',
            SSSSS: '5', LSSSS: '6', LLSSS: '7', LLLSS: '8', LLLLS: '9'}
BINARY_MAP: {SSSS: '0', SSSL: '1', SSLS: '2', SSLL: '3', SLSS: '4',
             SLSL: '5', SLLS: '6', SLLL: '7', LSSS: '8', LSSL: '9'}

VALID_TYPES (System Log): AUTH, TEMP-SYNC, SCAN, ROUTE-CHECK, RADIO-TEST, PING, SYNC
VALID_STATUSES (System Log): OK, WARN, ERROR
ERROR_LABELS: TIME, TYPE, MISSING_SECTOR, MISSING_STATUS, SECTOR_BAD, STATUS_BAD
```

## Socket.IO frame primer

cor3.gg uses Socket.IO v4 over WebSocket. Frames the extension cares about:

```
42[<eventName>, <payload>]    ← named event, JSON-encoded
40                             ← Socket.IO connect
2 / 3                          ← engine.io ping / pong
```

The interceptor only parses `42` frames. See
[`src/shared/ws-frames.js`](../src/shared/ws-frames.js).

Game events to listen on (in order of frequency):

| eventName | Action(s) | Module that consumes |
|---|---|---|
| `expeditions` | `get.active`, `get.config`, `get.mercenaries`, `get.archived`, `configure`, `launch`, `open.container`, `collect.all`, `respond.event`, `update` | `data/expeditions.js`, `data/decisions.js`, `data/mercenaries.js`, `data/merc-config.js`, `data/expedition-config.js`, `auto-send-merc.js` |
| `market` | `get.jobs`, `job.take`, `job.complete` (or `job.completed`), `job.dismiss` | `data/market.js`, `data/dark-market.js`, `data/srm-market.js`, `data/usol-market.js`, `auto-jobs.js` |
| `stash` | (room-based push) | `data/stash.js` |
| `network-map` | `set.endpoint`, `get.map`, `scan.server` | `data/{dark,srm,usol}-market.js` (unreachable detection); interceptor `computeNmGraph` → `NM_GRAPH`; the bridge + SAI flows connect via `__cor3SetEndpoint` (`set.endpoint`) |
| `sai` | `get.login.status`, `login.with-access`, `hack.start` | the bridge SAI access (`saiAccess`): `__cor3SaiGetLoginStatus` (one-shot promise), `__cor3SaiLoginWithAccess`, `__cor3SaiHackStart`. Interceptor routes `get.login.status` to the one-shot and surfaces the `login.with-access` verdict on `MSG.JOB.LOG` |
| `desktop` | `get.options`, `open.folder`, `open.file`, `get.file.analysis`, `update.file` | interceptor → `MSG.WS.DESKTOP_OPTIONS`/`_FOLDER`/`_FILE` (+ caches `__cor3DownloadFolderId`). the file-decryption flow finds the file via `open.folder` and opens it via `open.file` — the latter bypasses the new `get.file.analysis` info window (`FileAnalysisProtocolApplication`) that a DOM double-click now opens |
| `minigames` | `start.minigame` (+ `open`/`finish`/`get.state`) | interceptor caches the launched game's meta in `__cor3LastMinigame` (notably `timerDurationMs`); the minigame itself runs on a separate Colyseus server (`svc-corie.cor3.gg/games/<room>`) |
| `error` | `token-expired` | `auto-jobs.js`, interceptor close-and-retry logic |
