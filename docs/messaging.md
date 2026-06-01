# Messaging Reference

Exhaustive enumeration of every cross-context message type, storage key, and
flow identifier. The canonical source is
[`src/shared/constants.js`](../src/shared/constants.js); this document
explains each entry's payload shape, producer, and consumer(s).

> **Convention:** message types live in `MSG.<group>.<name>`. Storage keys
> live in `STORAGE_LOCAL.<NAME>` and `STORAGE_SYNC.<NAME>`. Job flow type
> identifiers live in `FLOW.<NAME>`.

---

## MSG.WS — Game data relayed from WS interceptor

Direction: **MAIN → isolated**. Producer: `src/interceptors/ws-interceptor.js`.
Consumers: `src/modules/data/*` (writes to storage), various automation
modules (auto-jobs, auto-send-merc).

| Constant | Wire string | Payload | Notes |
|---|---|---|---|
| `WS.EXPEDITIONS` | `COR3_WS_EXPEDITIONS` | `{ expeditions: Expedition[] }` | full expedition list. Empty array used to clear pending decisions on launch. |
| `WS.DECISIONS` | `COR3_WS_DECISIONS` | `{ decisions: Decision[] }` | derived from `expeditions[].messages[].decisionOptions`. |
| `WS.MARKET` | `COR3_WS_MARKET` | `{ market: { marketId, jobs: Job[], recentJobs: Job[], nextJobsResetAt } }` | home market only (id `019d3ea4-…-8f7c85841134`). Built from the response to `market.get.jobs`. |
| `WS.DARK_MARKET` | `COR3_WS_DARK_MARKET` | `{ market: same shape }` | dark market (id `019d3ea4-…-908ba9194aa0`). |
| `WS.DARK_MARKET_UNREACHABLE` | `COR3_WS_DARK_MARKET_UNREACHABLE` | `{ error, serverId }` | emitted when `network-map.set.endpoint` returns `no-path-to-server`. Sets `darkMarketAvailable=false`; also sets `window.__serverPathFailed = Date.now()` for connect-step fast-fail. |
| `WS.STASH` | `COR3_WS_STASH` | `{ stash: { items, currentUsage, maxCapacity } }` | inventory snapshot. |
| `WS.MERCENARIES` | `COR3_WS_MERCENARIES` | `{ data: { mercenaries: Merc[] } | Merc[] }` | array OR `{mercenaries: [...]}` shape — handle both. |
| `WS.MERC_CONFIGURE` | `COR3_WS_MERC_CONFIGURE` | `{ mercenaryId, data: { totalCost, riskScore, … } }` | per-merc cost/risk. Multiple events for one fetch (one per merc). |
| `WS.EXPEDITION_CONFIG` | `COR3_WS_EXPEDITION_CONFIG` | `{ data: { locations: [...] } }` | location/zone/objective IDs. Cached so launch can build the right config. |
| `WS.JOB_ACCEPTED` | `COR3_WS_JOB_ACCEPTED` | `{ data: { recentJobs: Job[] }, error: Error \| null }` | response to `COR3_ACCEPT_JOB`. `error.message` may indicate failure. |
| `WS.JOB_COMPLETED` | `COR3_WS_JOB_COMPLETED` | `{ data, error }` | response to `COR3_COMPLETE_JOB`. |
| `WS.CONTAINER_OPENED` | `COR3_WS_CONTAINER_OPENED` | `{ data: { items \| containerItems: [...] } }` | reward container content count drives the stash-space check. |
| `WS.COLLECTED_ALL` | `COR3_WS_COLLECTED_ALL` | `{ data }` | rewards moved into stash. Auto-send proceeds to mercenary fetch. |
| `WS.EXPEDITION_LAUNCHED` | `COR3_WS_EXPEDITION_LAUNCHED` | `{ data }` | success. |
| `WS.EXPEDITION_LAUNCH_ERROR` | `COR3_WS_EXPEDITION_LAUNCH_ERROR` | `{ error: 'Maximum 1 active expedition allowed', retryAfter: 120000 }` | auto-send schedules a relaunch via `WS.EXPEDITION_RETRY_LAUNCH`. |
| `WS.EXPEDITION_RETRY_LAUNCH` | `COR3_WS_EXPEDITION_RETRY_LAUNCH` | `{ retryData: requestId }` | fired by the WS interceptor 2 min after a launch error; auto-send-merc relays it as `COR3_RELAUNCH_EXPEDITION`. |
| `WS.INSUFFICIENT_CREDITS` | `COR3_WS_INSUFFICIENT_CREDITS` | `{ error: 'insufficient-credits' }` | auto-send disables itself with `disabledReason: 'insufficient_credits'`. |
| `WS.LOG` | `COR3_WS_LOG` | `{ direction: 'sent'\|'received', message: string }` | **deprecated** — superseded by Logger; not currently consumed. Safe to remove later. |

