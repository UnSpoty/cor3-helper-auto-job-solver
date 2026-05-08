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
timer. While active the server is unreachable. In DOM:
`MaintenanceTimer` containing a `TimerIcon` SVG = K/D. A `MaintenanceTimer`
without the icon (text-only) is a regular cooldown — server is still
reachable. Auto-jobs blacklists K/D servers for the timer duration + 5 min
buffer (see `parseKDTimerMs`).

**Home Market** — the player's market. Market id
`019d3ea4-85bd-7389-904d-8f7c85841134`.

**Dark Market (D4RK)** — secondary market accessible only by setting the
WS endpoint to a specific server (`019d29c5-4b37-79bf-b23e-304d8ea03c15`).
Market id `019d3ea4-85bd-7389-904d-908ba9194aa0`. May be unreachable
(no-path-to-server) — `darkMarketAvailable` flag tracks this.

**Job** — a task on the market. Has a `name`, `category`, `relatedServers`
(IDs of servers needed to complete it), and `conditions` (the params:
file names, IPs, log seqs, etc.). Statuses: `AVAILABLE`, `TAKEN`, `COMPLETED`.

**Job type** — derived from job name keywords. We support 9 types — see
[messaging.md → FLOW](messaging.md#flow--job-type-identifiers).

**SAI (Server Administration Interface)** — the in-game window that opens
after Login. Has tabs for Logs, Files, Transit Access. Each tab has a
scroll container, an Add button, etc.

**Active Access** — login method panel that appears between Login click
and SAI open. Has rows of pre-cached credentials; clicking the first one
auto-fills credentials and opens the SAI.

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

**LIMITS** — tunables (TTLs, ring sizes).

**Bus** — cross-context message bus (`Bus.window` for postMessage,
`Bus.runtime` for chrome.runtime).

**Store** — chrome.storage facade.

**MAIN world** — page's JS realm. Has `window`, `WebSocket`, page DOM.
No `chrome.*`.

**Isolated world** — extension's content-script realm. Has `chrome.*` and
its own copy of the page DOM. Cannot see MAIN-world `window` properties
directly, but can post messages to it via `window.postMessage`.

## DOM selectors of note

| Selector | What it identifies |
|---|---|
| `[data-sentry-component="ServerItem"]` | one tile in the Network Map |
| `[data-sentry-element="ServerItemNameStyled"] span` | server name text |
| `[data-sentry-component="MaintenanceTimer"]` | K/D or cooldown timer on a server tile |
| `[data-sentry-component="TimerIcon"]` (child of MaintenanceTimer) | confirms K/D (vs cooldown) |
| `[data-sentry-component="HomeServerIcon"]` | marks the home server tile (skipped in scrape) |
| `[data-sentry-component="ConnectIcon"]` | Connect button in side panel |
| `[data-sentry-component="LoginIcon"]` | Login button in side panel |
| `[data-sentry-element="SaiBottomPanelStyled"][data-sentry-source-file="sai-login.tsx"]` | login method dialog |
| `[data-sentry-component="SaiActiveAccess"]` | Active Access list inside login dialog |
| `[data-sentry-component="ArrowRightIcon"]` (inside SaiActiveAccess) | arrow on each Active Access row — wait on this to ride the React mount race |
| `[data-sentry-component="ServerAdministrationInterfaceApplication"]` | SAI window (one per connected server) |
| `[data-sentry-element="SaiHeaderTitleStyled"]` | SAI title (matches server name) |
| `[data-sentry-element="SaiTabStyled"]` | individual SAI tab button (Logs/Files/Transit) |
| `[data-sentry-component="SaiLogs"]` / `SaiFiles` / `SaiTransit` | SAI tab content |
| `[data-sentry-element="SaiScrollContainerStyled"]` | scroll viewport inside any SAI tab — **re-query after mutations** |
| `[data-sentry-component="LogIcon"]` / `FileIcon` | per-row icons in Logs/Files |
| `[data-sentry-component="TrashIcon"]` / `DownloadIcon` | row action icons |
| `[data-sentry-element="SaiAddButtonStyled"]` | Add button in any SAI tab |
| `[data-sentry-component="SaiAddIpModal"]` | Add-IP dialog overlay |
| `[data-sentry-element="SaiModalInputStyled"]` | input in Add-IP dialog |
| `[data-sentry-element="SaiModalButtonStyled"]` | dialog button(s) |
| `[data-sentry-element="SaiDeleteModalStyled"]` | delete-confirm overlay |
| `[data-sentry-element="SaiDeleteConfirmButtonStyled"]` | delete-confirm button |
| `[data-component-name="FolderApplication"]` | Downloads folder window (desktop app) |
| `.folder-application[data-app-id]` | individual file in Downloads folder |
| `[data-sentry-component="Shortcut"]` | desktop shortcut (e.g. Downloads icon) |
| `[data-sentry-component="NotificationIcon"]` | "NEW" badge on freshly-downloaded files |
| `[data-sentry-component="FilePickerGrid"]` | Add-file picker (during upload flow) |
| `[data-sentry-element="FilePickerGridStyled"]` | inner grid |
| `.file-picker-name` | file name inside picker grid |
| `[data-sentry-element="FilePickerAttachButtonStyled"]` | Upload submit button |
| `[data-sentry-element="LogContentStyled"][data-sentry-source-file="config-hack-application.tsx"]` | the decrypt minigame container |
| `.pulse-timeline` / `.pulse-group` / `.pulse-bar` | Signal Hack puzzle DOM |
| `.log-entries` (or variants) / `.log-entry` | System Log Integrity puzzle |
| `.confirm-button` / `.error-type-button` / `.fix-error-button` / `.error-analysis-block` | log-integrity solver UI |
| `[data-component-name="TabBarItem-NETWORK_MAP"]` | taskbar shortcut to open NM |
| `[data-component-name="JobCard"]` | a job card on the market |
| `[data-component-name="MarketNav"]` | market window's tab bar |
| `[data-sentry-component="MarketIcon"]` | Market button in server side panel |
| `[data-sentry-component="CloseApp"]` | × button on any app window (locked while pipeline active) |
| `[data-sentry-component="Application"]` / `[data-sentry-component="ApplicationWidget"]` | wrapper around any app window |
| `[data-sentry-component="NetworkMapApplication"]` | the NM window itself |

## Solver-specific maps

`solver-decrypt` (config-hack):
- 4 fields × N options each (e.g. `[[v1.0,v1.1,v2.0],[GET,PUT,POST],…]`)
- Submits guesses; reads `Mismatched <n>` from the log
- Uses minimax with memoization; cached solver state for the standard
  4-field layout

`solver-daily-hack`:
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
| `market` | `get.options`, `job.take`, `job.complete` (or `job.completed`) | `data/market.js`, `data/dark-market.js`, `auto-jobs.js` |
| `stash` | (room-based push) | `data/stash.js` |
| `network-map` | `set.endpoint` | `data/dark-market.js` (unreachable detection) |
| `error` | `token-expired` | `auto-jobs.js`, interceptor close-and-retry logic |
