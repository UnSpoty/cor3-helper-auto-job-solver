# Pipelines

Detailed flow diagrams for the major end-to-end pipelines. For
message-level reference see [messaging.md](messaging.md). For module
contracts see [module-spec.md](module-spec.md).

---

## 1. Auto-Jobs (the big one)

State machine in `src/modules/automation/auto-jobs.js`. States:
`idle | accepting | solving | completing`.

### Boot

```
chrome.storage.sync.modules → Settings.load()
chrome.storage.sync.autoJobsSettings → settings
chrome.storage.local.autoJobsState → state (if status !== 'idle' AND age < 5 min)
chrome.storage.local.autoJobsQueue → queue (filter out bugged jobs)
chrome.storage.local.buggedJobIds → buggedJobs (drop expired entries)

if settings.enabled → handleEnabledChange() starts the tick loop
```

### Tick loop (every 5 s while enabled)

```
                 ┌────────── watchdogs first ──────────┐
                 │ accepting > 60 s   → reset to idle  │
                 │ solving   > 3 min  → bug job + reset│
                 │ completing > 45 s  → reset          │
                 └─────────────────────────────────────┘
                                  ↓
                 if cooldownUntil > now → return
                                  ↓
                 if !debugMode AND queue.length > 0 AND state.idle:
                    → executeNextFromQueue()
                                  ↓
                 if state !== idle → return
                                  ↓
                 if 30 s since lastMarketRefreshAt → request market refresh
                                  ↓
                 candidates = findCandidates()
                 if candidates.length > 0:
                    → acceptCandidatesBatch(candidates)
```

### Phase: SCAN (`findCandidates()`)

```
read marketData + darkMarketData from storage
prune sentAcceptIds (drop ids no longer in either market)
for each market jobs[]:
    detectJobType(job) → type or null  (matches name keywords)
    skip if enabledJobTypes[type] === false
    skip if job.id in sentAcceptIds (within 3 min TTL)
    skip if buggedJobs[job.id] (within 2 h TTL)
    skip if extractServerFromJob(job) is in kdSkipServers
return [{ ...job, marketId, source: 'home'|'dark', type }]
```

### Phase: ACCEPT (`acceptCandidatesBatch(candidates)`)

```
state = { status: 'accepting', jobName: 'Accepting N job(s)' }
bulkPendingJobs = candidates.map(c => {id, marketId, type, name, apiJob: c})
bulkSentOrder = []      ← filled as each accept is sent
bulkAcceptCount = 0     ← incremented as each WS_JOB_ACCEPTED arrives
bulkAcceptTotal = N
bulkAcceptStartedAt = now()

for i in 0..N:
    delay = i * 1200 + 800 + jitter[0..300]
    after delay:
        sentAcceptIds[id] = now()
        bulkSentOrder.push(pending)
        Bus.window.post('COR3_ACCEPT_JOB', {jobId, marketId})

(MAIN-world WS interceptor sends each accept; game responds with WS_JOB_ACCEPTED;
 isolated world's auto-jobs.onJobAccepted handles each response)
```

### `onJobAccepted(env)` — one per accept

```
bulkAcceptCount++
sentJob = bulkSentOrder.shift()
if env.error:
    log + drop
else:
    if sentJob already in queue: skip
    else:
        taken  = recentJobs.find(r => r.status === 'TAKEN' && r.id === sentJob.id)
        source = taken ?? sentJob.apiJob
        r = resolveJobParams(sentJob.type, source)
        if r.ok:
            queue.push({jobId, marketId, jobType, jobName, ...r.params})
        else:
            log warn ("awaiting full conditions from server")
            (will be picked up by tryResumeInProgressJob on next market refresh)

if bulkAcceptCount >= bulkAcceptTotal:
    saveQueue()
    reset bulk* state
    state → idle
    schedule market refresh (500 ms)
    schedule executeNextFromQueue (1000 ms)
```

### Phase: EXECUTE (`executeNextFromQueue`)

```
sortQueueByPriority()    ← serverPriorities; file_decryption is +Infinity
job = queue[0]
if jobType not in FLOW_DISPATCH: drop, recurse
state = { status: 'solving', jobId, marketId, ...job params }
solvingStartedAt = now()

if debugMode AND FILE_BASED_TYPES.has(jobType):
    write autoJobsPendingConfirm to storage
    poll autoJobsConfirmResult for up to 5 min
    if rejected/timeout: drop job, set 60 s cooldown, reset

dispatchSolveFlow(job) → Bus.window.post(START_*_FLOW, {jobId, marketId, ...})
                              ↓
                        (MAIN-world flow module runs the solver)
                              ↓
              MINIGAME_DONE or MINIGAME_TIMEOUT comes back
```

### Phase: COMPLETE (`onMinigameDone` → `onJobCompleted`)