### Off-enum WS-related types still used

These exist in code but predate the `MSG.*` enum. Treat them as if they were
in `MSG.WS`:

- `COR3_WS_STASH_FULL` — `{ error, requestId }`. Auto-send disables on this.
- `COR3_WS_ENDPOINT_RESULT` — `{ success, data }`. Internal.
- `MSG.WS.ARCHIVED_EXPEDITIONS` (`COR3_WS_ARCHIVED_EXPEDITIONS`) — `{ expeditions }`. Owned by `archived-expeditions.js`; surfaced as the "Recent runs" block in the Expeditions UI.

---

## MSG.AUTH — Auth + version metadata

Direction: **MAIN → isolated**. Producer: `src/interceptors/http-interceptor.js`.
Consumer: `src/modules/data/auth.js`.

| Constant | Wire string | Payload | Source |
|---|---|---|---|
| `AUTH.BEARER_TOKEN` | `COR3_BEARER_TOKEN` | `{ token: 'Bearer …' }` | first observed `Authorization` header on cor3/corie URLs (fetch + XHR). |
| `AUTH.WEB_VERSION` | `COR3_WEB_VERSION` | `{ version: 'v1.17.21' }` | parsed from `translation.json?v=…` query param. Re-posted twice (3 s, 8 s) to ride out the isolated-world listener install delay. |
| `AUTH.SYSTEM_VERSION` | `COR3_SYSTEM_VERSION` | `{ version }` | from `api/users/me` response body. |
| `AUTH.DAILY_REWARDS` | `COR3_DAILY_REWARDS` | `{ rewards: [...] }` | from `api/user-daily-claim/rewards`. |
| `AUTH.TOKEN_EXPIRED` | `COR3_TOKEN_EXPIRED` | `null` | game emitted `error: 'token-expired'` over WS; interceptor closed all sockets, queued retry ops. |

---

## MSG.GAME — Game-control commands

Direction: **isolated → MAIN** (and one inverse). The MAIN-world WS interceptor
listens for these and translates to outgoing WS frames or DOM clicks via
the game-module helpers.

