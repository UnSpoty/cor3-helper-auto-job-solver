# CLAUDE.md

Quick orientation for an AI assistant entering this codebase. Detailed
references live in `docs/`.

## TL;DR

COR3 Helper is a Chrome MV3 (and Firefox-compatible) extension for the
[cor3.gg](https://cor3.gg) game. Modular architecture, ~85 files in `src/`.
Every feature is a `COR3.Module` registered with `COR3.Registry`. Five
execution contexts share a global `window.COR3.*` namespace via classic
IIFE-loaded scripts. No build step.

## Auto Jobs subsystem

The **Auto Jobs** tab accepts + completes market jobs end to end. Code lives in
[src/ui/sections/auto-jobs/](src/ui/sections/auto-jobs/) (UI) and
[src/modules/automation/auto-jobs.js](src/modules/automation/auto-jobs.js)
+ [src/modules/automation/auto-jobs/pipeline.js](src/modules/automation/auto-jobs/pipeline.js)
(logic), with a MAIN-world bridge at
[src/modules/game/auto-jobs-bridge.js](src/modules/game/auto-jobs-bridge.js).
It uses the isolated storage key `STORAGE_SYNC.AUTOJOBS_SETTINGS`. The logic
namespace is `COR3.autoJobs.*`; the popup UI registers under
`COR3.uiComponents.*`.

**Architecture:** ONE registered `COR3.Module` (`auto-jobs`, the
orchestrator) owns START/STOP and runs an infinite loop; the pipeline "modules"
are plain stage objects under `COR3.autoJobs.pipeline.stages.*`, each with a
uniform `async run(packet, ctx) -> packet` contract. A single growing **packet**
envelope flows stage→stage. Flowchart node ids live in `constants.AJ.NODE`
(shared between orchestrator execution and the compact pipeline status readout
in [src/ui/sections/auto-jobs/flow-map.js](src/ui/sections/auto-jobs/flow-map.js)
— the old SVG Flow Map was dropped); live progress is published to
`STORAGE_LOCAL.AJ_PIPELINE_STATE`. See
[docs/pipelines.md → Auto Jobs](docs/pipelines.md) for the full loop diagram.

**Planning + acceptance half (isolated world):** `GET_SERVERS → CHECK_ACCESS →
UPDATE_MARKETS → JOB_QUEUE → QUEUE:EMPTY? → HAVE_TASKS_IN_PROGRESS? → BUGGED? →
JOB:SKIP → CHECK_CONDITION → JOB_ACCEPTION`. CHECK_ACCESS also computes graph
**path reachability** (`computePathReachability`: BFS from HOME over
`NM_GRAPH.connections`; a maintenance node can be a path's endpoint but never
a transit hop, so a K/D'd hub cuts off everything behind it → those servers
get `noPath` — a hard data skip + flow postpone, same class as K/D).
UPDATE_MARKETS skips a remote market outright when its own server
(`C.MARKETS[].serverId`) has `noPath` (`reason:'no-path'` — the refresh probe
could only fail; self-heals next cycle), then reads the
market envelope's `jobs[]` (status `AVAILABLE`) and the `recentJobs[]` entries
tagged `TAKEN` (= in-progress) + `FAILED` (= failed, surfaced on the Job List
and cleared by the auto-dismiss step / manual ✕); JOB_ACCEPTION accepts via the
generic `MSG.GAME.ACCEPT_JOB` + `REVERT_ENDPOINT_TO_HOME`. Acceptance is
**sequential, one server at a time** (mirrors `_selectBatch` execution): it
HOLDS — accepts nothing — while any *workable* TAKEN wired job is still in flight
(`!bugged && pipeline.jobServerReachable`, the same predicate `_runJobFlows`
uses, so an un-workable TAKEN job on a K/D / no-path / inaccessible server
can't stall acceptance); else it accepts every eligible `file_decryption` across all markets
(absolute priority, no target server); else ONE server's group of eligible SAI
jobs (busiest `conditions.serverConfigId`). After JOB_QUEUE the orchestrator completes any `canComplete`
TAKEN job and — iff `AJ_MASTER_SWITCHES.behaviour.autoDismissFailed` is on
(default OFF) — `market.job.dismiss` (`MSG.GAME.DISMISS_JOB`)-es every FAILED
job. The orchestrator also owns persisting `NM_GRAPH` (it subscribes to
`MSG.GAME.NM_GRAPH`, fires an initial `REQUEST_NM_MAP`, re-requests on a long
timer while idle, and relays the popup's `rescanNetworkMap` action).

**JOB_FLOW (MAIN world):** the orchestrator dispatches each in-progress (TAKEN)
job to a MAIN flow module via `MSG.AUTOJOBS.FLOW_START` and parks on
`FLOW_RESULT` (so the loop pauses for the minigame). An impossible job is
written to `AJ_BUGGED_JOBS` (MARK_AS_BUGGED); a transient failure is retried
once then bugged; completion uses `MSG.GAME.COMPLETE_JOB`. Flow modules live in
[src/modules/game/flows/auto-jobs/](src/modules/game/flows/auto-jobs/) (ids
`flow-*`):
  - **`file_decryption`** (`flows/auto-jobs/file-decryption.js`, id
    `flow-file-decryption`): reads the file format, uses the **power-aware**
    headless loadout API `COR3.game.loadout.ensureDecrypt(ext, requiredPower)`
    (install/swap owned software — and max out hardware — to clear the file's
    CRYPT RATE, or bug-out: `none`/`underpower` are non-retryable). `requiredPower`
    is the decrypt condition's `encryptionLevel` upper bound (`hi`), supplied on
    the FLOW_START payload by the orchestrator
    (`pipeline.requiredPowerForDecrypt`). Then finds + opens the file **purely
    over WS** (no DOM scrape): `__cor3DesktopOpenFolder` (Downloads) → match
    `files[]` by name/ext → `__cor3DesktopOpenFile(fileId)`. The raw `open.file`
    is REQUIRED:
    a cor3.gg update made a DOM double-click open a "File Analysis" info window
    (`desktop.get.file.analysis` → `FileAnalysisProtocolApplication`) instead of
    the minigame; WS `open.file` starts the minigame directly. The standalone
    solvers then win and `job.complete` is sent.
  - **SAI job types** (ip_injection/ip_cleanup, file_elimination,
    log_deletion/log_download, data_download/data_upload, decrypt_extract) share
    a base factory in `flows/auto-jobs/_sai-flow.js`: connect +
    Active-Access/hack login, then the get.*/mutate.* WS loop, then
    `job.complete`. The base also exposes shared file-name resolution helpers
    (`resolveFile`/`parseExt`/`stemOf`/`normExt` + `listDownloads`, on both `h.*`
    and `COR3.autoJobs.saiFlow`): cor3.gg names the SAME file three ways — the
    condition NAME, the server `get.files` NAME, and the local Downloads NAME all
    differ — so the file flows match by **fileId → exact name → stem** (text
    before the first dot), never exact-name only. The orchestrator hands the
    file SAI flows the `{id,name,ext}` descriptors (`fileDescriptorsForJob`);
    `decrypt_extract` also carries `requiredPower` and decrypts by the local
    file's REAL extension; `data_upload` defaults `sizeMb` to 1 when the Downloads
    object omits it (the post-patch `open.folder` file no longer carries
    `sizeMb`).

The bridge drives the Network-Map context-menu Open SAI / Open Market actions
**without DOM coordinate clicks**: it opens the Network Map / SAI windows via
the game's own React handlers (`COR3.game.desktop`, see
`src/modules/game/desktop-window.js`) and navigates by direct WS request —
Connect = `__cor3SetEndpoint` (`network-map.set.endpoint`). Open SAI gains
access via `saiAccess()`: `__cor3SaiGetLoginStatus` reads `activeAccesses[]` +
`hackTools[]`; with an **Active Access** grant it `__cor3SaiLoginWithAccess`
(no password/passhack); with **no grant** it HACKS the server —
`COR3.game.loadout.ensureHack(serverType, serverDefenceRate)` runs the **loadout
optimizer** — it exhaustively searches owned software × CPU × GPU × RAM × PSU over
the verified power model and applies the OPTIMAL combination (fewest swaps that
clears the defence rate; correctly reports `underpower` only when no combo can),
clicks the hack-tool row (mounts the minigame), the standalone solver wins, and
the freshly-granted access logs in. The only residual screen interaction is
selecting a server node (the SVG map exposes no callable selection handler) —
one targeted pointer tap on the located tile.

**Master Switches + eligibility sync.** A collapsible "Master Switches" panel
(`src/ui/sections/auto-jobs/master-switches.js`) above the Network Map holds
global market + job-type toggles (default ON, absent === on) plus a `behaviour`
group whose `autoDismissFailed` toggle (default OFF, absent === off) gates the
orchestrator's auto-dismiss of FAILED jobs, all in
`STORAGE_LOCAL.AJ_MASTER_SWITCHES`. The
CONFIG part of a job's eligibility (markets/types/server-overrides) lives in ONE
shared evaluator `COR3.ajEligibility.configSkipReason`
(`src/shared/aj-eligibility.js`, loaded in the isolated world AND the popup).
CHECK_CONDITION uses it for acceptance and stamps the DATA-only part
(`dataSkipReason`) onto each job; the Job List + Network Map re-derive the config
part live so toggling a switch / server-skip reflects instantly (no cycle wait).

**Design principles:**

1. **No fallbacks. No defensive defaults. No silent degradation.** If the
   pipeline needs a piece of state, declare it as a hard requirement. Never
   write `value || defaultValue`, `try { … } catch (_) {}` to mask missing
   things, or `if (!x) return` to silently skip work. If a precondition fails,
   throw or log loudly. The behaviour must be exact and auditable — the reader
   should see the one path it takes, not a tree of "in case X is missing"
   branches.
2. **Shared game state is read-only.** The only shared inputs are pure game
   state: `NM_GRAPH` and the four market envelopes
   (`MARKET`/`DARK_MARKET`/`SRM_MARKET`/`USOL_MARKET`). The subsystem owns its own keys
   (`AJ_PIPELINE_STATE`, `AJ_JOB_QUEUE`, `AJ_BUGGED_JOBS`, `AJ_SERVER_OVERRIDES`,
   `AJ_MASTER_SWITCHES`) + `AUTOJOBS_SETTINGS`, and its own message actions
   (`MSG.AUTOJOBS.*`).
3. **Logger module ids are `auto-jobs`** (orchestrator + pipeline) **and
   `flow-*`** (the MAIN flow modules). The Activity Log + Download Log filter
   to these ids.

## Documentation map

Read these in order when ramping up:

| Doc | What's in it |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Execution contexts, boot order, module lifecycle, cross-world topology |
| [docs/module-spec.md](docs/module-spec.md) | Module contract; templates for each kind of module (data / automation / game / flow / solver / appearance / UI section) |
| [docs/messaging.md](docs/messaging.md) | Exhaustive enum of MSG / STORAGE_LOCAL / STORAGE_SYNC / FLOW / CATEGORY / LIMITS with payload shapes and producer/consumer mapping |
| [docs/pipelines.md](docs/pipelines.md) | Diagrams of the **Auto Jobs** orchestrator+stages pipeline, auto-send-merc, auto-choose-decision, daily-ops fetch, alarms, auto-refresh, Logger |
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
    ├── shared/           platform, constants, build-info, dom, ws-frames,
    │                      errors, i18n, i18n-bridge
    ├── interceptors/     ws-interceptor, http-interceptor, solver-loader
    ├── modules/
    │   ├── data/         13 modules — one per WS payload (auth, expeditions,
    │   │                  archived-expeditions, decisions, market, dark-market,
    │   │                  srm-market, usol-market, stash, loadout, mercenaries,
    │   │                  merc-config, expedition-config) — `mercenaries` now
    │   │                  stores a per-market map (MERC_MARKETS) keyed by market
    │   │                  id, mirroring ONLY the HOME market into MERCENARIES
    │   ├── automation/   10 modules — timers, auto-refresh, auto-send-merc,
    │   │                  auto-choose-decision, auto-decrypt, auto-ice-wall,
    │   │                  auto-simple-decrypt, daily-ops, auto-jobs,
    │   │                  runtime-bridge — plus auto-jobs/pipeline.js (the
    │   │                  Auto Jobs pipeline stages — namespace
    │   │                  COR3.autoJobs.pipeline.*, not a Registry-registered
    │   │                  module)
    │   ├── game/         desktop-window, auto-jobs-bridge, loadout-panel,
    │   │                  flows/auto-jobs/ (9 Auto Jobs flow modules + _sai-flow base)
    │   ├── solvers/      decrypt, daily-ops, ice-wall, simple-decrypt
    │   └── appearance/   5 modules — 4 CSS/DOM toggles + loadout-widget.js
    │                      (LOADOUT-pill visibility bridge to MAIN)
    ├── ui/               popup.html + popup.css + shell.js + components/ + sections/
    └── entry/            content-early.js, content.js, background.js
```

## Quick orientation: where does feature X live?

| If you want to... | Look at |
|---|---|
| Change how WS frames are parsed | `src/shared/ws-frames.js` |
| Add a new game-data field to track | new file in `src/modules/data/` + entry in `MSG.WS.*` + entry in `STORAGE_LOCAL.*` |
| Reference a market / faction id (home/dark/srm/usol) | `C.MARKETS` in `src/shared/constants.js` (single source of truth: `{id, serverId, key, label}[]` + `C.HOME_MARKET_ID` / `C.HOME_SERVER_ID`) — never hardcode the ids |
| Tweak Auto Jobs scheduling / loop | `src/modules/automation/auto-jobs.js` (orchestrator) + `src/modules/automation/auto-jobs/pipeline.js` (stages) |
| Add a new job type | pipeline.js `detectJobType` + condition parsing; new `flow-*` module in `src/modules/game/flows/auto-jobs/`; wire it into the orchestrator's JOB_FLOW batch dispatch |
| Adjust the SAI access / navigation | `src/modules/game/auto-jobs-bridge.js` (`saiAccess()` login) + `src/modules/game/flows/auto-jobs/_sai-flow.js` (SAI flow base); WS helpers `__cor3Sai*` in `src/interceptors/ws-interceptor.js` |
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

- Auto Jobs: a single orchestrator module runs an infinite loop over the
  pipeline stages, passing one packet stage→stage; per-cycle it refreshes
  markets, rebuilds the job board, accepts eligible jobs, and dispatches a
  batch of in-progress (TAKEN) jobs to MAIN flow modules (parking on each
  FLOW_RESULT). Impossible jobs go to the `AJ_BUGGED_JOBS` registry (no TTL —
  cleared by the user); transient failures retry once then bug.
- Acceptance + execution are **sequential, one server at a time**: JOB_ACCEPTION
  holds (accepts nothing) while a server's batch is still in flight, then accepts
  either all eligible `file_decryption` (no server, absolute priority) or ONE
  server's group of SAI jobs; JOB_FLOW (`_selectBatch`) works that same one
  server per cycle behind a single SAI login. Both sides share
  `pipeline.jobServerReachable` to decide "workable this cycle", so a TAKEN job
  stuck on a K/D / no-path (route cut by a maintenance transit node) /
  inaccessible server is postponed (never bugged) **and** never
  blocks acceptance of other servers.
- 9 job flow types (in `src/modules/game/flows/auto-jobs/`): file_decryption,
  ip_injection, ip_cleanup, data_upload, log_deletion, log_download,
  file_elimination, data_download, decrypt_extract. Classification is by
  localised-name keywords EXCEPT known canonical WS codes
  (`pipeline.WS_JOB_TYPE_OVERRIDES`): a job NAMED "Data download" with raw
  `jobType:'DecryptDownloadedFile'` (a real cor3.gg mislabel) is rerouted to
  `decrypt_extract` — its completion needs the downloaded file decrypted,
  which the plain data_download flow never does.
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
- `loadout-panel` — site-embedded UI: pill anchored next to cor3.gg's
  Notifications widget (via Sentry data-attr, language-independent).
  **Hidden by default** — injected only while the Overview "Show LOADOUT
  widget" toggle (`STORAGE_SYNC.SHOW_LOADOUT_WIDGET`) is ON, bridged from
  storage by the isolated `appearance-loadout-widget` module over
  `MSG.UI.SHOW_LOADOUT_WIDGET` (the headless `COR3.game.loadout` API works
  regardless of widget visibility).
  Opening it auto-powers the system off (`localStorage["loadout-powered"]`
  client-side flag, restored on close — toggleable via AUTO mini-pill),
  then renders equipped/owned hardware + software (each software card shows
  one "TYPE · power · targets" capability line — power is computed/max when
  equipped else the spec's min–max band), resources usage bars with hover-delta
  preview when picking alternatives, and a dynamically discovered capability list
  (DECRYPT/HACK/SEARCH targets — file extensions or server types — coloured
  green=active / grey=available). Each capability target is **clickable** → a
  chooser overlay listing every owned software that provides that exact target
  (callsign/tier/power band); clicking a row equips/unequips it.
  Mutations (equip/unequip software, swap hardware) go via plain WS
  RPCs in src/interceptors/ws-interceptor.js (`__cor3Loadout*` helpers
  — `loadout/equip.software`, `unequip.software`, `equip.hardware`,
  all with options.compress=true). Pre-flight floor-check on install +
  snapshot-diff watchdog + in-panel toast notifications surface
  resource conflicts and silent server rejections.
- `flow-file-decryption`, `flow-ip-injection`, `flow-ip-cleanup`,
  `flow-data-upload`, `flow-log-deletion`, `flow-log-download`,
  `flow-file-elimination`, `flow-data-download`, `flow-decrypt-extract` —
  the Auto Jobs MAIN flow modules (in `src/modules/game/flows/auto-jobs/`).
  Each listens on `MSG.AUTOJOBS.FLOW_START` for its job type and replies
  `FLOW_RESULT`; logs under its own `flow-*` id (the Activity Log filters to
  `auto-jobs` + `flow-*`). The SAI types share the `_sai-flow.js` base factory.
- `solver-decrypt`, `solver-daily-ops`, `solver-ice-wall`,
  `solver-simple-decrypt`
- `desktop-window.js` — MAIN-world `COR3.game.desktop` namespace (NOT a
  registered Module). Opens cor3.gg desktop windows by invoking the dock
  launcher's React `onClick` off the fiber (`openApp` / `openAppAndWait`, no
  MouseEvent — there is NO WS request to open a window), plus
  `invokeReactClick` / `findClickableByText` (click a list row by text —
  SAI access grants / hack tools) / `findServerTile` / `selectServerTile` (one
  targeted pointer tap — the map has no callable selection handler) /
  `findPanelButton` / `waitFor`. Used by the bridge.
- `auto-jobs-bridge.js` — MAIN-world endpoint for the Network-Map context
  menu (Open SAI / Open Market). NOT a registered Module — a plain IIFE
  listening on `MSG.AUTOJOBS.OPEN_SAI` / `OPEN_MARKET` (payload carries
  `serverName` + `serverId` + `serverType`). Drives the flows through client
  functions + direct WS instead of DOM coordinate clicks: `COR3.game.desktop`
  to open windows, `__cor3SetEndpoint` (WS `network-map.set.endpoint`) to
  Connect. Its `saiAccess()` orchestrator then logs in via **Active Access**
  (`__cor3SaiGetLoginStatus` → `__cor3SaiLoginWithAccess`) or, with no grant,
  **hacks** the server (`COR3.game.loadout.ensureHack` → click the hack-tool
  row → solver wins the minigame → use the granted access). Logs under id
  `auto-jobs`. `loadout-panel` also exposes a headless `COR3.game.loadout`
  API — `planDecrypt`/`ensureDecrypt(ext, requiredPower)` (DECRYPT, matched by
  `fileTypes`) and `planHack`/`ensureHack(serverType, requiredPower)` (HACK,
  matched by `serverTypes`; `requiredPower` = `serverDefenceRate` from `sai
  get.login.status`). Both are thin wrappers over ONE shared **loadout optimizer**
  (`_optimize`/`_planCapability`/`_applyOptimized`) built on the verified-live
  power model: `computedPower = floor(pmin + ratio·(pmax−pmin))`, `ratio =
  min` over the software's `consuming` resources of `clamp01((supply−lo)/(hi−lo))`
  (2-elt band `[lo,hi]`, 3-elt `[floor,lo,hi]`; supply from ONE hardware slot),
  PSU gates feasibility only (`Σ cpuConsuming+gpuConsuming ≤ psuPower`). The
  optimizer **exhaustively searches owned software × cpu × gpu × ram × psu** and
  applies the OPTIMAL combination (cost = fewest swaps → lowest tier → lowest
  vulnerability → most power), then verifies the live power. `_applyHwConfig`
  applies the MINIMAL equip sequence (lower-draw-first CPU/GPU order, PSU headroom
  inserted only when a transition would over-draw — the server rejects over-draw
  equips). Plan statuses `ready`/`install`/`swap`/`underpower`/`none`/`unknown`;
  ensure resolves `{ok:true, status:'ready'|'applied', power}` or `{ok:false,
  status:'none'|'underpower'|'unknown'|'no-helper'|'apply-incomplete', transient}`
  — the `transient` flag is the retry verdict the flows act on: `false`
  (`none`/`underpower`) is PERMANENT (the flow bugs the job), `true`
  (`unknown`/`no-helper`/`apply-incomplete`) retries next cycle.
  See `reference_hack_power_model` / `reference_decrypt_power_model`.

**Isolated content_scripts:**
- `auth`, `expeditions`, `archived-expeditions`, `decisions`, `market`,
  `dark-market`, `srm-market`, `usol-market`, `stash`, `loadout`,
  `mercenaries`, `merc-config`, `expedition-config` — data
- `timers`, `auto-refresh`, `auto-send-merc`, `auto-choose-decision`,
  `auto-decrypt`, `auto-ice-wall`, `auto-simple-decrypt`, `daily-ops`,
  `auto-jobs`, `runtime-bridge` — automation
- `appearance-system-messages`, `appearance-background`,
  `appearance-network-fog`, `appearance-map-fx`,
  `appearance-loadout-widget` (bridges the Overview "Show LOADOUT widget"
  toggle `STORAGE_SYNC.SHOW_LOADOUT_WIDGET`, default OFF, to MAIN over
  `MSG.UI.SHOW_LOADOUT_WIDGET`) — appearance

Plus synthetic ID `bus` (used by Logger to record traced bus traffic) and
`registry` (used by Registry's own warn/error logs). The Auto Jobs pipeline
stages (`COR3.autoJobs.pipeline.stages.*`) are plain objects, NOT registered
modules — the `auto-jobs` orchestrator drives them directly.
