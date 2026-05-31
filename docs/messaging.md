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
| `GAME.COMPLETE_JOB` | `COR3_COMPLETE_JOB` | `{ jobId, marketId }` | `market.job.complete`. Sent by v1 auto-jobs and by Auto-Jobs v2's flow-v2 modules after a job's minigame finishes. |
| `GAME.RESPOND_DECISION` | `COR3_RESPOND_DECISION` | `{ expeditionId, messageId, selectedOption }` | `expeditions.respond.event`. |
| `GAME.OPEN_NETWORK_MAP` | `COR3_OPEN_NETWORK_MAP` | `null` | clicks the taskbar `TabBarItem-NETWORK_MAP`; on success scrapes the server list. |
| `GAME.OPEN_MARKET_JOBS` | `COR3_OPEN_MARKET_JOBS` | `{ home: bool, dark: bool }` | sequentially opens home market and/or dark market job tabs. |
| `GAME.REQUEST_NM_SERVERS` | `COR3_REQUEST_NM_SERVERS` | `null` | ensure NM open + scrape server list (sends `GAME.NM_SERVERS` back). |
| `GAME.NM_SERVERS` | `COR3_NM_SERVERS` | `{ servers: string[] }` | **inverse direction** — MAIN → isolated. Auto-jobs merges into `STORAGE_LOCAL.NM_SERVERS`. |
| `GAME.REFRESH_DARK_MARKET` / `GAME.REFRESH_SRM_MARKET` | `COR3_REFRESH_DARK_MARKET` / `COR3_REFRESH_SRM_MARKET` | `null` | set endpoint to the dark / SRM7-M server, then `get.options`. Used by auto-refresh and Auto-Jobs v2's UPDATE_MARKETS. |
| `GAME.REQUEST_NM_MAP` | `COR3_REQUEST_NM_MAP` | `null` | request `network-map.get.map`; reply lands in `STORAGE_LOCAL.NM_GRAPH` (BFS-depth graph). |
| `GAME.NM_GRAPH` | `COR3_NM_GRAPH` | `{ home, currentEndpointId, servers:[…] }` | **inverse** — MAIN → isolated, the parsed graph. |
| `GAME.REQUEST_LOADOUT` | `COR3_REQUEST_LOADOUT` | `null` | join `loadout` room → server replies `loadout/get.options` (→ `STORAGE_LOCAL.LOADOUT`). |
| `GAME.REVERT_ENDPOINT_TO_HOME` | `COR3_REVERT_ENDPOINT_TO_HOME` | `null` | reset the NM endpoint back to HOME. Posted at the end of a bulk-accept batch (v1 auto-jobs and Auto-Jobs v2's JOB_ACCEPTION) that may have left the endpoint on DARK/SRM. |

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

## MSG.JOB — Job-flow dispatch

Direction: depends on entry. Each `START_*` is isolated → MAIN (auto-jobs
orchestrator → flow module). `MINIGAME_DONE` / `TIMEOUT` / `KD_DETECTED` /
`SERVER_UNREACHABLE` / `LOG` / `AUTOJOBS_ACTIVE_CHANGED` are MAIN → isolated
or both.

### Start types (isolated → MAIN)

| Constant | Wire string | Payload | Flow file |
|---|---|---|---|
| `JOB.START_DECRYPTION` | `COR3_START_JOB_FLOW` | `{ jobId, marketId, fileCondition }` | `flows/file-decryption.js` |
| `JOB.START_IP_INJECTION` | `COR3_START_IP_JOB_FLOW` | `{ jobId, marketId, serverName, ips: string[] }` | `flows/ip-injection.js` |
| `JOB.START_IP_CLEANUP` | `COR3_START_IP_CLEANUP_FLOW` | `{ jobId, marketId, serverName, ips }` | `flows/ip-cleanup.js` |
| `JOB.START_UPLOAD` | `COR3_START_UPLOAD_JOB_FLOW` | `{ jobId, marketId, serverName, fileCondition }` | `flows/file-upload.js` |
| `JOB.START_LOG_DELETION` | `COR3_START_LOG_DELETION_FLOW` | `{ jobId, marketId, serverName, fileCondition: logName, logSeqs: number[] \| null }` | `flows/log-deletion.js` |
| `JOB.START_LOG_DOWNLOAD` | `COR3_START_LOG_DOWNLOAD_FLOW` | same as deletion | `flows/log-download.js` |
| `JOB.START_FILE_ELIMINATION` | `COR3_START_FILE_ELIMINATION_FLOW` | `{ jobId, marketId, serverName, fileCondition }` | `flows/file-elimination.js` |
| `JOB.START_DATA_DOWNLOAD` | `COR3_START_DATA_DOWNLOAD_FLOW` | `{ jobId, marketId, serverName, fileNames: string[] }` | `flows/data-download.js` |
| `JOB.START_DECRYPT_EXTRACT` | `COR3_START_DECRYPT_EXTRACT_FLOW` | `{ jobId, marketId, serverName, fileCondition }` | `flows/decrypt-extract.js` |

### Signals (MAIN → isolated)

| Constant | Wire string | Payload | Auto-jobs response |
|---|---|---|---|
| `JOB.MINIGAME_DONE` | `COR3_JOB_MINIGAME_DONE` | `{ jobId, marketId }` | transition to `completing`, send `COR3_COMPLETE_JOB`. |
| `JOB.MINIGAME_TIMEOUT` | `COR3_JOB_MINIGAME_TIMEOUT` | `{ jobId, marketId }` | bug the job (2 h TTL), drop from queue, 20 s cooldown. |
| `JOB.KD_DETECTED` | `COR3_JOB_KD_DETECTED` | `{ serverName, timerText }` | blacklist server for parsed timer + 5 min buffer. |
| `JOB.SERVER_UNREACHABLE` | `COR3_SERVER_UNREACHABLE` | `{ serverName, blockedByKD?: [{serverName, timerText}] }` | blacklist for max(30 min, longest K/D). |
| `JOB.LOG` | `COR3_JOB_LOG` | `{ msg, level }` | append to `STORAGE_LOCAL.AUTOJOBS_LOG` (100-entry ring). |
| `JOB.ABORT` | `COR3_ABORT_JOB_FLOW` | `null` | (isolated → MAIN) — sets `window.__jobManagerAbort`, terminates current flow. |
| `JOB.AUTOJOBS_ACTIVE_CHANGED` | `COR3_AUTOJOBS_ACTIVE_CHANGED` | `{ active: bool }` | (isolated → MAIN) — toggles UI lock that prevents NM close while auto-jobs is on. |

### Off-enum

- `COR3_JOB_MANAGER_READY` — MAIN → isolated, signals that flow modules booted; auto-jobs uses this to drain queue / resume mid-state.
- `COR3_REQ_DUMP` — debug: F12 `__cor3Dump()` posts this from MAIN; isolated content used to dump state but the new architecture has no handler yet — adding one is a TODO.
- `COR3_FETCH_DAILY_OPS` — MAIN → isolated, fired by interceptor on WS open; daily-ops module fetches `svc-corie.cor3.gg/api/user-daily-claim`.
- `COR3_LOCK_UI` / `COR3_UNLOCK_UI` — aliases for AUTOJOBS_ACTIVE_CHANGED; flows-core listens.
- `COR3_LOG_REMOTE` — MAIN → isolated, log-bridge envelope. `{ moduleId, entry: {ts, level, msg, ctx} }`. Logger ingests it.
- `COR3_ACCEPT_JOB_SEND_FAILED` — MAIN → isolated, fired when `wsSend` returned false during accept. Auto-jobs (v1 and v2) can observe it.

---

## MSG.AUTOJOBS_V2 — Auto-Jobs v2 control

Owned entirely by Auto-Jobs v2; never overlaps v1's `toggleAutoJobs`. See
[pipelines.md → Auto-Jobs v2](pipelines.md). v2 does NOT add WS/game RPCs of
its own — for accept/refresh/endpoint it reuses the generic `MSG.GAME.*`
messages (`ACCEPT_JOB`, `REVERT_ENDPOINT_TO_HOME`, `REFRESH_*`).

| Constant | Wire string | Direction | Payload | What it does |
|---|---|---|---|---|
| `AUTOJOBS_V2.TOGGLE` | `toggleAutoJobsV2` | popup → isolated (runtime) | `{ settings: { enabled } }` | fired alongside the `AUTOJOBS_V2_SETTINGS` sync write so the orchestrator starts/stops its loop immediately (Firefox sync.onChanged can be flaky cross-context). |
| `AUTOJOBS_V2.OPEN_SAI_ACTION` | `ajv2OpenSai` | popup → isolated (runtime) | `{ serverName, serverId, serverType }` | NM context-menu "Open SAI". Orchestrator forwards to the MAIN bridge — **refused while the loop runs**. `serverId` (from `NM_GRAPH`) is required for the WS connect; `serverType` (the server's `serverTypeName`, e.g. "CEDRT private") lets the hack path pick HACK software. |
| `AUTOJOBS_V2.OPEN_MARKET_ACTION` | `ajv2OpenMarket` | popup → isolated (runtime) | `{ serverName, serverId, serverType }` | NM context-menu "Open Market". Same refuse-while-running guard. `serverName`/`serverId` are `null` for the HOME market (`serverType` unused). |
| `AUTOJOBS_V2.OPEN_SAI` | `COR3_AJV2_OPEN_SAI` | isolated → MAIN (window) | `{ serverName, serverId, serverType }` | handled by `auto-jobs-v2-bridge.js` — **no DOM coordinate clicks**: opens the Network Map window (`COR3.game.desktop.openAppAndWait`), connects via `__cor3SetEndpoint` (WS `set.endpoint`), opens the SAI terminal, then `saiAccess()` gains access — **Active Access** (`__cor3SaiGetLoginStatus` → `__cor3SaiLoginWithAccess`, a `task_access` grant, no password/passhack) or, with no grant, **hacks** the server (`COR3.game.loadout.ensureHack(serverType)` installs HACK software → click hack-tool row → solver wins the minigame → poll `get.login.status` for the new grant → `login.with-access`). |
| `AUTOJOBS_V2.OPEN_MARKET` | `COR3_AJV2_OPEN_MARKET` | isolated → MAIN (window) | `{ serverName, serverId, serverType }` | handled by the bridge — same client-fn window-open + WS `set.endpoint` connect, then invokes the panel's Market control via `COR3.game.desktop.invokeReactClick` (text button for HOME, chest icon for DARK/SRM). `serverId` is `null` for HOME (no connect). |
| `AUTOJOBS_V2.FLOW_START` | `COR3_AJV2_FLOW_START` | isolated → MAIN (window) | `{ jobId, marketId, jobType, fileCondition, fileId?, serverName? }` | JOB_FLOW dispatch. The MAIN `flow-v2-*` module for `jobType` executes the job. **Field is `jobType` not `type`** — `Bus.window` builds the envelope as `Object.assign({type}, payload)`, so a payload `type` would clobber the Bus message id and never be delivered. |
| `AUTOJOBS_V2.FLOW_RESULT` | `COR3_AJV2_FLOW_RESULT` | MAIN → isolated (window) | `{ jobId, marketId, success, didWork, reason }` | flow outcome. `success&&didWork` = completed; `success&&!didWork` = can't do it → bugged; `success:false` = failure → bugged. |
| `AUTOJOBS_V2.FLOW_STEP` | `COR3_AJV2_FLOW_STEP` | MAIN → isolated (window) | `{ jobId, node }` | live sub-step report (`node` ∈ `AJV2.NODE.fd-*`). The orchestrator relays it to `AJV2_PIPELINE_STATE` so the Flow Map highlights the current step inside JOB_FLOW. |

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
| `loadoutData` | `{ …snapshot, _derived:{decryptExtensions, capabilities, canBoot} }` | `data/loadout.js` | from `loadout/get.options`. `_derived` is computed up-front so Auto-Jobs doesn't recompute each cycle. |
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
| `networkMapServers` | `string[]` | `auto-jobs.js` (merged from `MSG.GAME.NM_SERVERS`) |
| `networkMapGraph` | `{ home, currentEndpointId, servers:[{id,name,depth,faction,…}] }` | `network-map.js` (from `network-map.get.map`, BFS-depth). Read-only shared input for both v1 and Auto-Jobs v2. |

### Auto-jobs runtime

| Key | Shape | Owner |
|---|---|---|
| `autoJobsState` | `{status, jobId, marketId, jobName, jobType, serverName, ips, fileCondition, fileNames, logSeqs, updatedAt}` | `auto-jobs.js` |
| `autoJobsQueue` | resolved-job descriptors | `auto-jobs.js` |
| `autoJobsLog` | `[{ts, msg, level}]` 100-entry ring | `auto-jobs.js` (centralized Logger is canonical) |
| `buggedJobIds` | `{[jobId]: {ts, name}}` 2 h TTL | `auto-jobs.js` |
| `autoJobsPendingConfirm` | confirm payload from solver, with `ts` | `auto-jobs.js` (debug mode) |
| `autoJobsConfirmResult` | `{requestTs, approved}` | popup writes it |

### Auto-Jobs v2 runtime

v2 owns these keys exclusively — it never reads or writes the v1 `autoJobs*` /
`aj*` keys above. Constants live under `STORAGE_LOCAL.AJV2_*`.

| Key | Shape | Owner |
|---|---|---|
| `ajv2PipelineState` | `{ running, cycle, node, startedAt, updatedAt, error? }` | `auto-jobs-v2.js`. `node` ∈ `AJV2.NODE.*` — drives the Flow Map highlight. |
| `ajv2JobQueue` | `{ cycle, computedAt, markets:[{slot, reachable, refreshed, jobCount, takenCount, reason}], jobs:[{id, name, type, status, serverName, marketSlot, marketId, rewardCredits, eligible, skipReason}] }` | `auto-jobs-v2/pipeline.js` (JOB_QUEUE / CHECK_CONDITION). `status` = `'AVAILABLE'` (board) or `'TAKEN'` (in-progress); `eligible` is null until CHECK_CONDITION runs. |
| `ajv2BuggedJobs` | `{ [jobId]: { reason, since } }` | written by JOB_FLOW's `_markBugged`; read by the pipeline (CHECK_CONDITION) + the Job List (shows a **BUGGED** pill live). The UI writes it too: per-job ✕ (un-bug) and the header **Clear Bugged** button (`= {}`). |
| `ajv2ServerOverrides` | `{ [serverName]: { skip: bool, disabledTypes: { [jobType]: true } } }` | NM context menu → read by CHECK_CONDITION + Job List (live). |
| `ajv2MasterSwitches` | `{ markets: { home, dark, srm }, jobTypes: { [FLOW.*]: bool } }` | Master Switches panel. `false` = disabled globally (absent = on). Read by CHECK_CONDITION (acceptance) + Job List/Network Map (live display). |

> **Config eligibility is shared.** The market/type/server-override part of a
> job's verdict is computed by `COR3.ajv2Eligibility.configSkipReason(job,
> switches, overrides)` (`src/shared/ajv2-eligibility.js`, loaded in BOTH the
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
| `autoJobsSettings` | `{enabled, debugMode, markets:{home,dark}, enabledJobTypes}` | `{enabled:false, debugMode:false, markets:{home:true,dark:true}, enabledJobTypes:{}}` | `auto-jobs.js` (v1) |
| `autoJobsV2Settings` | `{enabled}` | `{enabled:false}` | `auto-jobs-v2.js` — the ONLY sync key v2 owns; toggling it starts/stops the v2 loop (alongside `MSG.AUTOJOBS_V2.TOGGLE`). |
| `serverPriorities` | `{[serverName]: number}` | `{}` | `auto-jobs.js` (used by queue sort; UI for editing not built yet) |
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

These are strings used by `auto-jobs.detectJobType()` (matched against
job name keywords) and by the `FLOW_DISPATCH` table to pick the right
START_*_FLOW message.

| Constant | Value | START_* msg | Payload |
|---|---|---|---|
| `FLOW.FILE_DECRYPTION` | `file_decryption` | `JOB.START_DECRYPTION` | `{fileCondition}` (no server — local file open) |
| `FLOW.IP_INJECTION` | `ip_injection` | `JOB.START_IP_INJECTION` | `{serverName, ips}` |
| `FLOW.IP_CLEANUP` | `ip_cleanup` | `JOB.START_IP_CLEANUP` | `{serverName, ips}` |
| `FLOW.FILE_UPLOAD` | `file_upload` | `JOB.START_UPLOAD` | `{serverName, fileCondition}`. Note: keyword match key is `data_upload`. |
| `FLOW.LOG_DELETION` | `log_deletion` | `JOB.START_LOG_DELETION` | `{serverName, fileCondition: logName, logSeqs}` |
| `FLOW.LOG_DOWNLOAD` | `log_download` | `JOB.START_LOG_DOWNLOAD` | same |
| `FLOW.FILE_ELIMINATION` | `file_elimination` | `JOB.START_FILE_ELIMINATION` | `{serverName, fileCondition}` |
| `FLOW.DATA_DOWNLOAD` | `data_download` | `JOB.START_DATA_DOWNLOAD` | `{serverName, fileNames: string[]}` |
| `FLOW.DECRYPT_EXTRACT` | `decrypt_extract` | `JOB.START_DECRYPT_EXTRACT` | `{serverName, fileCondition}` |

> **Note:** the `JOB_TYPE_KEYWORDS` table in `auto-jobs.js` includes
> `data_upload` as an alias that maps to the file-upload flow. Adding a
> new flow needs entries in three places: `JOB_TYPE_KEYWORDS`,
> `resolveJobParams` switch, and `FLOW_DISPATCH` table.

---

## AJV2 — Auto-Jobs v2 flowchart nodes & loop cadence

Lives in `constants.AJV2`. The single source of truth shared between the v2
orchestrator (execution order + `AJV2_PIPELINE_STATE.node`) and the popup Flow
Map (which boxes to draw and highlight).

| Field | Value | Notes |
|---|---|---|
| `AJV2.PACKET_TYPE` | `'ajv2/packet'` | `type` stamped on the packet that flows stage→stage. |
| `AJV2.NODE.*` | top-level: `start`, `delay-initial`, `get-servers`, `check-access`, `update-markets`, `job-queue`, `queue-empty`, `have-tasks-in-progress`, `bugged-jobs`, `job-skip`, `check-condition`, `job-acception`, `job-flow`, `delay-cycle`; file_decryption sub-flow: `fd-read-format`, `fd-check-loadout`, `fd-install-sw`, `fd-open-downloads`, `fd-solve`, `fd-complete`, `mark-as-bugged` | flowchart node ids. The `fd-*` sub-steps are reported live by the MAIN flow via `FLOW_STEP` and highlighted on the Flow Map. |
| `AJV2.LOOP.INITIAL_DELAY_MS` | `10000` | one-time delay after START before the first cycle. |
| `AJV2.LOOP.CYCLE_DELAY_MS` | `30000` | gap between cycles. |
| `AJV2.LOOP.MARKET_REFRESH_TIMEOUT_MS` | `6000` | UPDATE_MARKETS wait for a refreshed market frame before logging loud & moving on. |
| `AJV2.LOOP.ACCEPT_PACING_MS` | `1200` | gap between successive `ACCEPT_JOB` posts in JOB_ACCEPTION. |
| `AJV2.LOOP.FLOW_TIMEOUT_MS` | `300000` | max time JOB_FLOW parks on one `FLOW_RESULT` before bugging the job. |

---

## CATEGORY — Module category tags

Used by Module Manager UI for grouping. Each module declares one in its
`super({...})` call.

| Constant | Value | Modules |
|---|---|---|
| `CATEGORY.CORE` | `core` | `runtime-bridge` |
| `CATEGORY.DATA` | `data` | 12 data modules (auth, expeditions, archived-expeditions, decisions, market, dark-market, srm-market, stash, loadout, mercenaries, merc-config, expedition-config) |
| `CATEGORY.AUTOMATION` | `automation` | timers, auto-refresh, auto-send-merc, auto-choose-decision, auto-decrypt, auto-ice-wall, auto-simple-decrypt, daily-ops, auto-jobs, auto-jobs-v2, runtime-bridge |
| `CATEGORY.GAME` | `game` | network-map, server-connect, sai-navigator, loadout-panel, flows-core, 9 flows (the `auto-jobs-v2-bridge` and `desktop-window.js` IIFEs are GAME-world `COR3.game.*` helpers, NOT registered Modules) |
| `CATEGORY.SOLVER` | `solver` | solver-decrypt, solver-daily-ops, solver-ice-wall, solver-simple-decrypt |
| `CATEGORY.APPEARANCE` | `appearance` | 4 appearance modules |
| `CATEGORY.UI` | `ui` | (UI sections aren't Modules — they live in popup context separately) |

---

## LIMITS — Tunables

| Constant | Value | Used by |
|---|---|---|
| `LIMITS.LOG_RING_PER_MODULE` | `200` | Logger ring buffer size per module |
| `LIMITS.ERRORS_RING` | `200` | `cor3_errors` size cap |
| `LIMITS.AUTOJOBS_LOG_RING` | `100` | `autoJobsLog` size cap |
| `LIMITS.BUGGED_JOB_TTL_MS` | `2 * 3600 * 1000` (2 h) | bugged-job blacklist TTL |
| `LIMITS.AUTOJOBS_STATE_TTL_MS` | `5 * 60 * 1000` (5 min) | restore mid-state on reload only if recent |

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
