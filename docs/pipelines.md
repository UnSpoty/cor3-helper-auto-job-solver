# Pipelines

Detailed flow diagrams for the major end-to-end pipelines. For
message-level reference see [messaging.md](messaging.md). For module
contracts see [module-spec.md](module-spec.md).

---

## 1. Auto Jobs

The job pipeline behind the **Auto Jobs** tab (see
[CLAUDE.md → Auto Jobs subsystem](../CLAUDE.md) and
[architecture.md → Auto Jobs subsystem](architecture.md#auto-jobs-subsystem-orchestrator--stages)).

**Shape.** One registered Module — the orchestrator
(`automation/auto-jobs.js`) — owns START/STOP and runs an infinite loop.
Each flowchart box is a plain *stage* object on
`COR3.autoJobs.pipeline.stages.*` (`automation/auto-jobs/pipeline.js`) with
`async run(packet, ctx) -> packet`. A single growing **packet** flows
stage→stage. The orchestrator stamps the active `AJ.NODE.*` onto
`STORAGE_LOCAL.AJ_PIPELINE_STATE` so the popup **pipeline status** readout
(`ui/sections/auto-jobs/flow-map.js` — a compact current-stage + cycle + DELAY
line; the old SVG Flow Map was dropped) labels the live node. Cadence: 10 s
initial delay, then an inter-cycle DELAY of 5 s after a cycle that did real work
(`CYCLE_DELAY_ACTIVE_MS`) or 30 s when idle (`CYCLE_DELAY_MS`), published as
`state.delayMs`. STOP invalidates the in-flight cycle via a generation token.

### Loop (per cycle)

```
START → DELAY:10s → ┌─ GET_SERVERS → CHECK_ACCESS → UPDATE_MARKETS → JOB_QUEUE
                    │   → READY_TO_COMPLETE → DISMISS_FAILED → <QUEUE:EMPTY?>
                    │       YES ───────────────────────────────────────┐
                    │       NO → <HAVE_TASKS_IN_PROGRESS?>             │
                    │              YES → <BUGGED?>                     │
                    │                      YES → JOB:SKIP ─────────────┤
                    │                      NO ─┐                       │
                    │              NO ─────────┴→ CHECK_CONDITION      │
                    │                            → JOB_ACCEPTION       │
                    │                            → JOB_FLOW           │
                    └──── DELAY:5s active / 30s idle ←──────────────────┘  (loop)
```

### Stages (isolated world)

| Node (`AJ.NODE`) | Stage | What it does |
|---|---|---|
| `GET_SERVERS` | `getServers` | reads `NM_GRAPH`; throws loud if the map was never opened (or the envelope predates `connections[]`). Copies `home` + `servers[]` + `connections[]` onto the packet. |
| `CHECK_ACCESS` | `checkAccess` | per server: `accessible` / `hasSaiAccess` / `onCooldown` (from `isInMaintenance`) / `noPath` / `gate` / `gateOpenable`. `noPath` is a transit-rule BFS from HOME via the shared `COR3.autoJobs.reachability.reachableSet`: relay THROUGH a node only if transitable (`!isInMaintenance && (transitType==='public' || accessType!=='none')`); a non-transitable node is an endpoint-only leaf. NOT the game's `canSetEndpoint` flag — that is stale on transient K/D (a server behind a freshly-K/D'd transit node keeps `canSetEndpoint:true` while `set.endpoint` returns `no-path`; verified live), so we recompute off the live `isInMaintenance`/`transitType`/`accessType`. Throws if HOME isn't in `servers[]` (stale/broken envelope). **Transit-hack (`AJ_MASTER_SWITCHES.behaviour.hackTransitNodes`, default OFF):** when ON, for each `noPath` server `gateOnPath` (a transit-rule BFS: relay through `public` OR `accessType!=='none'` nodes, not K/D) finds the nearest *openable* gate — a non-public/no-access/non-maintenance node — and stamps `gate {id,name,serverType,serverDefenceRate,hackable}` (+ `gateOpenable` when owned-hackable and not in `AJ_BUGGED_GATES`). Does **not** decide market reachability — that is the OUTPUT of UPDATE_MARKETS' refresh probe (see below). |
| `UPDATE_MARKETS` | `updateMarkets` | refresh **every routable** market every cycle: a remote market whose own server (`C.MARKETS[].serverId`) has `noPath` in the graph this cycle is skipped outright (`reason:'no-path'` — the probe could only fail and would burn its timeout; re-checked next cycle, so it self-heals). Otherwise: post `MSG.GAME.REFRESH_*`, await a fresh frame (≤6 s; the `atKey` bumps on both a job frame and an unreachable error, so the wait resolves either way), then read the envelope. Probe reachability is the probe's OUTPUT — home is always reachable; a remote market flips its `*_AVAILABLE` flag false on a market-not-reachable `get.jobs`, recorded with a reason (a transient failure self-heals next cycle — gating the refresh on a stored flag made one transient miss stick forever). Pulls `jobs[]` (tag `status:'AVAILABLE'`) and the `recentJobs[]` TAKEN (`status:'TAKEN'`) + FAILED (`status:'FAILED'`) entries. |
| `JOB_QUEUE` | `jobQueue` | normalises rawJobs → queue entries `{id, name, type, status, serverName, marketSlot, marketId, rewardCredits, eligible, skipReason}`; writes `AJ_JOB_QUEUE` for the UI. |
| `READY_TO_COMPLETE` / dismiss | (orchestrator) | `_completeReadyJobs` completes any TAKEN job the game flags `canComplete`; `_dismissFailedJobs` then `market.job.dismiss`-es every FAILED job **iff** `AJ_MASTER_SWITCHES.behaviour.autoDismissFailed` is on (default OFF). Both run here with the endpoint at home, before any SAI flow. |
| `QUEUE_EMPTY?` | (orchestrator) | empty board+in-progress → fall through to DELAY and loop. |
| `HAVE_TASKS_IN_PROGRESS?` | (orchestrator) | any queue job with `status==='TAKEN'`. |
| `BUGGED?` | `buggedJobs` + orchestrator | reads `AJ_BUGGED_JOBS`; if every in-progress job is bugged → `JOB:SKIP` (skip the cycle). |
| `CHECK_CONDITION` | `checkCondition` | per job, eligibility + explicit `skipReason`. Wired conditions: bugged registry; and (only when the job has a server) server-known / K-D cooldown / no-path / accessible / user-SKIP / type-disabled (`AJ_SERVER_OVERRIDES`). `noPath` is a hard skip **unless** the server is `gateOpenable` (transit-hack ON + an owned-hackable gate on the route) — then it is downgraded to a non-blocking WARN (`dataWarnReason`), exactly like not-accessible-but-hackable, so the job stays eligible and the orchestrator opens the route before working it. A missing related server is **not** a skip reason. |
| `JOB_ACCEPTION` | `jobAcception` | **sequential, one server at a time** (mirrors `_selectBatch` execution). (1) **Hold** while any *workable* TAKEN wired job exists (`!bugged && jobServerReachable`) — accept nothing until JOB_FLOW drains the current server's batch, so the accepted backlog never spans more than the one server being worked. (2) else if any eligible `file_decryption` is AVAILABLE → accept ALL of them across ALL markets (no target server, absolute priority; executor drains one minigame/cycle). (3) else accept **ONE server's group** of eligible AVAILABLE SAI jobs — grouped by `conditions.serverConfigId`, busiest server wins. Posts `MSG.GAME.ACCEPT_JOB` paced 1.2 s apart, then `MSG.GAME.REVERT_ENDPOINT_TO_HOME` once. Confirmation is async — accepted jobs reappear as `TAKEN` next cycle. The hold-gate counts only *reachable* TAKEN jobs: a TAKEN job on a K/D-cooldown / no-path / inaccessible server is POSTPONED by `_runJobFlows` (never bugged), so counting it would stall ALL acceptance. |

### `JOB_FLOW` (MAIN world)

After JOB_ACCEPTION the orchestrator runs `_runJobFlows()`: it selects THIS
cycle's **batch** of in-progress (TAKEN, non-bugged) jobs (`_selectBatch`),
dispatches them to their MAIN flow modules one at a time and **parks on each
result** — so the loop is paused for the duration of each minigame (the
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

**Unreachable TAKEN jobs are POSTPONED, not failed.** Before selecting a batch,
`_runJobFlows` drops any TAKEN SAI job whose target server is on K/D cooldown or
not accessible this cycle (`pipeline.jobServerReachable` — `file_decryption` and
servers absent from the graph always pass). A postponed job stays `TAKEN` and
untouched (retry budget intact, never bugged); it runs unchanged the moment its
server is reachable again. **This same `jobServerReachable` predicate gates
JOB_ACCEPTION's hold (item 1 above)** — so an un-workable TAKEN job neither
consumes a flow attempt nor blocks acceptance of other servers' jobs.

**Route-opening (transit-hack, `hackTransitNodes` ON).** A server reachable only
through a hackable transit gate is `gateOpenable` (so `jobServerReachable` lets
its jobs through). After `_selectBatch` picks such a server, `_runJobFlows` calls
`_openRoute(gate)` BEFORE dispatching the batch: it posts `MSG.AUTOJOBS.HACK_TRANSIT`
and parks on `HACK_RESULT` (same post-and-park as `_dispatchFlow`). The MAIN
bridge connects to the gate and hacks it (`loadout.ensureHack` vs the gate's LIVE
`serverDefenceRate` — the authoritative power-feasibility check; **no** SAI login
after, only the access grant is needed to relay through). On success the route is
open and the batch dispatches (the destination flow then hacks the destination
itself — a second, separate hack). A transient gate failure retries up to
`MAX_FLOW_ATTEMPTS` (keyed `gate:<name>`); a PERMANENT one (`planHack`
`none`/`underpower`) records the gate in `AJ_BUGGED_GATES` (cleared each START)
so CHECK_ACCESS stops offering it and the server reverts to a hard `noPath`.

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

**Dispatch protocol:**

```
orchestrator (isolated) ──FLOW_START { jobId, marketId, jobType, serverId, serverType, serverName, batchKey, deferComplete, <targets> }──▶ flow module (MAIN)
orchestrator (isolated) ◀──FLOW_RESULT { jobId, marketId, success, didWork, retryable, reason }── flow module (MAIN)
```

`<targets>` are the per-type resolved targets, all from the TAKEN job's
condition: `fileCondition` + `requiredPower` for file_decryption; `ips` for
ip_*; `fileNames` + `files` (`{id,name,ext}` descriptors) for the file SAI types,
plus `requiredPower` for decrypt_extract; `logSeqs` + `logNames` for log_*.

- `success:true, didWork:true`  → flow sent `job.complete` (`MSG.GAME.COMPLETE_JOB`).
- `success:true, didWork:false` → can't do it (e.g. no decrypt capability) → orchestrator `MARK_AS_BUGGED` (`AJ_BUGGED_JOBS`).
- `success:false`               → runtime failure/timeout → `MARK_AS_BUGGED`.
- timeout (`AJ.LOOP.FLOW_TIMEOUT_MS`, 5 min) → no result → `MARK_AS_BUGGED`.

While the flow runs it also posts `FLOW_STEP { jobId, node }` per sub-step; the
orchestrator relays it to `AJ_PIPELINE_STATE`, so the **pipeline status shows the
live flow step** (file_decryption: READ FORMAT → DECRYPT SW? → INSTALL/SWAP →
OPEN DOWNLOADS → SOLVE → COMPLETE, or → MARK_AS_BUGGED; the SAI types report
ACCESS → ACTION → COMPLETE, plus the shared SAI_HACK step when there is no Active
Access grant).

**`file_decryption`** (`game/flows/auto-jobs/file-decryption.js`,
id `flow-file-decryption`). The most unique flow, because it manages the
loadout:

1. Parse the file format (extension) from the job's `fileCondition`, and read
   `requiredPower` — the file's CRYPT RATE, the upper bound `hi` of the decrypt
   condition's `encryptionLevel:[lo,hi]` band
   (`pipeline.requiredPowerForDecrypt`, passed on FLOW_START). `0` = no band on
   the job → no power gate (the flow logs a warn and accepts any covering
   software).
2. `COR3.game.loadout.ensureDecrypt(ext, requiredPower)` (power-aware headless
   API exposed by `loadout-panel`): picks owned software whose DECRYPT power band
   max ≥ `requiredPower` (preferring already-equipped/cheapest), installs it
   ALONGSIDE the current rig when it fits, frees other software only when it
   doesn't, and swaps in the best owned hardware per slot to raise
   `computedPower` if still short. Statuses: `ready` (equipped already covers it)
   → proceed; `install`/`swap` → equip it; `none` (no owned software covers the
   ext) and `underpower` (owns covering software but no SW+HW combo reaches the
   CRYPT RATE) → return `didWork:false` (→ bugged, non-retryable); `unknown` /
   `no-helper` (timing races) → retry next cycle.
3. Find + open the file **purely over WS** (no DOM scrape): `__cor3DesktopOpenFolder`
   (Downloads, id cached in `__cor3DownloadFolderId`) → match `files[]` by name/ext
   → `__cor3DesktopOpenFile(fileId)`. The raw `open.file` is REQUIRED — a cor3.gg
   update made a DOM double-click open a "File Analysis" info window
   (`desktop.get.file.analysis` → `FileAnalysisProtocolApplication`) instead of the
   minigame; WS `open.file` starts the minigame directly (verified live).
4. Start the standalone solvers (`MSG.SOLVER.START_*`) and wait for the minigame
   (config-hack / ICE WALL / Simple Decrypt) to mount, then to close.
5. Send `job.complete`; report `didWork:true`.

**SAI flow types** — the other 8 flows each touch a server and share the
`_sai-flow.js` base factory: connect (`__cor3SetEndpoint`) + Active-Access /
hack login (`ensureAccess`, reused across a server's batch), then the
`get.*` / `mutate.*` WS loop, then `job.complete` (deferred to the end of the
SAI batch — see above). By job type:

- **ip_injection / ip_cleanup** — Transit Access: add / remove IPs.
- **file_elimination** — delete files.
- **data_download / data_upload** — download / upload files. cor3.gg names the
  SAME file three ways (condition NAME / server `get.files` NAME / local Downloads
  NAME differ — only the fileId and the base name *stem* are stable), so these
  carry `{id,name,ext}` descriptors (`pipeline.fileDescriptorsForJob`) and the
  flow resolves the source file by **id → exact name → stem(+declared ext)** via
  the shared `h.resolveFile` (`_sai-flow.js`), never assuming the condition's
  name is the real one. data_upload's DTO is `{serverId, name, sizeMb}` (a local
  Downloads fileId means nothing on the target server); `sizeMb` defaults to 1
  (`DEFAULT_UPLOAD_SIZE_MB`) since the post-patch Downloads file object dropped
  the `sizeMb` field.
- **log_download / log_deletion** — download / delete logs (rejected up-front for
  the `NO_LOGS_SERVERS` D4RK servers that have no Logs section).
- **decrypt_extract** — SAI download + decrypt-SW install/swap + the decrypt
  minigame solve. Resolves the SERVER file and the LOCAL Downloads file by
  id → name → stem (same `h.resolveFile`), downloads it if it isn't local yet,
  then decrypts by the LOCAL file's REAL extension. It carries the SAME decrypt
  `requiredPower` gate as file_decryption (the extract half opens the file's
  minigame, so the loadout must clear the CRYPT RATE first).

### Cross-references in code

| Part | File | Symbol |
|---|---|---|
| Orchestrator / loop | `automation/auto-jobs.js` | `_loop()`, `_runCycle()`, `_ctx()`, `_setNode()` |
| Stages | `automation/auto-jobs/pipeline.js` | `stages.*`, `createPacket()`, `MARKET_SLOTS` |
| Node ids / cadence | `shared/constants.js` | `AJ.NODE`, `AJ.LOOP` |
| Pipeline status | `ui/sections/auto-jobs/flow-map.js` | `attach()`, `renderState()`, `LABELS` |
| Job List | `ui/sections/auto-jobs/job-list.js` | `render()`, `jobRow()` |
| JOB_FLOW dispatch | `automation/auto-jobs.js` | `_runJobFlows()`, `_selectBatch()`, `_dispatchFlow()`, `_completeBatchJobs()`, `_markBugged()` |
| file_decryption flow (MAIN) | `game/flows/auto-jobs/file-decryption.js` | `runFileDecryption()` |
| Loadout API (MAIN) | `game/loadout-panel.js` | `COR3.game.loadout.planDecrypt(ext, requiredPower)/ensureDecrypt(ext, requiredPower, log)` (DECRYPT/fileTypes, power-aware: SW+HW to clear the CRYPT RATE, status `underpower` when unreachable) + `planHack/ensureHack` (HACK/serverTypes) |
| Desktop window helper (MAIN) | `game/desktop-window.js` | `COR3.game.desktop.openApp/openAppAndWait/invokeReactClick/findClickableByText/selectServerTile/findPanelButton` |
| MAIN bridge | `game/auto-jobs-bridge.js` | Open SAI/Market — client-fn window-open + WS connect (`__cor3SetEndpoint`); `saiAccess()` = Active Access (`__cor3SaiGetLoginStatus`/`__cor3SaiLoginWithAccess`) OR hack (`ensureHack` → click hack-tool → solver → grant). No DOM coordinate clicks |

---

## 2. Auto-send-merc

Balance-latched engine: while armed it keeps ONE expedition running with the
cheapest eligible mercenary across all enabled markets, auto-opening and
collecting each completed run. Driven by
`STORAGE_SYNC.EXPEDITIONS_SETTINGS.autoSend`
`{ enabled, moneyMin, moneyMax, minCost, maxCost, insurance,
includeElite, marketsDisabled[] }` under the tab-wide `masterEnabled` gate.

```
evaluate()  ← on WS_EXPEDITIONS / WS_MERCENARIES / WS_PROFILE, settings
              change, container/collect events, and a 20 s poll
   │
   ├─ COMPLETED run present?
   │     not opened → OPEN_CONTAINER      (FULL_SUCCESS auto-opens even with
   │     opened + uncollected + auto-send │  auto-send off — master-only)
   │        → COLLECT_ALL (pays the remaining, banks loot, frees the slot)
   │
   ├─ balance latch: armed at balance ≥ moneyMax, disarmed at ≤ moneyMin
   ├─ any non-COMPLETED expedition → wait (server allows max 1 active)
   │
   ├─ POOL: for each market NOT in marketsDisabled with a launchable config
   │        (get.config returned ≥1 location):
   │        • every mercenaries[] entry with status AVAILABLE
   │        • includeElite: every eliteSlots[] entry with state UNLOCKED and
   │          an embedded mercenary.status AVAILABLE — an unlocked elite is a
   │          STANDARD merc on the wire (launches via ordinary configure/
   │          launch with eliteSlots[].mercenary.id; verified live 2026-07-05)
   │        priced by MERC_CONFIG (the interceptor's configure cascade);
   │        an entry only counts when its `_insured` flag matches the current
   │        insurance setting (flipping the setting re-prices, never mixes)
   │
   ├─ COST BAND (each side 0 = off): minCost ≤ totalCost ≤ maxCost
   │        (no send-side risk knob — raid risk appetite is the auto-choose
   │        Risk-threshold slider's job; riskScore only tie-breaks equal costs)
   ├─ sort by (totalCost asc, riskScore asc) → pick cheapest
   └─ LAUNCH_EXPEDITION { mercenaryId, marketId, locationConfigId,
          zoneConfigId, goalId, hasInsurance: autoSend.insurance }
          [WS_EXPEDITION_LAUNCH_ERROR / WS_INSUFFICIENT_CREDITS → back off]

Soft pauses (disabledReason): 'stash_full' (auto-clears when the stash frees
≥2 slots), 'insufficient_credits'.
```

**Insurance.** `autoSend.insurance` governs EVERY plugin launch (auto-send
AND the popup's manual "Send now" via runtime-bridge). The engine pushes the
flag to MAIN over `MSG.GAME.EXP_PREVIEW_PREFS`; the interceptor's cost-preview
cascade then sends `configure {…, hasInsurance:true}` so each merc's stored
`totalCost` INCLUDES the premium (`insuranceCost`, ~30% of base — the reply
returns `insuranceCost:0` unless the preview asked with insurance, verified
live) and stamps `_insured` on the `MERC_CONFIG` entry via the
`WS_MERC_CONFIGURE` envelope. The cost band therefore filters the REAL spend.

**The launch rides the same configure chain.** `__cor3LaunchExpedition` used
to fire a bare `configure` OUTSIDE `configureChain` and `launch` ~1 s later.
That broke twice over: the bare configure's reply settle()-d whatever preview
was in flight (another merc inherited the launched merc's price — the exact
mis-attribution the chain exists to kill), and because `evaluate()` launches
off the same roster deliveries that start preview cascades, cascade configures
for OTHER mercs landed between the launch's configure and the launch frame —
clobbering the configure state and launching an insured pick UNINSURED. Now
the whole sequence is one chain step: configure → reply ack (re-prices the
launched merc, correctly attributed, `_insured` stamped) → `launch` → release
the chain. A dropped/timed-out ack ABORTS the launch
(`WS_EXPEDITION_LAUNCH_ERROR {error:'configure-timeout'}`); any other launch
rejection is surfaced on the same envelope instead of the old silent
fall-through to `WS_EXPEDITION_LAUNCHED` with no data.

### Disable triggers

| Trigger | `disabledReason` |
|---|---|
| Stash full when collecting | `'stash_full'` |
| Insufficient credits on launch | `'insufficient_credits'` |
| Stash full from `WS_STASH_FULL` | `'stash_full'` |

Auto-recover from `'stash_full'` happens on next stash refresh if user
freed at least 2 slots.

### Wire notes (post-patch)

- **`expeditions.get.config` now REQUIRES a `marketId`** (server: "Validation
  failed: marketId must be a string") — `__cor3RequestExpeditionConfig(marketId)`
  defaults to `C.HOME_MARKET_ID`. The interceptor parses `zones[].goals[]`
  (was `zones[].objectives[]`) into `__cor3ExpConfigIds =
  {locationConfigId, zoneConfigId, goalId}`; the configure/launch DTO field is
  `goalId` (the server rejects the old `objectiveId`).
- **`get.mercenaries` replies carry NO `marketId`**, so the interceptor
  SERIALIZES requests through `mercFetchChain` (one in-flight slot) and matches
  each reply to the lone in-flight request; unsolicited pushes are dropped and a
  dropped / 12 s-timed-out request advances the chain. `__cor3RequestAllMercenaries()`
  fetches mercenaries for EVERY market in `C.MARKETS` (each is its own faction;
  `get.mercenaries` works by `marketId` without connecting to the server) — used
  by the Expeditions tab's per-market roster, not the auto-send loop above (which
  fetches only HOME via `COR3_REQUEST_MERCENARIES`).

---

## 3. Auto-choose-decision

Tick every 10 s (gated by the Expeditions master switch + `autoChooseEnabled`).
Answers every pending decision PROMPTLY — `decisionDeadline` is `null` on the
wire and the raid pauses at `status:EVENT` until answered, so there is no
countdown to gate on. A dropped RESPOND_DECISION retries after 15 s (per-message
attempt map, pruned when the decision disappears).

```
tick():
    threshold = riskThreshold (0..10)
    for each unresolved decision d (skip if attempted < 15 s ago):
        { best } = COR3.expDecision.pick(d.decisionOptions, threshold)
        post COR3_RESPOND_DECISION { expeditionId, messageId, selectedOption: best.id }
        schedule REQUEST_EXPEDITIONS (3 s) to refresh state
```

Scoring is the SHARED `src/shared/exp-decision-score.js` (`COR3.expDecision`
— the popup's Pending-decisions list renders the same per-option scores and
✓-marks the would-be pick, so UI and engine can never disagree):

    score = lootModifier − riskModifier × (10 − threshold)

- `threshold = 0`:  weight 10 — risk-averse: a +10-risk option needs +100 loot
  to break even (never happens live; loot runs ±20..50, risk ±5..10)
- `threshold = 5`:  weight 5 — risk ±10 genuinely competes with loot ±50
- `threshold = 10`: weight 0 — pure loot-max, risk ignored
- ties break toward the LOWER riskModifier

History: the old weight `(10 − threshold)/5` maxed at 2, so with the wire's
asymmetric scales the big-loot (risky) option won at EVERY slider position —
the "auto-choose always picks the risky option" bug (fixed 2026-07-05). A
second bug survived that fix: the engine's `Number(threshold) || 5` swallowed
a slider at 0 into the 5 default, so max risk-aversion actually ran at weight 5
("loot +50 / risk +5" scored +25 and still beat the safe option) while the
popup previewed the true 0 — engine and ✓-mark disagreed. Normalization now
lives ONLY in `COR3.expDecision.clampThreshold` (0 is valid; non-finite → 5),
used by both the engine and `score()` itself (fixed 2026-07-06).

---

## 4. SAI flow startup (pure WS — no DOM scrape)

Used by every flow that touches a server (all except `file_decryption`). All 8
SAI flows are built by the `_sai-flow.js` factory (`defineFlow`) and run almost
entirely over WS — the only screen interaction is the hack path (which needs the
SAI terminal window open to click the hack-tool row). There is NO
NetworkMap/SAI DOM-scrape layer anymore (`COR3.game.networkMap` /
`serverConnect` / `sai` / `flows` no longer exist).

```
spec.run(env, helpers):                     // env = FLOW_START payload
    step(<P>_ACCESS)                          // pipeline-status sub-step
    a = await ensureAccess(serverId, serverType, serverName)
        │  // batch-aware: reuse one server's login across its whole batch,
        │  // gated on the live endpoint + epoch still pointing at the server
        ├─ __cor3SetEndpoint(serverId)                    // network-map.set.endpoint
        ├─ status = await __cor3SaiGetLoginStatus(serverId)  // activeAccesses[]+hackTools[]
        ├─ grant = pickGrant(status)                      // task_access grant
        ├─ if grant:  __cor3SaiLoginWithAccess(serverId, grant.id)   // headless, no window
        └─ else (no grant) → hackForAccess():             // surfaced as SAI_HACK step
              ├─ openAppAndWait('NETWORK_MAP') + selectServerTile(serverName)
              ├─ click Login → ensureHack(serverType) installs HACK software
              ├─ click the hack-tool row → startSolvers() → standalone solver wins
              └─ pollForGrant(serverId) → __cor3SaiLoginWithAccess(serverId, grant.id)
    if !a.ok: return { success:false, retryable:a.retryable, reason:a.reason }

    step(<P>_<ACTION>)
    list = await getTransit|getFiles|getLogs(serverId)    // __cor3SaiGet* over WS
    for each target:
        await awaitAction(() => __cor3SaiTransitAdd/Remove | File/LogDownload/Delete(...))

    step(<P>_COMPLETE)
    helpers.complete()        // job.complete now, OR a no-op when deferComplete
    return { success:true, didWork:true }
```

**Helpers handed to `spec.run`** (from `_sai-flow.js`):
`{ root, dom, C, MSG, sleep, say, step, abort, ensureAccess, awaitBus,
awaitAction, getTransit, getFiles, getLogs, findDownloadsFileId, findDownloadsFile,
listDownloads, resolveFile, parseExt, stemOf, normExt, startSolvers,
stopSolvers, findMinigame, complete }`. The file-name resolution helpers
(`listDownloads` = the raw Downloads `files[]` over WS; `resolveFile(files, desc,
idKey)` = match by id → exact name → stem(+declared ext); `parseExt` / `stemOf` /
`normExt`) are also exposed on the `COR3.autoJobs.saiFlow` namespace so
data_upload + decrypt_extract resolve cor3.gg's inconsistent file names the same
way.

The WS RPC helpers themselves live on `window.__cor3Sai*` /
`window.__cor3Desktop*` (in `interceptors/ws-interceptor.js`); window-opening
goes through the bridge's `COR3.game.desktop` helper:
- `COR3.game.desktop.{openApp, openAppAndWait, isAppOpen, invokeReactClick, findClickableByText, findServerTile, selectServerTile, findPanelButton, waitFor}` (opens windows via React handlers + one targeted server-tile tap — no DOM coordinate clicks)
- `COR3.game.loadout.{getSnapshot, decryptExtensions, planDecrypt(ext, requiredPower), ensureDecrypt(ext, requiredPower, log), hackServerTypes, planHack, ensureHack}` (headless capability/install API for the file-decryption flow + the SAI hack path; `planDecrypt`/`ensureDecrypt` are power-aware — they swap software + hardware to clear the file's CRYPT RATE and return `underpower` when no owned combo can)

---

## 5. Daily Ops fetch

Triggered four ways:

1. **WS connect** — interceptor's `__cor3InitialFetch()` posts `COR3_FETCH_DAILY_OPS`.
2. **Legacy `fetchDailyOps` action** — kept for back-compat (the Overview card's
   manual Refresh button has been replaced by the **Auto** toggle, see 5b).
3. **Post-solve** — when `SOLVER.DAILY_OPS_LOG` carries a line starting with `solved:`, `daily-ops.js` schedules a `fetchOps()` 1.5 s later so the streak/claimed badge flips automatically.
4. **Auto watcher** (see 5b) — its poll tick re-fetches whenever the snapshot
   can't be trusted to reflect "solved today".

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
        finishWidgets()                         // closes the puzzle window
                                                 // (else the puzzle UI auto-
                                                 // rolls a new round) PLUS the
                                                 // Daily Ops + Game Center
                                                 // windows — solving leaves a
                                                 // clean desktop (manual + auto)
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

## 5b. Daily Ops Auto watcher

The Overview card's old **Refresh** button is replaced by an **Auto** toggle
(`STORAGE_SYNC.AUTO_DAILY_OPS_ENABLED`, default OFF). When on, the isolated
`automation/daily-ops.js` runs a poll loop that auto-launches the solver (5a)
whenever the daily reset timer reaches 00:00 or the day is still unsolved.

```
toggle ON (popup → settingChanged + storage.sync) → startAuto():
    setInterval(autoTick, 60 s)  +  one initial tick after 8 s

autoTick():                                      // skipped while a solve is
    if !enabled || inFlight || now < cooldown: return   // in flight / cooling

    daily = Store.local.dailyOpsData
    timerHitZero = !daily.nextTaskTime || now >= Date(daily.nextTaskTime)
    looksSolved  = daily.hasClaimedToday === true

    if timerHitZero || !looksSolved:             // snapshot can't be trusted —
        fresh = await fetchOps()                 // confirm against the server
        if fresh: daily = fresh
        else if timerHitZero:                    // REST down (typ.: the captured
            // bearer token expired mid-session while the WS stayed up — the
            // watcher used to stall here FOREVER, silently). The rolled-over
            // timer alone proves a new day → BLIND LAUNCH off that signal;
            // the in-game screen is the claimed/unclaimed authority. Latched
            // once per 24h window counted from the stale nextTaskTime; a
            // failed run clears the latch so the post-cooldown tick retries.
            if blindLaunchKey != dayKey: blindLaunchKey = dayKey; launch()
            return
    if !daily: return                            // no token, timer not rolled over

    if daily.hasClaimedToday === false:          // ← the precise launch condition
        inFlight = true
        watchdog = setTimeout(4 min)             // clears inFlight + sets a
                                                 // 15-min fail cooldown if no
                                                 // terminal result ever arrives
        Bus.window.post(START_DAILY_OPS)         // same entrypoint as manual Solve

// terminal result — DAILY_OPS_RESULT { ok }, posted by the solver's finally
// on EVERY outcome (soft failures like "Start button missing" included, which
// previously emitted no terminal log line and leaked the latch to the watchdog):
//   ok=true   → cancel watchdog, inFlight=false, re-fetch 1.5s later (flips
//               hasClaimedToday → true, which gates further triggers)
//   ok=false  → cancel watchdog, inFlight=false, cooldown = now + 15 min,
//               blind-launch latch cleared (retry allowed after cooldown)
```

Acceptance is self-gating: when already claimed with the timer in the future,
`autoTick` does **no** fetch and **no** trigger (zero API traffic). The solver's
`finishWidgets()` closes the puzzle + Daily Ops + Game Center windows after the
reward is claimed (5a) on **every** solve (manual and auto), so a run leaves a
clean desktop. The MAIN solver's `busy` guard is a second line of defence
against re-entrant launches.

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
            // 'srm_jobs'  → srmMarketData.nextJobsResetAt
            // 'usol_jobs' → usolMarketData.nextJobsResetAt
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

1. **WS connect** — `__cor3InitialFetch()` calls `__cor3RequestMarket()`
   immediately, then `__cor3RequestDarkMarket()` / `__cor3RequestSrmMarket()` /
   `__cor3RequestUsolMarket()` staggered ~1 s later (serialised through
   `inflightRemoteFetch`).
2. **Popup Refresh** — Overview card → `sendToContent('refreshMarket')` →
   `runtime-bridge` → `MSG.GAME.REFRESH_MARKET` → MAIN → same call.
3. **Auto-refresh** — `automation/auto-refresh.js` ticks the timer and
   posts the same envelope when `nextJobsResetAt` crosses zero.

```
__cor3RequestMarket():
    sendGetJobs(HOME_MARKET_ID)               // home needs no endpoint flip

__cor3RequestDarkMarket() / __cor3RequestSrmMarket() / __cor3RequestUsolMarket():
    fetchRemoteMarketSequence(<MARKET_ID>, <SERVER_ID>)
    // serialised via inflightRemoteFetch — one remote fetch at a time:
    //   set.endpoint(serverId) → get.jobs(marketId) → revert endpoint to HOME.
    // A set.endpoint that returns no-path-to-server posts
    //   MSG.WS.<MARKET>_UNREACHABLE (flips the *_AVAILABLE flag false) instead.

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
    cfg = MARKET_BY_ID[pending.marketId]         // home / dark / srm / usol
    post cfg.busType (MSG.WS.MARKET | DARK_MARKET | SRM_MARKET | USOL_MARKET),
         { market: { marketId, jobs, recentJobs, nextJobsResetAt } }

on incoming market.get.options or market.get.lots:
    swallow (we don't fetch these proactively, but the cor3.gg client
    does when the user opens Market manually — we don't want them
    polluting marketData)
```

Storage shape ends up flat:

```
chrome.storage.local.marketData = {
    marketId,        // home / dark / srm / usol UUID
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
SRM_MARKET_ID  = '019da731-2db5-7d76-9447-1ea3b9b78001'   // SRM7-M (SOYUZ)
SRM_SERVER_ID  = '019da6f1-16f7-75a6-b6d3-0b1d5f92a108'
USOL_MARKET_ID = '019e4065-6ae8-760d-8724-58ab4f2cf7d7'   // URM7-M (USOL)
USOL_SERVER_ID = '019e4052-c317-7388-9d71-883ffb1560cd'
```

---

## 7. Auto-refresh markets

Tick every second. When a market's reset timer crosses zero AND the user
has auto-refresh enabled for that market, post `COR3_REFRESH_*_MARKET`
to MAIN. Hold a 10 s back-off to avoid hammering.

```
tick():
    for each k in ['home_jobs','dark_jobs','srm_jobs','usol_jobs']:
        if !settings[k]: continue
        if retryPending[k]: continue
        sec = await getSeconds(k)  // see Alarm tick
        if sec !== null AND sec <= 0:
            retryPending[k] = true
            post COR3_REFRESH_MARKET / _DARK_MARKET / _SRM_MARKET / _USOL_MARKET
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