| Constant | Wire string | Payload | What it does |
|---|---|---|---|
| `GAME.REQUEST_EXPEDITIONS` | `COR3_REQUEST_EXPEDITIONS` | `null` | join `expeditions` room and `get.active`. |
| `GAME.REFRESH_MARKET` | `COR3_REFRESH_MARKET` | `null` | re-send `market.get.options` for home market. |
| `GAME.REFRESH_DARK_MARKET` | `COR3_REFRESH_DARK_MARKET` | `null` | set endpoint to dark-market server, then `get.options`. |
| `GAME.LAUNCH_EXPEDITION` | `COR3_LAUNCH_EXPEDITION` | `{ config: {mercenaryId, marketId, locationConfigId, zoneConfigId, objectiveId, hasInsurance} }` | `expeditions.configure` then `expeditions.launch`. |
| `GAME.OPEN_CONTAINER` | `COR3_OPEN_CONTAINER` | `{ expeditionId }` | `expeditions.open.container`. |
| `GAME.COLLECT_ALL` | `COR3_COLLECT_ALL` | `{ expeditionId }` | `expeditions.collect.all`. |
| `GAME.ACCEPT_JOB` | `COR3_ACCEPT_JOB` | `{ jobId, marketId }` | `market.job.take` (endpoint-preflight in the interceptor). |
| `GAME.COMPLETE_JOB` | `COR3_COMPLETE_JOB` | `{ jobId, marketId }` | `market.job.complete`. Sent by the Auto Jobs flow modules after a job's minigame finishes. |
| `GAME.RESPOND_DECISION` | `COR3_RESPOND_DECISION` | `{ expeditionId, messageId, selectedOption }` | `expeditions.respond.event`. |
| `GAME.REFRESH_DARK_MARKET` / `GAME.REFRESH_SRM_MARKET` | `COR3_REFRESH_DARK_MARKET` / `COR3_REFRESH_SRM_MARKET` | `null` | set endpoint to the dark / SRM7-M server, then `get.options`. Used by auto-refresh and Auto Jobs's UPDATE_MARKETS. |
| `GAME.REQUEST_NM_MAP` | `COR3_REQUEST_NM_MAP` | `null` | request `network-map.get.map`; the interceptor replies `GAME.NM_GRAPH` (which the orchestrator persists to `STORAGE_LOCAL.NM_GRAPH`). |
| `GAME.NM_GRAPH` | `COR3_NM_GRAPH` | `{ home, currentEndpointId, servers:[…] }` | **inverse** — MAIN → isolated, the parsed BFS-depth graph. The Auto Jobs orchestrator subscribes and persists it. |
| `GAME.REQUEST_LOADOUT` | `COR3_REQUEST_LOADOUT` | `null` | join `loadout` room → server replies `loadout/get.options` (→ `STORAGE_LOCAL.LOADOUT`). |
| `GAME.RESCAN_NETWORK_MAP` | `rescanNetworkMap` | `null` | runtime action (popup → content). The orchestrator relays it to `REQUEST_NM_MAP`. The popup Network Map "Refresh" button fires it. |
| `GAME.REVERT_ENDPOINT_TO_HOME` | `COR3_REVERT_ENDPOINT_TO_HOME` | `null` | reset the NM endpoint back to HOME. Posted at the end of a bulk-accept batch (Auto Jobs's JOB_ACCEPTION) that may have left the endpoint on DARK/SRM. |

### Off-enum

- `COR3_REQUEST_STASH` — joins `stash` room (which triggers a stash push).
- `COR3_REQUEST_MARKET` — sends `market.get.options` for home.
- `COR3_REQUEST_DARK_MARKET` — sets dark endpoint then `get.options`.
- `COR3_REQUEST_MERCENARIES` — `expeditions.get.mercenaries`.
- `COR3_REQUEST_EXPEDITION_CONFIG` — `expeditions.get.config`.
- `MSG.GAME.REQUEST_ARCHIVED_EXPEDITIONS` (`COR3_REQUEST_ARCHIVED_EXPEDITIONS`) — re-fetch archived expedition list; popup's "Refresh" button on the Recent runs block triggers this via runtime-bridge.
- `COR3_LEAVE_STASH` — leaves the stash room.
- `COR3_SELL_ITEM` — `{itemId, quantity}` → `stash.sell.item`.
- `COR3_KEEP_ALIVE` — no-op marker the SW pings to keep the page-side socket awake.
- `COR3_RELAUNCH_EXPEDITION` — `{data}` — alias for `LAUNCH_EXPEDITION` with stored last config.

---

## MSG.SOLVER — Minigame solver lifecycle

Direction: bidirectional. `START_*` and `STOP_*` are isolated → MAIN; `DAILY_HACK_LOG` is MAIN → isolated.

| Constant | Wire string | Payload | What it does |
|---|---|---|---|
| `SOLVER.START_DECRYPT` | `COR3_START_DECRYPT_SOLVER` | `null` | starts the watcher in `solver-decrypt` (config-hack minigame). Idempotent. |
| `SOLVER.STOP_DECRYPT` | `COR3_STOP_DECRYPT_SOLVER` | `null` | sets `window.__solverAbort=true`. |
| `SOLVER.START_DAILY_OPS` | `COR3_START_DAILY_OPS` | `null` | one-shot trigger for `solver-daily-ops` (MAIN). Posted by `automation/daily-ops.js` when the popup sends `solveDailyOps`. The solver navigates Game Center → Daily Ops → Start, detects puzzle type (signal vs log), and submits. |
| `SOLVER.DAILY_OPS_LOG` | `COR3_DAILY_OPS_LOG` | `{ message }` | progress + result lines from `solver-daily-ops`. Mirrored into `STORAGE_LOCAL.DAILY_HACK_LOG` (storage key name preserved) so the Overview card can show the last line; success messages also retrigger a REST refetch so the streak/claimed badge flips without a Refresh click. |
| `SOLVER.START_ICE_WALL` | `COR3_START_ICE_WALL` | `null` | starts the watcher in `solver-ice-wall` (Porter-lite r4 minigame opened from SAI). |
| `SOLVER.STOP_ICE_WALL` | `COR3_STOP_ICE_WALL` | `null` | sets `window.__iceWallAbort=true`. |

---

## MSG.JOB — Game-core log channel

`MSG.JOB` is now a single channel: the interceptor's human-readable game-action
log, which the Auto Jobs bridge mirrors into the Activity Log.

| Constant | Wire string | Payload | Direction |
|---|---|---|---|
| `JOB.LOG` | `COR3_JOB_LOG` | `{ msg, level }` | MAIN → isolated. Posted by the WS interceptor (accept/complete RPCs, SAI login verdicts). The `auto-jobs-bridge` mirrors entries into the Activity Log while an Auto Jobs action runs. |

### Off-enum

- `COR3_JOB_MANAGER_READY` — MAIN → isolated, signals that flow modules booted.
- `COR3_FETCH_DAILY_OPS` — MAIN → isolated, fired by interceptor on WS open; daily-ops module fetches `svc-corie.cor3.gg/api/user-daily-claim`.
- `COR3_LOG_REMOTE` — MAIN → isolated, log-bridge envelope. `{ moduleId, entry: {ts, level, msg, ctx} }`. Logger ingests it.

---

## MSG.AUTOJOBS — Auto Jobs control

Owned entirely by the Auto Jobs subsystem. See
[pipelines.md → Auto Jobs](pipelines.md). It does NOT add WS/game RPCs of
its own — for accept/refresh/endpoint it reuses the generic `MSG.GAME.*`
messages (`ACCEPT_JOB`, `COMPLETE_JOB`, `REVERT_ENDPOINT_TO_HOME`, `REFRESH_*`,
`REQUEST_NM_MAP`).

| Constant | Wire string | Direction | Payload | What it does |
|---|---|---|---|---|
| `AUTOJOBS.TOGGLE` | `toggleAutoJobs` | popup → isolated (runtime) | `{ settings: { enabled } }` | fired alongside the `AUTOJOBS_SETTINGS` sync write so the orchestrator starts/stops its loop immediately (Firefox sync.onChanged can be flaky cross-context). |
| `AUTOJOBS.OPEN_SAI_ACTION` | `ajOpenSai` | popup → isolated (runtime) | `{ serverName, serverId, serverType }` | NM context-menu "Open SAI". Orchestrator forwards to the MAIN bridge — **refused while the loop runs**. `serverId` (from `NM_GRAPH`) is required for the WS connect; `serverType` (the server's `serverTypeName`, e.g. "CEDRT private") lets the hack path pick HACK software. |
| `AUTOJOBS.OPEN_MARKET_ACTION` | `ajOpenMarket` | popup → isolated (runtime) | `{ serverName, serverId, serverType }` | NM context-menu "Open Market". Same refuse-while-running guard. `serverName`/`serverId` are `null` for the HOME market (`serverType` unused). |
| `AUTOJOBS.OPEN_SAI` | `COR3_AJ_OPEN_SAI` | isolated → MAIN (window) | `{ serverName, serverId, serverType }` | handled by `auto-jobs-bridge.js` — **no DOM coordinate clicks**: opens the Network Map window (`COR3.game.desktop.openAppAndWait`), connects via `__cor3SetEndpoint` (WS `set.endpoint`), opens the SAI terminal, then `saiAccess()` gains access — **Active Access** (`__cor3SaiGetLoginStatus` → `__cor3SaiLoginWithAccess`, a `task_access` grant, no password/passhack) or, with no grant, **hacks** the server (`COR3.game.loadout.ensureHack(serverType)` installs HACK software → click hack-tool row → solver wins the minigame → poll `get.login.status` for the new grant → `login.with-access`). |
| `AUTOJOBS.OPEN_MARKET` | `COR3_AJ_OPEN_MARKET` | isolated → MAIN (window) | `{ serverName, serverId, serverType }` | handled by the bridge — same client-fn window-open + WS `set.endpoint` connect, then invokes the panel's Market control via `COR3.game.desktop.invokeReactClick` (text button for HOME, chest icon for DARK/SRM). `serverId` is `null` for HOME (no connect). |
| `AUTOJOBS.FLOW_START` | `COR3_AJ_FLOW_START` | isolated → MAIN (window) | `{ jobId, marketId, jobType, fileCondition, fileId?, serverName? }` | JOB_FLOW dispatch. The MAIN `flow-*` module for `jobType` executes the job. **Field is `jobType` not `type`** — `Bus.window` builds the envelope as `Object.assign({type}, payload)`, so a payload `type` would clobber the Bus message id and never be delivered. |
| `AUTOJOBS.FLOW_RESULT` | `COR3_AJ_FLOW_RESULT` | MAIN → isolated (window) | `{ jobId, marketId, success, didWork, reason }` | flow outcome. `success&&didWork` = completed; `success&&!didWork` = can't do it → bugged; `success:false` = failure → bugged. |
| `AUTOJOBS.FLOW_STEP` | `COR3_AJ_FLOW_STEP` | MAIN → isolated (window) | `{ jobId, node }` | live sub-step report (`node` ∈ `AJ.NODE.fd-*`). The orchestrator relays it to `AJ_PIPELINE_STATE` so the Flow Map highlights the current step inside JOB_FLOW. |

Acceptance confirmation is **not** a dedicated message: an accepted job leaves
the market board's `jobs[]` and reappears in `recentJobs[]` with
`status: 'TAKEN'`, which the next `UPDATE_MARKETS` cycle observes.

---

## STORAGE_LOCAL — chrome.storage.local keys

### Game data cache

| Key | Shape | Owner | Notes |
|---|---|---|---|
| `expeditionsData` | `Expedition[]` | `data/expeditions.js` | + `expeditionsDataUpdatedAt: number`. |
| `expeditionDecisions` | `Decision[]` | `data/decisions.js` | full replace on every WS push (server sends empty array on launch). |
| `marketData` | `{marketId, jobs, recentJobs, nextJobsResetAt}` | `data/market.js` | + `marketDataUpdatedAt`. Flat shape — we fetch only `get.jobs` (not `get.options`). |
| `darkMarketData` | same | `data/dark-market.js` | + `darkMarketDataUpdatedAt`. |
| `darkMarketAvailable` | `boolean` | `data/dark-market.js` | flips false on `WS.DARK_MARKET_UNREACHABLE`. |
| `srmMarketData` | `{marketId, jobs, recentJobs, …}` | `data/srm-market.js` | SRM7-M market. + `srmMarketDataUpdatedAt`. |
| `srmMarketAvailable` | `boolean` | `data/srm-market.js` | reachability flag (mirrors dark). |
| `loadoutData` | `{ …snapshot, _derived:{decryptExtensions, capabilities, canBoot} }` | `data/loadout.js` | from `loadout/get.options`. `_derived` is computed up-front so Auto Jobs doesn't recompute each cycle. |
| `stashData` | `{items, currentUsage, maxCapacity}` | `data/stash.js` | + `stashDataUpdatedAt`. |
| `mercenariesData` | `Merc[] \| {mercenaries: Merc[]}` | `data/mercenaries.js` | + `mercenariesUpdatedAt`. |
| `mercConfigData` | `{[mercId]: {totalCost, riskScore, ...}}` | `data/merc-config.js` | merged per-merc; + `mercConfigUpdatedAt`. |
| `expeditionConfigData` | `{locations: [...]}` | `data/expedition-config.js` | + `expeditionConfigUpdatedAt`. |
| `dailyOpsData` | `{nextTaskTime, currentStreak, hasClaimedToday, difficulty, streakBonus, currentGameId}` | `automation/daily-ops.js` | + `dailyOpsUpdatedAt`. Field name is `currentStreak`, not `streak`. |
| `dailyOpsError` | `'token_expired' \| null` | `automation/daily-ops.js` | + `dailyOpsErrorUpdatedAt`. |
| `dailyRewardsData` | `Reward[]` | `data/auth.js` (via `MSG.AUTH.DAILY_REWARDS`) | streak bonus calc. |

### Auth + version

| Key | Shape | Owner |
|---|---|---|
| `bearerToken` | `'Bearer …'` | `data/auth.js` |
| `webVersion` | `'v1.17.21'` | `data/auth.js` |
| `systemVersion` | `number` | `data/auth.js` |

### Expedition runtime

| Key | Shape | Owner |
|---|---|---|
| `lastExpeditionLaunchData` | LaunchConfig | `auto-send-merc.js` (also runtime-bridge for popup launch) |
| `expeditionLaunchError` | `{error, retryAfter, timestamp}` | `auto-send-merc.js` |

### Network Map runtime

| Key | Shape | Owner |
|---|---|---|
| `networkMapGraph` | `{ home, currentEndpointId, servers:[{id,name,depth,faction,…}] }` | `auto-jobs.js` orchestrator persists it (from the WS interceptor's `network-map.get.map`, BFS-depth). Read-only shared input. |

### Auto Jobs runtime

Constants live under `STORAGE_LOCAL.AJ_*`.

| Key | Shape | Owner |
|---|---|---|
| `ajPipelineState` | `{ running, cycle, node, startedAt, updatedAt, error? }` | `auto-jobs.js`. `node` ∈ `AJ.NODE.*` — drives the Flow Map highlight. |
| `ajJobQueue` | `{ cycle, computedAt, markets:[{slot, reachable, refreshed, jobCount, takenCount, reason}], jobs:[{id, name, type, status, serverName, marketSlot, marketId, rewardCredits, eligible, skipReason}] }` | `auto-jobs/pipeline.js` (JOB_QUEUE / CHECK_CONDITION). `status` = `'AVAILABLE'` (board) or `'TAKEN'` (in-progress); `eligible` is null until CHECK_CONDITION runs. |
| `ajBuggedJobs` | `{ [jobId]: { reason, since } }` | written by JOB_FLOW's `_markBugged`; read by the pipeline (CHECK_CONDITION) + the Job List (shows a **BUGGED** pill live). The UI writes it too: per-job ✕ (un-bug) and the header **Clear Bugged** button (`= {}`). |
| `ajServerOverrides` | `{ [serverName]: { skip: bool, disabledTypes: { [jobType]: true } } }` | NM context menu → read by CHECK_CONDITION + Job List (live). |
| `ajMasterSwitches` | `{ markets: { home, dark, srm }, jobTypes: { [FLOW.*]: bool } }` | Master Switches panel. `false` = disabled globally (absent = on). Read by CHECK_CONDITION (acceptance) + Job List/Network Map (live display). |

> **Config eligibility is shared.** The market/type/server-override part of a
> job's verdict is computed by `COR3.ajEligibility.configSkipReason(job,
> switches, overrides)` (`src/shared/aj-eligibility.js`, loaded in BOTH the
> isolated content world and the popup). The pipeline stamps the *data* part it
> alone can compute (bugged / K-D / accessibility) onto each queue job as
> `dataSkipReason`; the popup re-derives the config part live so a toggle
> reflects in the Job List immediately, without waiting for a pipeline cycle.

### Solver runtime

| Key | Shape | Owner |
|---|---|---|
| `dailyHackLog` | string | `automation/daily-ops.js` (relays `SOLVER.DAILY_OPS_LOG`). Key name preserved for storage compatibility. |
| `dailyHackLogUpdatedAt` | number | same |

### Logger / errors

| Key | Shape | Owner |
|---|---|---|
| `cor3_logs` | `{[moduleId]: [{ts, level, msg, ctx}, …]}` 200/module | `core/logger.js` |
| `cor3_errors` | `[{timestamp, source, message, stack, context}]` 200 | `shared/errors.js` |

---

## STORAGE_SYNC — chrome.storage.sync keys (user prefs)

| Key | Shape | Default | Owner |
|---|---|---|---|
| `selectedTheme` | string | `'default'` | (unused; UI ships a single theme) |
| `alarms` | `Alarm[]` | `[]` | popup `alarms` section + `automation/timers.js` |
| `autoJobsSettings` | `{enabled}` | `{enabled:false}` | `auto-jobs.js` — the only sync key Auto Jobs owns; toggling it starts/stops the loop (alongside `MSG.AUTOJOBS.TOGGLE`). |
| `autoSendMerc` | `{enabled, autoChooseMerc, mercenaryId, mercenaryName, disabledReason}` | `{enabled:false, autoChooseMerc:true}` | `auto-send-merc.js`, mercenaries section |
| `autoDecryptEnabled` | bool | `false` | `auto-decrypt.js` |
| `autoIceWallEnabled` | bool | `false` | `auto-ice-wall.js` — toggle gates the SAI Porter-lite r4 watcher. |
| `autoRefresh` | `{home_jobs: bool, dark_jobs: bool}` | `{home:false, dark:false}` | `auto-refresh.js` |
| `autoChooseEnabled` | bool | `false` | `auto-choose-decision.js` |
| `riskThreshold` | `0..10` | `5` | `auto-choose-decision.js`. Score = `loot - risk*((10-threshold)/5)`. |
| `disableSystemMessages` | bool | `false` | `appearance/system-messages.js` |
| `disableBackground` | bool | `false` | `appearance/background.js` |
| `disableNetworkFog` | bool | `false` | `appearance/network-fog.js` |
| `disableMapFxEnabled` | bool | `false` | `appearance/map-fx.js` (key has an `Enabled` suffix for historical reasons) |
| `pinnedTimers` | (unused) | `[]` | — |
| `modules` | `{[moduleId]: {enabled, logsEnabled}}` | `{}` | Module Manager UI + `core/settings.js` |

---

## FLOW — Job type identifiers

These are the job-type strings produced by the pipeline's `detectJobType()`
(`auto-jobs/pipeline.js`) and carried as `jobType` on `MSG.AUTOJOBS.FLOW_START`
when the orchestrator dispatches a TAKEN job to its MAIN `flow-*` module.

| Constant | Value | Flow module (`src/modules/game/flows/auto-jobs/`) |
|---|---|---|
| `FLOW.FILE_DECRYPTION` | `file_decryption` | `file-decryption.js` (local file open — no server) |
| `FLOW.IP_INJECTION` | `ip_injection` | `ip-injection.js` |
| `FLOW.IP_CLEANUP` | `ip_cleanup` | `ip-cleanup.js` |
| `FLOW.FILE_UPLOAD` | `file_upload` | `file-upload.js` (= data_upload) |
| `FLOW.LOG_DELETION` | `log_deletion` | `log-deletion.js` |
| `FLOW.LOG_DOWNLOAD` | `log_download` | `log-download.js` |
| `FLOW.FILE_ELIMINATION` | `file_elimination` | `file-elimination.js` |
| `FLOW.DATA_DOWNLOAD` | `data_download` | `data-download.js` |
| `FLOW.DECRYPT_EXTRACT` | `decrypt_extract` | `decrypt-extract.js` |

> **Adding a new flow** needs: a `detectJobType()` case + condition parsing in
> `auto-jobs/pipeline.js`, a new `flow-*` module under `flows/auto-jobs/`, and
> wiring into the orchestrator's JOB_FLOW batch dispatch.

---

## AJ — Auto Jobs flowchart nodes & loop cadence

Lives in `constants.AJ`. The single source of truth shared between the
orchestrator (execution order + `AJ_PIPELINE_STATE.node`) and the popup Flow
Map (which boxes to draw and highlight).

| Field | Value | Notes |
|---|---|---|
| `AJ.PACKET_TYPE` | `'aj/packet'` | `type` stamped on the packet that flows stage→stage. |
| `AJ.NODE.*` | top-level: `start`, `delay-initial`, `get-servers`, `check-access`, `update-markets`, `job-queue`, `queue-empty`, `have-tasks-in-progress`, `bugged-jobs`, `job-skip`, `check-condition`, `job-acception`, `job-flow`, `delay-cycle`; file_decryption sub-flow: `fd-read-format`, `fd-check-loadout`, `fd-install-sw`, `fd-open-downloads`, `fd-solve`, `fd-complete`, `mark-as-bugged` | flowchart node ids. The `fd-*` sub-steps are reported live by the MAIN flow via `FLOW_STEP` and highlighted on the Flow Map. |
| `AJ.LOOP.INITIAL_DELAY_MS` | `10000` | one-time delay after START before the first cycle. |
| `AJ.LOOP.CYCLE_DELAY_MS` | `30000` | gap between cycles. |
| `AJ.LOOP.MARKET_REFRESH_TIMEOUT_MS` | `6000` | UPDATE_MARKETS wait for a refreshed market frame before logging loud & moving on. |
| `AJ.LOOP.ACCEPT_PACING_MS` | `1200` | gap between successive `ACCEPT_JOB` posts in JOB_ACCEPTION. |
| `AJ.LOOP.FLOW_TIMEOUT_MS` | `300000` | max time JOB_FLOW parks on one `FLOW_RESULT` before bugging the job. |

---

## CATEGORY — Module category tags

Used by Module Manager UI for grouping. Each module declares one in its
`super({...})` call.

| Constant | Value | Modules |
|---|---|---|
| `CATEGORY.CORE` | `core` | `runtime-bridge` |
| `CATEGORY.DATA` | `data` | 12 data modules (auth, expeditions, archived-expeditions, decisions, market, dark-market, srm-market, stash, loadout, mercenaries, merc-config, expedition-config) |
| `CATEGORY.AUTOMATION` | `automation` | timers, auto-refresh, auto-send-merc, auto-choose-decision, auto-decrypt, auto-ice-wall, auto-simple-decrypt, daily-ops, auto-jobs, auto-jobs, runtime-bridge |
| `CATEGORY.GAME` | `game` | loadout-panel, 9 Auto Jobs flow modules (the `auto-jobs-bridge` and `desktop-window.js` IIFEs are GAME-world `COR3.game.*` helpers, NOT registered Modules) |
| `CATEGORY.SOLVER` | `solver` | solver-decrypt, solver-daily-ops, solver-ice-wall, solver-simple-decrypt |
| `CATEGORY.APPEARANCE` | `appearance` | 4 appearance modules |
| `CATEGORY.UI` | `ui` | (UI sections aren't Modules — they live in popup context separately) |

---

## LIMITS — Tunables

| Constant | Value | Used by |
|---|---|---|
| `LIMITS.LOG_RING_PER_MODULE` | `200` | Logger ring buffer size per module |
| `LIMITS.ERRORS_RING` | `200` | `cor3_errors` size cap |

> Auto Jobs loop/timeout tunables live under `constants.AJ.LOOP.*` (see the AJ
> section above), not `LIMITS`.

---

## Data shapes referenced above

These are documented loosely — the canonical shape comes from cor3.gg's WS
server. Fields used by the extension:

```ts
type Job = {
    id: string;
    name: string;            // e.g. "File Decryption"
    category?: string;
    relatedServers?: string | { name: string }[];
    conditions?: { items: { details: ConditionDetails }[] };
    isCompleted?: boolean;
    isExpired?: boolean;
    status?: 'AVAILABLE' | 'TAKEN' | 'COMPLETED';
};

type ConditionDetails = {
    fileNames?: string[];
    fileName?: string;
    files?: { name: string }[];
    extensions?: { ext: string }[];
    ipAddresses?: string[];
    ips?: string[];
    ipAddress?: string;
    ip?: string;
    logNames?: string[];
    logName?: string;
    logSeqs?: number[];
};

type Expedition = {
    id: string;
    status: 'IN_PROGRESS' | 'COMPLETED';
    completedAt?: string;
    containerOpenedAt?: string;
    endTime?: string;        // ISO timestamp
    locationName?: string;
    zoneName?: string;
    riskScore?: number;
    mercenary?: { callsign: string };
    messages?: ExpeditionMessage[];
};

type ExpeditionMessage = {
    id: string;
    content: string;
    decisionOptions?: { id: string; label: string; lootModifier: number; riskModifier: number }[];
    selectedOption?: string;
    decisionDeadline?: string;   // ISO timestamp
    isResolved?: boolean;
    isAutoResolved?: boolean;
    createdAt?: string;
};

type Merc = {
    id: string;
    callsign: string;
    status: 'AVAILABLE' | 'RESTING' | 'ACTIVE' | …;
    ...
};

type Decision = {
    expeditionId: string;
    mercenaryCallsign: string;
    locationName: string;
    zoneName: string;
    riskScore: number;
    messageId: string;
    content: string;
    decisionOptions: ...;
    selectedOption: string | null;
    decisionDeadline: string;
    isResolved: boolean;
    isAutoResolved: boolean;
    createdAt: string;
};
```