```
onMinigameDone(env):
    if state.solving AND env.jobId === state.jobId:
        state.status = 'completing'
        completingStartedAt = now()
        send 'COR3_COMPLETE_JOB' (after 2-3 s human delay)
                  ↓
            game responds with WS_JOB_COMPLETED
                  ↓
onJobCompleted(env):
    if state.completing:
        completedJobIds[state.jobId] = now()  ← prevents tryResume from re-queueing
        reset state to idle
        drop job from queue
        request market refresh (2 s)
        if queue not empty: executeNextFromQueue (3 s)
```

### Recovery: `tryResumeInProgressJob` (after every market refresh)

Picks up TAKEN jobs from `recentJobs[]` that aren't already in queue and
aren't recently completed. Used when:
- Page reloaded mid-flow (state was solving, jobId set, but queue empty)
- Accept completed but TAKEN copy didn't carry full conditions yet

```
read marketData + darkMarketData
collect jobs where status === 'TAKEN' AND type detectable AND not bugged
for each:
    if already in queue: skip
    if state.jobId === id: skip (current job)
    if completedJobIds.has(id) AND age < 2 min: skip
    r = resolveJobParams(type, job)
    if r.ok: queue.push({...})

if any added: saveQueue + executeNextFromQueue (2 s)
```

### State transitions diagram

```
            ┌─────────────────────────────────────────────┐
            │                                             │
            ↓                                             │
        ┌───────┐ tick + candidates ─→ ┌──────────┐       │
        │ idle  │                      │accepting │       │
        └───┬───┘                      └─────┬────┘       │
            │                                │            │
            │ executeNextFromQueue           │ all WS     │
            │                                │ accepted   │
            │                                ↓            │
            │                            ┌──────┐         │
            │                            │ idle │         │
            │                            └───┬──┘         │
            │                                │            │
            │ ←──────────────────────────────┘            │
            ↓                                             │
        ┌─────────┐ MINIGAME_DONE   ┌───────────┐         │
        │ solving │ ─────────────→  │completing │         │
        └────┬────┘                 └─────┬─────┘         │
             │                            │ JOB_COMPLETED │
             │                            ↓               │
             │ MINIGAME_TIMEOUT       ┌──────┐            │
             │   bug job +            │ idle │ ───────────┘
             │   20s cooldown         └──────┘
             │   reset to idle
             ↓
         ┌──────┐
         │ idle │
         └──────┘
```

### Cross-references in code

| Phase | File | Function |
|---|---|---|
| Boot | `auto-jobs.js` | `init()`, `handleEnabledChange()` |
| Tick | `auto-jobs.js` | `tick()` |
| Scan | `auto-jobs.js` | `findCandidates()` |
| Accept | `auto-jobs.js` | `acceptCandidatesBatch()`, `onJobAccepted()` |
| Execute | `auto-jobs.js` | `executeNextFromQueue()`, `dispatchSolveFlow()` |
| Resume | `auto-jobs.js` | `tryResumeInProgressJob()` |
| Resolver | `auto-jobs.js` | `resolveJobParams()`, `extractServerFromJob()`, `extractIPsFromJob()`, `extractLogSeqsFromJob()` |
| Flow runner | `flows/_shared.js` | `startFlow()`, `setWatching()`, `sendDone()`, `sendTimeout()` |

---

## 1b. Auto-Jobs v2 (rewrite — Phase 1 done, Phase 2 in progress)

A ground-up rewrite of the job pipeline under the **Auto-Jobs v2** tab. NOT a
refactor of section 1 — different shape, different rules (see
[CLAUDE.md → Active work](../CLAUDE.md) and
[architecture.md → Auto-Jobs v2 subsystem](architecture.md#auto-jobs-v2-subsystem-orchestrator--stages)).

**Shape.** One registered Module — the orchestrator
(`automation/auto-jobs-v2.js`) — owns START/STOP and runs an infinite loop.
Each flowchart box is a plain *stage* object on
`COR3.autoJobsV2.pipeline.stages.*` (`automation/auto-jobs-v2/pipeline.js`) with
`async run(packet, ctx) -> packet`. A single growing **packet** flows
stage→stage. The orchestrator stamps the active `AJV2.NODE.*` onto
`STORAGE_LOCAL.AJV2_PIPELINE_STATE` so the popup Flow Map highlights the live
node. Cadence: 10 s initial delay, then a cycle every 30 s. STOP invalidates the
in-flight cycle via a generation token.

### Loop (per cycle)

```
START → DELAY:10s → ┌─ GET_SERVERS → CHECK_SERVERS_ACCESABILITY
                    │   → UPDATE_MARKETS → JOB_QUEUE → <QUEUE:EMPTY?>
                    │       YES ───────────────────────────────────────┐
                    │       NO → <HAVE_TASKS_IN_PROGRESS?>             │
                    │              YES → <BUGGED?>                     │
                    │                      YES → JOB:SKIP ─────────────┤
                    │                      NO ─┐                       │
                    │              NO ─────────┴→ CHECK_JOBS_CONDITION │
                    │                            → JOB_ACCEPTION       │
                    │                            → JOB_FLOW  (Phase 2) │
                    └──────────────── DELAY:30s ←──────────────────────┘  (loop)
```

### Stages (Phase 1 — implemented, isolated world)

| Node (`AJV2.NODE`) | Stage | What it does |
|---|---|---|
| `GET_SERVERS` | `getServers` | reads `NM_GRAPH`; throws loud if the map was never opened. Copies `home` + `servers[]` onto the packet. |
| `CHECK_ACCESS` | `checkAccess` | per server: `accessible` / `hasSaiAccess` / `onCooldown` from the graph flags. Resolves market reachability (home always; dark/srm unless their `*_AVAILABLE` flag is `false`). |
| `UPDATE_MARKETS` | `updateMarkets` | for each **reachable** market: post `MSG.GAME.REFRESH_*`, await a fresh frame (≤6 s), then read the envelope. Pulls BOTH `jobs[]` (tag `status:'AVAILABLE'`) and `recentJobs[]` TAKEN entries (tag `status:'TAKEN'`). Unreachable markets recorded with a reason, not refreshed. |
| `JOB_QUEUE` | `jobQueue` | normalises rawJobs → queue entries `{id, name, type, status, serverName, marketSlot, marketId, rewardCredits, eligible, skipReason}`; writes `AJV2_JOB_QUEUE` for the UI. |
| `QUEUE_EMPTY?` | (orchestrator) | empty board+in-progress → fall through to DELAY and loop. |
| `HAVE_TASKS_IN_PROGRESS?` | (orchestrator) | any queue job with `status==='TAKEN'`. |
| `BUGGED?` | `buggedJobs` + orchestrator | reads `AJV2_BUGGED_JOBS`; if every in-progress job is bugged → `JOB:SKIP` (skip the cycle). |
| `CHECK_CONDITION` | `checkCondition` | per job, eligibility + explicit `skipReason`. Wired conditions: bugged registry; and (only when the job has a server) server-known / K-D cooldown / accessible / user-SKIP / type-disabled (`AJV2_SERVER_OVERRIDES`). A missing related server is **not** a skip reason. |
| `JOB_ACCEPTION` | `jobAcception` | acceptance set = eligible AND `status==='AVAILABLE'`. Decryption-priority: if any `file_decryption` jobs exist, accept ALL across ALL markets; else accept the other types. Posts `MSG.GAME.ACCEPT_JOB` paced 1.2 s apart, then `MSG.GAME.REVERT_ENDPOINT_TO_HOME` once. Confirmation is async — accepted jobs reappear as `TAKEN` next cycle. |

### Phase 2 — `JOB_FLOW` (MAIN world, in progress)

After JOB_ACCEPTION the orchestrator runs `_runJobFlows()`: it selects THIS
cycle's **batch** of in-progress (TAKEN, non-bugged) jobs (`_selectBatch`),
dispatches them to their MAIN flow-v2 modules one at a time and **parks on each
result** — so the v2 loop is paused for the duration of each minigame (the
"JOB-FLOW must stop during Decrypt" rule). Then it falls through to DELAY:30s and
the next cycle picks the next batch.

**Batch selection (`_selectBatch`) — minimise cycles + logins:**

- **`file_decryption` FIRST, one per cycle.** Absolute priority drains every
  TAKEN decrypt (one at a time — each is a separate local minigame, nothing to
  batch and no SAI login to share) before any SAI type, mirroring
  JOB_ACCEPTION's decrypt-first acceptance.
- **else every wired SAI job on ONE server** — grouped by `conditions.serverConfigId`,
  the busiest server wins. All its jobs run back-to-back so the server is
  connected + logged into **once**.

**One login per server.** Each SAI job in a batch is tagged with the same
`batchKey` (`${runToken}:${cycle}:${serverId}`). `_sai-flow.js` `ensureAccess`
establishes access (login-with-grant, or hack) on the FIRST job and every later
job of the batch **reuses that session** (`root.__cor3SaiSession`) instead of
re-connecting + re-logging — gated on the live endpoint still pointing at the
server. A failed access is cached too, so an un-enterable server is not re-hacked
once per job.

**Completes are DEFERRED to the end of an SAI batch.** `job.complete` flips the
endpoint to the market home and back, which tears down the shared SAI session —
so completing mid-batch would log us out before the next job's WS action. While
`deferComplete` is set the flows only ACT (their `complete()` is a no-op); the
endpoint stays on the server for the whole batch, and the orchestrator sends
`job.complete` for every actioned job in one pass at the end (`_completeBatchJobs`),
then reverts to HOME. (READY_TO_COMPLETE, which runs before JOB_FLOW, is the
self-healing net for any complete that fails.) The `file_decryption` pick is NOT
deferred — it has no SAI session, so its flow completes itself as before.

**Dispatch protocol** (v2-only, never the v1 `MSG.JOB.*` channel):

```
orchestrator (isolated) ──FLOW_START { jobId, marketId, jobType, serverId, serverType, serverName, batchKey, deferComplete, <targets> }──▶ flow-v2 module (MAIN)
orchestrator (isolated) ◀──FLOW_RESULT { jobId, marketId, success, didWork, retryable, reason }── flow-v2 module (MAIN)
```

- `success:true, didWork:true`  → flow sent `job.complete` (`MSG.GAME.COMPLETE_JOB`).
- `success:true, didWork:false` → can't do it (e.g. no decrypt capability) → orchestrator `MARK_AS_BUGGED` (`AJV2_BUGGED_JOBS`).
- `success:false`               → runtime failure/timeout → `MARK_AS_BUGGED`.
- timeout (`AJV2.LOOP.FLOW_TIMEOUT_MS`, 5 min) → no result → `MARK_AS_BUGGED`.

While the flow runs it also posts `FLOW_STEP { jobId, node }` per sub-step; the
orchestrator relays it to `AJV2_PIPELINE_STATE`, so the **Flow Map highlights the
live decrypt step** (READ FORMAT → DECRYPT SW? → INSTALL/SWAP → OPEN DOWNLOADS →
SOLVE → COMPLETE, or → MARK_AS_BUGGED). The file_decryption sub-flow is drawn as
its own branch off the JOB_FLOW node.

**`file_decryption` — implemented** (`game/flows/auto-jobs-v2/file-decryption.js`,
id `flow-v2-file-decryption`). The most unique flow, because it manages the
loadout:

1. Parse the file format (extension) from the job's `fileCondition`.
2. `COR3.game.loadout.ensureDecrypt(ext)` (headless API exposed by
   `loadout-panel`): `ready` (equipped already covers it) → proceed; `install`
   (an owned, resource-fitting software covers it) → equip it; `swap` (owned SW
   covers it but needs resources freed) → unequip everything, then equip; `none`
   → return `didWork:false` (→ bugged).
3. Find + open the file **purely over WS** (no DOM scrape): `__cor3DesktopOpenFolder`
   (Downloads, id cached in `__cor3DownloadFolderId`) → match `files[]` by name/ext
   → `__cor3DesktopOpenFile(fileId)`. The raw `open.file` is REQUIRED — a cor3.gg
   update made a DOM double-click open a "File Analysis" info window
   (`desktop.get.file.analysis` → `FileAnalysisProtocolApplication`) instead of the
   minigame; WS `open.file` starts the minigame directly (verified live).
4. Start the standalone solvers (`MSG.SOLVER.START_*`) and wait for the minigame
   (config-hack / ICE WALL / Simple Decrypt) to mount, then to close.
5. Send `job.complete`; report `didWork:true`.

> Status: the WS file-find/open path + the direct minigame launch are verified
> live; the full solve→complete cycle needs a run with the loaded extension.

**Remaining types — TODO:** ip_injection/ip_cleanup (Transit Access),
file_elimination (FILES), log_deletion/log_download (LOGS),
data_download/data_upload (Downloads widget), decrypt_extract (download then
file_decryption logic) — each a new `flow-v2-*` module behind the same protocol,
plus `CLOSE_SAI_TERMINAL`.

### Cross-references in code

| Part | File | Symbol |
|---|---|---|
| Orchestrator / loop | `automation/auto-jobs-v2.js` | `_loop()`, `_runCycle()`, `_ctx()`, `_setNode()` |
| Stages | `automation/auto-jobs-v2/pipeline.js` | `stages.*`, `createPacket()`, `MARKET_SLOTS` |
| Node ids / cadence | `shared/constants.js` | `AJV2.NODE`, `AJV2.LOOP` |
| Flow Map | `ui/sections/auto-jobs-v2/flow-map.js` | `NODES`, `EDGES`, `edgePoints()` |
| Job List | `ui/sections/auto-jobs-v2/job-list.js` | `render()`, `jobRow()` |
| JOB_FLOW dispatch | `automation/auto-jobs-v2.js` | `_runJobFlows()`, `_selectBatch()`, `_dispatchFlow()`, `_completeBatchJobs()`, `_markBugged()` |
| file_decryption flow (MAIN) | `game/flows/auto-jobs-v2/file-decryption.js` | `runFileDecryption()` |
| Loadout API (MAIN) | `game/loadout-panel.js` | `COR3.game.loadout.planDecrypt/ensureDecrypt` (DECRYPT/fileTypes) + `planHack/ensureHack` (HACK/serverTypes) |
| Desktop window helper (MAIN) | `game/desktop-window.js` | `COR3.game.desktop.openApp/openAppAndWait/invokeReactClick/findClickableByText/selectServerTile/findPanelButton` |
| MAIN bridge | `game/auto-jobs-v2-bridge.js` | Open SAI/Market — client-fn window-open + WS connect (`__cor3SetEndpoint`); `saiAccess()` = Active Access (`__cor3SaiGetLoginStatus`/`__cor3SaiLoginWithAccess`) OR hack (`ensureHack` → click hack-tool → solver → grant). No DOM coordinate clicks |

---

## 2. Auto-send-merc

After an expedition completes, open the container, collect the rewards,
optionally pick the cheapest mercenary and re-launch.

```
WS_EXPEDITIONS arrives
   │
   └─ checkOnExpeditionData(expeditions):
       │
       ├─ if no active expeditions AND user enabled:
       │     inProgress = true
       │     awaitingMercenaries = true
       │     post COR3_REQUEST_MERCENARIES (1 s)
       │     [waits for WS_MERCENARIES → onMercenaries]
       │
       └─ for each exp where status==='COMPLETED' AND !completedAt:
              inProgress = true
              expeditionId = exp.id
              if !exp.containerOpenedAt:
                  post COR3_OPEN_CONTAINER (1-1.5 s)
                  [waits for WS_CONTAINER_OPENED → onContainerOpened]
              else:
                  post COR3_COLLECT_ALL
                  [waits for WS_COLLECTED_ALL → onCollectedAll]

onContainerOpened(data):
    spaceNeeded = (data.items || data.containerItems).length
    if stash has space:
        post COR3_COLLECT_ALL (1-1.5 s)
    else:
        autoSendMerc.enabled = false, disabledReason = 'stash_full'
        inProgress = false

onCollectedAll(_):
    expeditionId = null
    post COR3_REQUEST_STASH (500 ms)
    post COR3_REQUEST_MERCENARIES (2.5-3.5 s)
    awaitingMercenaries = true

onMercenaries(data):
    awaitingMercenaries = false
    pick mercenaryId:
        if autoChooseMerc:
            sort by (totalCost asc, riskScore asc)
            pick first AVAILABLE merc with config data
        else:
            use settings.mercenaryId
    proceedWithMerc(mercId, mercs)
        ├─ verify selected merc.status === 'AVAILABLE'
        ├─ read expeditionConfigData → loc/zone/objective IDs
        ├─ Store launchConfig to lastExpeditionLaunchData
        └─ post COR3_LAUNCH_EXPEDITION { config: launchConfig }
              [game emits WS_EXPEDITION_LAUNCHED on success]
              [or WS_EXPEDITION_LAUNCH_ERROR / WS_INSUFFICIENT_CREDITS]

onStash(stash):
    if disabledReason === 'stash_full' AND now has space:
        re-enable auto-send

Watchdog: every 5 s, if inProgress AND age > 120 s → reset
```

### Disable triggers

| Trigger | `disabledReason` |
|---|---|
| Stash full when collecting | `'stash_full'` |
| Insufficient credits on launch | `'insufficient_credits'` |
| Stash full from `WS_STASH_FULL` | `'stash_full'` |

Auto-recover from `'stash_full'` happens on next stash refresh if user
freed at least 2 slots.

---

## 3. Auto-choose-decision

Tick every 10 s. Sees pending decisions; picks the highest-scoring option
once < 60 s remain on the deadline.

```
tick():
    settings = { enabled: autoChooseEnabled, threshold: riskThreshold (0..10) }
    if !enabled: return
    decisions = chrome.storage.local.expeditionDecisions
    for each d:
        skip if d.isResolved
        skip if no decisionDeadline
        skip if no decisionOptions
        skip if d.messageId in chosen (already handled)
        remaining = deadline - now()
        skip if remaining <= 0 or remaining > 60_000

        for each option:
            score = lootModifier - riskModifier * (10 - threshold) / 5
        best = option with max score

        chosen.add(d.messageId)
        post COR3_RESPOND_DECISION { expeditionId, messageId, selectedOption: best.id }
        schedule REQUEST_EXPEDITIONS (3 s) to refresh state
```

`riskWeight = (10 - threshold) / 5` means:
- `threshold = 0`: `weight = 2.0` (risk doubles in cost)
- `threshold = 5`: `weight = 1.0`
- `threshold = 10`: `weight = 0.0` (ignore risk entirely)

---

## 4. Game-flow startup (NM → SC → SAI)

Used by every flow that touches a server (all except `file_decryption`).

```
flow.run(jobId, marketId, serverName, ...):
    flows.setWatching(true)
    sai = await SAI.findOrOpenSai(serverName)
        ├─ closeAllSaiTerminals()
        ├─ NM.ensureNetworkMapOpen(15 s)
        │     ├─ if no ServerItem in DOM: click TabBarItem-NETWORK_MAP
        │     └─ wait for ServerItem to appear
        ├─ SC.connect(serverName)
        │     ├─ findServerItemByName(serverName)
        │     ├─ checkServerKD(item)
        │     │     └─ if hasKD: post COR3_JOB_KD_DETECTED, return false
        │     ├─ click server icon, wait for side-panel name update
        │     ├─ if no LoginIcon: click ConnectIcon, wait 700 ms
        │     ├─ wait up to 12 s for LoginIcon, ConnectIcon (rejected),
        │     │  SAI app (auto-login), or __serverPathFailed (no-path-to-server)
        │     ├─ click LoginIcon
        │     ├─ wait for SaiBottomPanelStyled
        │     ├─ wait for ArrowRightIcon inside SaiActiveAccess (5 s)
        │     └─ click first Active Access entry
        └─ wait up to 15 s for SAI app for serverName

    if sai is null: flows.sendTimeout(jobId, marketId); return

    [navigate to specific tab — Logs/Files/Transit]
    SAI.navigateToSection(sai, SEL.LOGS|FILES|TRANSIT)
    SAI.waitForSaiContent(sai, 5 s)

    [flow-specific work...]

    flows.sendDone(jobId, marketId)  // or sendTimeout
    flows.setWatching(false)
```

Helpers exposed:
- `COR3.game.networkMap.{ensureNetworkMapOpen, findServerItemByName, checkServerKD, listServersOnKD, openServerMarket, scrapeAndPostServers, SEL}`
- `COR3.game.serverConnect.{connect, getSaiForServer}`
- `COR3.game.sai.{findOrOpenSai, navigateToSection, waitForSaiContent, addIpViaModal, downloadsWatcher, find* row helpers, SEL}`
- `COR3.game.flows.{isWatching, setWatching, sendDone, sendTimeout, userLog, startFlow}`
- `COR3.game.desktop.{openApp, openAppAndWait, isAppOpen, invokeReactClick, findClickableByText, findServerTile, selectServerTile, findPanelButton, waitFor}` (v2 bridge — opens windows via React handlers, no DOM coordinate clicks)
- `COR3.game.loadout.{getSnapshot, decryptExtensions, planDecrypt, ensureDecrypt, hackServerTypes, planHack, ensureHack}` (headless capability/install API for the v2 file-decryption flow + the bridge's Open-SAI hack path)

---

## 5. Daily Ops fetch

Triggered three ways:

1. **WS connect** — interceptor's `__cor3InitialFetch()` posts `COR3_FETCH_DAILY_OPS`.
2. **Popup refresh** — Overview tab's "Refresh" button → `chrome.tabs.sendMessage({action: 'fetchDailyOps'})` → `daily-ops.js`.
3. **Post-solve** — when `SOLVER.DAILY_OPS_LOG` carries a line starting with `solved:`, `daily-ops.js` schedules a `fetchOps()` 1.5 s later so the streak/claimed badge flips automatically.

```
fetchOps():
    token = await Store.local.bearerToken      // already prefixed "Bearer …"
    if !token: return null
    GET https://svc-corie.cor3.gg/api/user-daily-claim
        Authorization: <token>

    if 200 ok:
        Store.local.set({
            dailyOpsData: response,            // {currentStreak, nextTaskTime,
                                               //  hasClaimedToday, difficulty,
                                               //  streakBonus, currentGameId}
            dailyOpsUpdatedAt: now,
            dailyOpsError: null,
        })
        fetchRewards(token).catch(noop)

    if 400/401/403:
        Store.local.set({ dailyOpsError: 'token_expired', dailyOpsErrorUpdatedAt: now })

fetchRewards(token):
    GET https://svc-corie.cor3.gg/api/user-daily-claim/rewards
        Authorization: <token>
    if 200: Store.local.dailyRewardsData = response
```

The popup Overview tab subscribes to `dailyOpsData` and `dailyRewardsData`
storage changes; UI updates instantly. Field name is **`currentStreak`**
(not `daily.streak`).

---

## 5a. Daily Ops solve (one-shot)

Triggered by the **Solve** button on the Overview Daily Ops card. The
puzzle lives inside the Game Center window, so a passive watcher can't
react to it without first navigating — a single click does the whole
open → start → decode → submit chain.

```
popup.overview "Solve" click
   ↓ chrome.tabs.sendMessage({action:'solveDailyOps'})
isolated automation/daily-ops.js
   ↓ Bus.window.post(MSG.SOLVER.START_DAILY_OPS)
MAIN solver-daily-ops.runOnce(mod):

    // ── Common entry ────────────────────────────────────────
    if (!DailyOpsMainScreen present):           // already-open shortcut —
        ensureGameCenterOpen():                 // a stray puzzle window
            click TabBarItem-<UUID>             // hides GameCenterApplication;
            wait GameCenterApplication          // re-clicking would toggle
        ensureDailyOpsOpen():                   // the wrong thing
            find .game-center-card whose
                .game-center-card-description
                contains the English brand
                keyword "daily"
            click it
            wait DailyOpsMainScreen
    waitForWsReady('Start')                     // up to 8 s for socket.io
                                                 // to come back from a
                                                 // mid-reconnect flap
    click DailyOpsStartButton                   // server registers session

    // ── Puzzle window opens ─────────────────────────────────
    wait .game-container || GameWaitingScreen
    click any enabled "Get …" button            // /^get \w+/i (English)
    if .game-container .play-button:
        click it                                // renders .pulse-timeline

    // ── Route ───────────────────────────────────────────────
    type = .pulse-timeline → 'signal'
        || (.log-entries|.log-entry|…) → 'log'

    // ── Signal Decode flow ──────────────────────────────────
    pulses = readPulses()                       // S/L per .pulse-group
    pick = chooseEncoding(pulses):              // try both, pick the one
        morse 5-bit (LLLLL=0 … LLLLS=9)         // that yields valid 0-9
        binary 4-bit (SSSS=0 … LSSL=9)          // and pulses.length % size==0
                                                 // tie-break by .input-hint
                                                 // "Code length: N digits"
    click .next-button                          // SELECT ENCODING
    click .encoding-option matching pick.encoding (text contains 'morse'/'binary')
    click .next-button                          // DECODE SIGNAL
    re-read pulses on decode page (cleaner)
    setReactInputValue(.code-input, code)
    waitForWsReady('Submit')
    click .submit-button
    awaitSubmitFeedback():                      // up to 5 s of:
        verified|reward|credits|success → 'ok'  //  → solved log
        failed|invalid|incorrect|try again → 'fail'
        else → 'no server feedback (WS hiccup?)'

    // ── System Log Integrity flow ──
    waitForLogScanComplete(.log-entries):       // puzzle animates rows in
        until count stable for 2 ticks AND      // (.log-entry-appearing);
        no .log-entry-appearing remains         // reading too early gets
                                                 // a partial set and
                                                 // Confirm stays disabled
    parse each .log-entry → analyzeLogLine() →
        issues = [TIME?, TYPE?, MISSING_SECTOR?,
                  MISSING_STATUS?, SECTOR_BAD?, STATUS_BAD?]
    click checkbox on the 2 worst entries
    click .confirm-button                       // "Confirm Selection"
    wait .analysis-container
    for each .error-analysis-block:
        click .fix-error-button
        click .error-type-button per issue:
            byText: matches ERROR_LABELS[issue] (English brand text,
                    works on RU locale today)
            byPosition: ISSUE_BUTTON_INDEX fallback —
                    TIME=0, TYPE=1, MISSING_SECTOR=2, MISSING_STATUS=3,
                    SECTOR_BAD=4, STATUS_BAD=5 (every block renders all
                    6 in this order regardless of which apply)
    click .confirm-button                       // "Confirm Fixes" (same
                                                 // class, different screen)
    wait .scan-button
    waitForWsReady('Submit')
    click .scan-button                          // "Run Re-scan" — actual
                                                 // WS round-trip; server
                                                 // validates the fixes
                                                 // and credits the reward
    wait .result-screen
    if .result-screen.success:
        click .result-screen .retry-button      // "Close" the success card
        closePuzzleWindow()                     // → click ApplicationWindow
                                                 // close-app-btn — without
                                                 // this the puzzle UI
                                                 // auto-rolls a new round
                                                 // (designed for replay)
    else: warn 'server rejected fixes'
```

**Locale-neutral selectors only:** all DOM lookups go through
`data-component-name` / `data-sentry-component` attributes or stable CSS
classes. The intro click on `GameWaitingScreen` clicks whatever the
single enabled button happens to be (it's a label-agnostic "advance"
screen — was "Get Signal" for signal, "Start" for log) so the regex
isn't load-bearing. The only English-keyword couplings left are:
`daily` (card description), `morse` / `binary` (encoding option labels —
matched contains-style on the encoding-option text), `verified|reward|
credits|success` / `failed|invalid|incorrect|try again` (signal
puzzle's `awaitSubmitFeedback` heuristic), and `ERROR_LABELS` (log
puzzle's error-type buttons — currently English even on RU locale, with
a position-based fallback `ISSUE_BUTTON_INDEX` if labels ever
localize).

**WS readiness gate:** `__cor3IsWsReady()` and `__cor3WaitForWs(ms)` are
exposed by the WS interceptor and consumed before each click that
round-trips to the server (Start, Submit). If the active socket is in
mid-reconnect, the click would land server-blind and the puzzle would
hang on a DOM update that never arrives. Gate retries for up to 8 s, then
proceeds best-effort with a UI-log warning so the user knows why the
solve didn't register.

**Solver log:** `SOLVER.DAILY_OPS_LOG` envelopes are mirrored into
`STORAGE_LOCAL.DAILY_HACK_LOG` (key name preserved) so the Overview card
shows the last solver line; `solved:` prefixed messages additionally
reschedule a `fetchOps()` 1.5 s later so the card flips from "pending" to
"claimed" without the user pressing Refresh.

---

## 6. Alarm tick

`src/modules/automation/timers.js` runs every second.

```
tick():
    alarms = chrome.storage.sync.alarms
    for each a in alarms:
        if !a.enabled or a.thresholdSeconds <= 0: continue
        remaining = await getRemaining(a.timerSource)
            // 'daily' → dailyOpsData.nextTaskTime
            // 'home_jobs' → marketData.nextJobsResetAt
            // 'dark_jobs' → darkMarketData.nextJobsResetAt
            // 'exp_<id>' → expedition.endTime
        if remaining is null: continue
        if remaining <= threshold AND remaining > 0 AND !triggered[a.id]:
            triggered[a.id] = true
            if a.continuous: startContinuous(a.volume)
            else: playBeep(a.volume)
        elif remaining > threshold:
            triggered[a.id] = false  // re-arm
```

`startContinuous(vol)` plays a beep every 2 s; `stopContinuous()` clears it.
Popup's Overview tab (under "Add alarm") has Test / Stop-all buttons that
call `chrome.tabs.sendMessage` with `testAlarm` / `stopAlarm` types.

---

## 6a. Market job-board fetch

cor3.gg's market API splits responsibilities across three actions:

| Action | What it returns | Used by us? |
|---|---|---|
| `market.get.options` | `{ market: { id, marketName, sectionFlags }, reputation, userCredits }` — metadata only | No — UI doesn't need it |
| `market.get.lots` | `{ lots: [HARDWARE items] }` — buy section | No |
| `market.get.jobs` | `{ jobs, recentJobs, nextJobsResetAt }` — the job board | **Yes** |

Triggered by:

1. **WS connect** — `__cor3InitialFetch()` calls `__cor3RequestMarket()` then
   `__cor3RequestDarkMarket()` 1 s later.
2. **Popup Refresh** — Overview card → `sendToContent('refreshMarket')` →
   `runtime-bridge` → `MSG.GAME.REFRESH_MARKET` → MAIN → same call.
3. **Auto-refresh** — `automation/auto-refresh.js` ticks the timer and
   posts the same envelope when `nextJobsResetAt` crosses zero.

```
__cor3RequestMarket():
    sendGetJobs(HOME_MARKET_ID)

__cor3RequestDarkMarket():
    sendGetJobs(DARK_MARKET_ID)
    // No network-map.set.endpoint preflight — the server looks up by
    // marketId regardless of current endpoint. Verified by inspecting
    // cor3.gg's own client when the user opens D4RK manually: it sends
    // only join-room + get.{options,lots,jobs}, no set.endpoint at all.
    // An older preflight added 1500ms of delay and could falsely trip
    // darkMarketAvailable=false via no-path-to-server.

sendGetJobs(marketId):
    pendingMarketJobsRequests.push({ marketId, sentAt })
    wsSend market.get.jobs (data: { marketId })
```

The response carries no `marketId` echo, so attribution is FIFO via
`pendingMarketJobsRequests`. Entries auto-expire after 30 s to prevent
queue growth on dropped requests.

```
on incoming market.get.jobs:
    pending = popPendingMarketJobsRequest()      // FIFO
    if pending.marketId === DARK_MARKET_ID:
        post MSG.WS.DARK_MARKET, { market: { marketId, jobs, recentJobs, nextJobsResetAt } }
    else:
        post MSG.WS.MARKET,      { market: { marketId, jobs, recentJobs, nextJobsResetAt } }

on incoming market.get.options or market.get.lots:
    swallow (we don't fetch these proactively, but the cor3.gg client
    does when the user opens Market manually — we don't want them
    polluting marketData)
```

Storage shape ends up flat:

```
chrome.storage.local.marketData = {
    marketId,        // home or dark UUID
    jobs,            // Job[]
    recentJobs,      // Job[] (recently-completed)
    nextJobsResetAt  // ISO timestamp
}
```

`auto-jobs.js` reads `marketData.marketId` directly.

UUIDs (static per cor3.gg deployment, captured by inspecting the WS
frames the site sends when the user opens Market via Network Map):

```
HOME_MARKET_ID = '019d3ea4-85bd-7389-904d-8f7c85841134'
DARK_MARKET_ID = '019d3ea4-85bd-7389-904d-908ba9194aa0'
DARK_SERVER_ID = '019d29c5-4b37-79bf-b23e-304d8ea03c15'   // kept for the
                                                          // set.endpoint
                                                          // unreachable
                                                          // listener
```

---

## 7. Auto-refresh markets

Tick every second. When a market's reset timer crosses zero AND the user
has auto-refresh enabled for that market, post `COR3_REFRESH_*_MARKET`
to MAIN. Hold a 10 s back-off to avoid hammering.

```
tick():
    for each k in ['home_jobs','dark_jobs']:
        if !settings[k]: continue
        if retryPending[k]: continue
        sec = await getSeconds(k)  // see Alarm tick
        if sec !== null AND sec <= 0:
            retryPending[k] = true
            post COR3_REFRESH_MARKET or COR3_REFRESH_DARK_MARKET
            after 10 s: retryPending[k] = false
```

---

## 8. Logger

Per-module ring buffer (200 entries) in `chrome.storage.local.cor3_logs`.
Cross-world bridge:

```
[MAIN module] this.info('msg', ctx)
   → Logger.push(moduleId, 'info', 'msg', ctx)
       └─ HAS_STORAGE = false (MAIN has no chrome.storage)
       └─ Bus.window.post('COR3_LOG_REMOTE', { moduleId, entry })

[isolated entry/content.js]
Bus.window.on('COR3_LOG_REMOTE', ({moduleId, entry}) => {
    Logger.ingest(moduleId, entry);
        └─ HAS_STORAGE = true
        └─ buffer[moduleId].push(entry)
        └─ trim ring (200)
        └─ notify subscribers
        └─ schedule storage flush (500 ms debounce)
})

[popup Logs tab] uiComponents.logViewer.attach(stream)
    ├─ Store.local.onChanged(...) → re-render on cor3_logs change
    └─ initial render: read cor3_logs, sort by ts, paint
```

Logger automatically traces all Bus traffic under module id `bus` if it
was wired before any post (see `bus.js` → `setTrace` and
`logger.js` → installation).
