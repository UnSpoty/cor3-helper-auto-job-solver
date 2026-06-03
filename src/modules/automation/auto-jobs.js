// Auto Jobs — orchestrator.
//
// The one registered module for the Auto Jobs subsystem (id 'auto-jobs', so all
// its logs and the stages' logs land in the Activity Log). It does NOT
// implement job logic itself — it drives the flowchart:
//
//   START → DELAY:10s → ┌─ GET_SERVERS → CHECK_ACCESS
//                       │   → UPDATE_MARKETS → JOB_QUEUE → READY_TO_COMPLETE
//                       │   → DISMISS_FAILED → <QUEUE:EMPTY?>
//                       │     YES ───────────────────────────────────────┐
//                       │     NO → <HAVE_TASKS_IN_PROGRESS?>              │
//                       │            YES → <BUGGED_JOBS?>                 │
//                       │                    YES → JOB:SKIP ─┐            │
//                       │                    NO  ────────────┤            │
//                       │            NO ──────────────────────┴→ CHECK_CONDITION
//                       │                            → JOB_ACCEPTION      │
//                       │                            → JOB_FLOW            │
//                       └──────────────── DELAY ←──────────────────────────┘  (loop)
//
// NOTE: JOB:SKIP does NOT end the cycle — it only skips JOB_FLOW for the
// (all-bugged) in-progress jobs and still falls through to CHECK_CONDITION /
// JOB_ACCEPTION so fresh AVAILABLE work keeps being accepted.
//
// The inter-cycle DELAY is 30s when idle, but a short CYCLE_DELAY_ACTIVE_MS
// (~5s) when the cycle did real work (a flow batch ran, or jobs were accepted) —
// so a chain of in-progress jobs isn't gated by 30s of dead air between each.
// The actual delay in effect is published as state.delayMs so the pipeline
// status's DELAY countdown reflects the real wait (5s vs 30s), not a hard-coded 30s.
//
// JOB_FLOW dispatches a BATCH of in-progress (TAKEN) jobs per cycle, then parks
// on each one's FLOW_RESULT in turn — so the loop pauses for each minigame,
// then goes to the inter-cycle DELAY. The batch is chosen to minimise cycles + logins:
// file_decryption FIRST (every TAKEN one — local minigames, no server), else
// every wired SAI job that targets ONE server (the busiest), run back-to-back
// so that server is connected + logged into ONCE (the SAI flows share the login
// via the per-batch session, keyed `${cycle}:${serverId}`). Failure handling
// is per job and splits by `retryable`: a job that is
// genuinely undoable (no owned decrypt software, malformed job) is written to
// AJ_BUGGED_JOBS (MARK_AS_BUGGED) and stays there until the user clears it;
// a TRANSIENT failure (orchestrator timeout, DOM/loadout not ready yet,
// flow-busy, STOP) is skipped and retried next cycle — never bugged. On STOP
// or timeout the orchestrator sends FLOW_ABORT so the MAIN flow stops instead
// of completing the job in-game behind our back.
//
// Responsibilities:
//   • Own START/STOP. The toggle is driven by AUTOJOBS_SETTINGS.enabled
//     (and the matching toggleAutoJobs runtime message for Firefox).
//   • Run the infinite loop, calling each stage in order, passing the one
//     packet between them (the stages live in auto-jobs/pipeline.js).
//   • Drive the pipeline status: write AJ_PIPELINE_STATE (running, cycle, node)
//     on every node transition so the popup labels the live stage.
//   • Cancel cleanly on STOP — a generation token invalidates any in-flight
//     sleep so a half-run cycle never leaks past a STOP.
//
// Isolation (CLAUDE.md): touches only its own keys (AJ_*,
// AUTOJOBS_SETTINGS) plus the read-only shared game state the stages read.
// The only window message it posts is the generic market refresh.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Store, Registry, constants: C } = root.COR3;
    const SL = C.STORAGE_LOCAL;
    const SS = C.STORAGE_SYNC;
    const NODE = C.AJ.NODE;
    const LOOP = C.AJ.LOOP;

    // Order the orchestrator walks the stages each cycle.
    function pipeline() { return root.COR3.autoJobs && root.COR3.autoJobs.pipeline; }

    // cor3.gg only pushes a fresh network-map graph when the user opens the
    // in-game NM panel, so we re-request one ourselves on this cadence (only
    // while the loop is idle — see start()).
    const NM_GRAPH_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

    class AutoJobsModule extends Module {
        constructor() {
            super({
                id: 'auto-jobs',
                name: 'Auto Jobs',
                category: C.CATEGORY.AUTOMATION,
                dependsOn: ['market', 'dark-market', 'srm-market', 'usol-market'],
                owns: {
                    storageKeys: [
                        SS.AUTOJOBS_SETTINGS,
                        SL.AJ_PIPELINE_STATE,
                        SL.AJ_JOB_QUEUE,
                        SL.AJ_BUGGED_JOBS,
                    ],
                    busTypes: [
                        C.MSG.AUTOJOBS.TOGGLE,
                        C.MSG.AUTOJOBS.OPEN_SAI_ACTION,
                        C.MSG.AUTOJOBS.OPEN_MARKET_ACTION,
                        C.MSG.AUTOJOBS.REFRESH_BOARD,
                        C.MSG.AUTOJOBS.CLEAR_LOG,
                        C.MSG.AUTOJOBS.DISMISS_FAILED,
                        C.MSG.AUTOJOBS.OPEN_SAI,
                        C.MSG.AUTOJOBS.OPEN_MARKET,
                        C.MSG.GAME.REFRESH_MARKET,
                        C.MSG.GAME.REFRESH_DARK_MARKET,
                        C.MSG.GAME.REFRESH_SRM_MARKET,
                        C.MSG.GAME.REFRESH_USOL_MARKET,
                        C.MSG.GAME.ACCEPT_JOB,
                        C.MSG.GAME.COMPLETE_JOB,
                        C.MSG.GAME.DISMISS_JOB,
                        C.MSG.GAME.REVERT_ENDPOINT_TO_HOME,
                        C.MSG.AUTOJOBS.FLOW_START,
                        C.MSG.AUTOJOBS.FLOW_RESULT,
                        C.MSG.AUTOJOBS.FLOW_STEP,
                        C.MSG.AUTOJOBS.FLOW_ABORT,
                    ],
                },
            });
            this._running = false;
            this._runToken = 0;
            this._refreshing = false;   // one-shot Jobs-panel board refresh in flight
            // In-memory per-job JOB_FLOW attempt counter (jobId → failed attempts).
            // A transient/retryable flow failure increments it; once it reaches
            // LOOP.MAX_FLOW_ATTEMPTS the job is bugged instead of retried again.
            // Deliberately NOT persisted — cleared on STOP/reload (see _stopLoop).
            this._flowAttempts = new Map();
            this._state = { running: false, cycle: 0, node: null, startedAt: null, updatedAt: null, error: null, batch: null };
            this._nmRefreshTimer = null;
        }

        async start() {
            if (!pipeline()) {
                this.error('pipeline stages not loaded — auto-jobs/pipeline.js must load before this module');
                return;
            }
            // Reset the persisted progress so a reload shows an idle map, not a
            // stale "running" highlight from a previous session.
            await this._writeState({ running: false, cycle: 0, node: null, error: null });

            this.track(Store.sync.onSettingChange(SS.AUTOJOBS_SETTINGS, (v) => {
                this._applyEnabled(!!(v && v.enabled));
            }));
            this.track(Bus.runtime.on(C.MSG.AUTOJOBS.TOGGLE, (payload) => {
                this._applyEnabled(!!(payload && payload.settings && payload.settings.enabled));
            }));

            // Network Map context-menu actions: forward to the MAIN-world
            // bridge — but ONLY while the loop is stopped. The user must not
            // interfere with a running pipeline (a manual connect would flap
            // the endpoint mid-cycle).
            this.track(Bus.runtime.on(C.MSG.AUTOJOBS.OPEN_SAI_ACTION, (payload) => this._forwardGameAction(C.MSG.AUTOJOBS.OPEN_SAI, 'Open SAI', payload)));
            this.track(Bus.runtime.on(C.MSG.AUTOJOBS.OPEN_MARKET_ACTION, (payload) => this._forwardGameAction(C.MSG.AUTOJOBS.OPEN_MARKET, 'Open Market', payload)));

            // Jobs panel "refresh" — rebuild the saved board once from the
            // current markets. Always available (even while the loop is
            // stopped); refused only while the loop runs.
            this.track(Bus.runtime.on(C.MSG.AUTOJOBS.REFRESH_BOARD, () => { this._refreshBoardOnce(); return { success: true }; }));

            // Activity-Log "Clear" — wipe the Auto Jobs log ring (module ids
            // 'auto-jobs' + 'flow-*') here in the isolated world, where the
            // authoritative in-memory buffer lives. Doing it popup-side would be
            // re-flushed by this context's ring; routing it here clears buffer +
            // storage atomically. Always available.
            this.track(Bus.runtime.on(C.MSG.AUTOJOBS.CLEAR_LOG, () => { this._clearActivityLog(); return { success: true }; }));

            // Jobs panel "✕" on a FAILED row → dismiss that one job now
            // (market.job.dismiss). Refused while the loop runs (a manual endpoint
            // flip would flap the pipeline's SAI session mid-cycle) — the
            // auto-dismiss step handles failed jobs while running instead.
            this.track(Bus.runtime.on(C.MSG.AUTOJOBS.DISMISS_FAILED, (payload) => this._dismissOne(payload)));

            // ── Network Map graph plumbing ────────────────────────────────────
            // NM_GRAPH (the canonical topology from network-map.get.map) is
            // produced by the WS interceptor on REQUEST_NM_MAP, but nothing
            // persists it on its own. The pipeline's GET_SERVERS reads it from
            // storage, the popup Network Map draws it, and the Refresh button
            // asks for a fresh one — so this module owns persisting it AND
            // (re)requesting it.
            this.track(Bus.window.on(C.MSG.GAME.NM_GRAPH, (env) => this._persistNmGraph(env)));
            this.track(Bus.runtime.on(C.MSG.GAME.RESCAN_NETWORK_MAP, () => {
                // WS data path only — does not open the in-game NM panel.
                Bus.window.post(C.MSG.GAME.REQUEST_NM_MAP, null);
                return { success: true };
            }));
            // Initial pull so the pipeline + popup have a graph without the
            // user opening the in-game Network Map panel first.
            Bus.window.post(C.MSG.GAME.REQUEST_NM_MAP, null);
            // Long-timer refresh — only while the loop is idle, so we never
            // race a connect() the running pipeline is driving on the WS.
            this._nmRefreshTimer = setInterval(() => {
                if (!this._running) Bus.window.post(C.MSG.GAME.REQUEST_NM_MAP, null);
            }, NM_GRAPH_REFRESH_INTERVAL_MS);

            const settings = await Store.sync.getOne(SS.AUTOJOBS_SETTINGS, { enabled: false });
            this._applyEnabled(!!settings.enabled);
        }

        async stop() {
            if (this._nmRefreshTimer) { clearInterval(this._nmRefreshTimer); this._nmRefreshTimer = null; }
            this._stopLoop();
        }

        // Persist the canonical network-map graph arriving from WS
        // network-map.get.map. The pipeline + popup read NM_GRAPH from storage.
        async _persistNmGraph(env) {
            if (!env || !Array.isArray(env.servers)) {
                this.warn('NM_GRAPH envelope malformed — ignoring');
                return;
            }
            await Store.local.setOne(SL.NM_GRAPH, env);
            this.debug(`nm graph updated: ${env.servers.length} servers`);
        }

        // Forward a Network Map context-menu game action to MAIN — refused
        // while the loop runs (the UI also greys the buttons; this is the
        // hard guarantee behind it).
        _forwardGameAction(windowType, label, payload) {
            if (this._running) {
                this.warn(`${label} ignored — pipeline is running`);
                return { success: false, reason: 'running' };
            }
            const serverName = (payload && payload.serverName) || null;
            const serverId = (payload && payload.serverId) || null;
            const serverType = (payload && payload.serverType) || null;
            this.info(`${label} → ${serverName || 'home'}`);
            Bus.window.post(windowType, { serverName, serverId, serverType });
            return { success: true };
        }

        // ── enable/disable ───────────────────────────────────────────────
        _applyEnabled(enabled) {
            if (enabled === this._running) return;  // same state — nothing to do
            if (enabled) this._startLoop();
            else this._stopLoop();
        }

        _startLoop() {
            this._running = true;
            const token = ++this._runToken;
            this.info('START — launching pipeline loop');
            this._loop(token).catch((e) => {
                this.error('pipeline loop crashed', { error: String(e), stack: e && e.stack });
            });
        }

        _stopLoop() {
            if (!this._running) return;
            this._running = false;
            this._runToken++;  // invalidates any in-flight sleep / cycle
            this._flowAttempts.clear();  // attempt budget is per-run (in memory only)
            this.info('STOP — pipeline loop cancelled');
            this._writeState({ running: false, node: null, batch: null });
        }

        _alive(token) { return this._running && token === this._runToken; }

        // Cancellable sleep — returns false the moment STOP invalidates the
        // token, so the loop can bail without finishing the wait.
        async _sleep(ms, token) {
            const STEP = 150;
            let waited = 0;
            while (waited < ms) {
                if (!this._alive(token)) return false;
                const chunk = Math.min(STEP, ms - waited);
                await new Promise((r) => setTimeout(r, chunk));
                waited += chunk;
            }
            return this._alive(token);
        }

        // ── the loop ──────────────────────────────────────────────────────
        async _loop(token) {
            await this._setNode(NODE.START, token, { cycle: 0, startedAt: Date.now() });
            await this._setNode(NODE.DELAY_INITIAL, token, { delayMs: LOOP.INITIAL_DELAY_MS });
            if (!(await this._sleep(LOOP.INITIAL_DELAY_MS, token))) return;

            let cycle = 0;
            while (this._alive(token)) {
                cycle++;
                // active === there is live work to chain (a flow batch ran, or jobs
                // were accepted this cycle and will be in-progress next refresh).
                // While active we skip most of the idle DELAY:30s and loop back on
                // the short active delay, so a chain of in-progress jobs (e.g.
                // several file_decryptions, one per cycle) isn't gated by 30s of
                // dead air between each. A crash defaults to the full idle delay.
                let active = false;
                try {
                    active = await this._runCycle(token, cycle);
                } catch (e) {
                    this.error(`cycle ${cycle} aborted`, { error: String(e) });
                    await this._writeState({ running: true, cycle, node: null, error: String(e && e.message || e) });
                }
                if (!this._alive(token)) return;
                // Publish the ACTUAL delay (active=5s vs idle=30s) as state.delayMs
                // so the pipeline status countdown matches the real wait instead of a
                // hard-coded 30s (which made the active short-delay look "skipped").
                const delay = active ? LOOP.CYCLE_DELAY_ACTIVE_MS : LOOP.CYCLE_DELAY_MS;
                await this._setNode(NODE.DELAY_CYCLE, token, { cycle, delayMs: delay });
                if (!(await this._sleep(delay, token))) return;
            }
        }

        async _runCycle(token, cycle) {
            const p = pipeline();
            const ctx = this._ctx(token);
            let packet = p.createPacket(cycle);

            await this._setNode(NODE.GET_SERVERS, token, { cycle, error: null, batch: null });
            packet = await p.stages.getServers.run(packet, ctx);
            if (!this._alive(token)) return;

            await this._setNode(NODE.CHECK_ACCESS, token, { cycle });
            packet = await p.stages.checkAccess.run(packet, ctx);
            if (!this._alive(token)) return;

            await this._setNode(NODE.UPDATE_MARKETS, token, { cycle });
            packet = await p.stages.updateMarkets.run(packet, ctx);
            if (!this._alive(token)) return;

            await this._setNode(NODE.JOB_QUEUE, token, { cycle });
            packet = await p.stages.jobQueue.run(packet, ctx);
            if (!this._alive(token)) return;

            // READY_TO_COMPLETE — claim every in-progress (TAKEN) job the game
            // now reports as finishable (raw.canComplete === true), e.g. a
            // file_decryption whose file is already decrypted but still sitting
            // TAKEN until job.complete is sent. Done BEFORE the in-progress /
            // JOB_FLOW branch so the orchestrator never re-dispatches (and
            // re-opens) an already-solved job — re-opening a decrypted file
            // mounts no minigame and hangs the flow.
            await this._setNode(NODE.READY_TO_COMPLETE, token, { cycle });
            await this._completeReadyJobs(token, packet);
            if (!this._alive(token)) return;

            // Auto-dismiss FAILED jobs (terminal cleanup, gated by the
            // Master-Switches "Auto-dismiss FAILED" toggle — default OFF). Runs
            // here, where the endpoint is at home and no SAI flow is mid-batch.
            // Its own pipeline node (DISMISS_FAILED) is always visited so the
            // pipeline stays linear; like READY_TO_COMPLETE it is simply a no-op
            // when the toggle is off / nothing failed.
            await this._setNode(NODE.DISMISS_FAILED, token, { cycle });
            await this._dismissFailedJobs(token, packet);
            if (!this._alive(token)) return;

            await this._setNode(NODE.QUEUE_EMPTY, token, { cycle });
            const empty = !packet.queue || packet.queue.length === 0;
            this.debug(`QUEUE:EMPTY? → ${empty ? 'YES' : 'NO'}`, { jobs: packet.queue ? packet.queue.length : 0 });
            if (empty) return false;  // YES branch → idle → fall through to the full DELAY:30s

            // QUEUE:HAVE_TASKS_IN_PROGRESS? — any job we've accepted (status
            // TAKEN) is in progress.
            await this._setNode(NODE.HAVE_TASKS_IN_PROGRESS, token, { cycle });
            const inProgress = packet.queue.filter((j) => j.status === 'TAKEN');
            const hasInProgress = inProgress.length > 0;
            this.debug(`HAVE_TASKS_IN_PROGRESS? → ${hasInProgress ? 'YES' : 'NO'}`, { taken: inProgress.length });

            // JOB_FLOW runs only when at least one in-progress job is resumable.
            // It is set false in the all-bugged case below — but we STILL fall
            // through to CHECK_CONDITION + JOB_ACCEPTION, so a bugged in-progress
            // job never freezes acceptance of new work.
            let runFlows = true;
            if (hasInProgress) {
                // MODULE:BUGGED_JOBS (decision) — is the in-progress work
                // bugged? Reads the bugged registry into the packet, then we
                // route on whether any in-progress job is still resumable.
                await this._setNode(NODE.BUGGED_JOBS, token, { cycle });
                packet = await p.stages.buggedJobs.run(packet, ctx);
                if (!this._alive(token)) return;

                const resumable = inProgress.filter((j) => !packet.buggedJobs[j.id]);
                const allBugged = resumable.length === 0;
                this.debug(`BUGGED_JOBS? → ${allBugged ? 'YES (all in-progress bugged)' : 'NO'}`, {
                    inProgress: inProgress.length, resumable: resumable.length,
                });
                if (allBugged) {
                    // JOB:SKIP — no in-progress job is resumable this cycle, so
                    // skip JOB_FLOW. Crucially we do NOT return here: bugged jobs
                    // have no TTL (permanent until the user clears them), so a
                    // single un-doable in-progress job must not halt acceptance of
                    // fresh AVAILABLE jobs — otherwise the whole subsystem freezes.
                    await this._setNode(NODE.JOB_SKIP, token, { cycle });
                    this.info(`JOB:SKIP — ${inProgress.length} in-progress job(s), all bugged — skipping JOB_FLOW (still accepting new jobs)`);
                    runFlows = false;
                }
            }

            await this._setNode(NODE.CHECK_CONDITION, token, { cycle });
            packet = await p.stages.checkCondition.run(packet, ctx);
            if (!this._alive(token)) return;

            await this._setNode(NODE.JOB_ACCEPTION, token, { cycle });
            packet = await p.stages.jobAcception.run(packet, ctx);
            if (!this._alive(token)) return;

            // JOB_FLOW — execute this cycle's BATCH of in-progress (TAKEN) jobs in
            // MAIN, then fall through to DELAY. The orchestrator parks on each
            // FLOW_RESULT, so the loop is paused for the duration of the minigame.
            // The node is ALWAYS lit (even in the all-bugged runFlows=false case)
            // so the map edge JOB_ACCEPTION → JOB_FLOW → DELAY is always traversed
            // — it just dispatches nothing when there is no resumable work.
            await this._setNode(NODE.JOB_FLOW, token, { cycle });
            let dispatched = false;
            if (runFlows) {
                dispatched = await this._runJobFlows(token, cycle, packet);
            }
            // active → short inter-cycle delay (see _loop). We chain quickly when
            // a flow batch actually ran this cycle, or when we just accepted jobs
            // (they become in-progress on the next refresh — pick them up without
            // 30s of dead air). All-bugged / K-D-postponed-only cycles fall here
            // with dispatched=false and accepted=0 → full idle delay, no spin.
            const acceptedCount = (packet.accepted && packet.accepted.length) || 0;
            return !!dispatched || acceptedCount > 0;
        }

        // Claim every in-progress (TAKEN) job the game reports as finishable
        // (raw.canComplete === true). A solved file_decryption sits TAKEN with
        // canComplete:true (its file isDecrypted) until job.complete is sent;
        // ditto any flow whose action landed but whose own complete raced ahead
        // of the server flipping canComplete. We send job.complete here (the
        // generic MSG.GAME.COMPLETE_JOB → __cor3CompleteJob, endpoint flip+revert
        // handled by the interceptor) WITHOUT re-running the flow. Verified live:
        // job.complete on a canComplete job returns {status:'ok'} and it leaves
        // TAKEN. Fire-and-forget + self-healing: a complete that fails leaves the
        // job canComplete:true → retried next cycle.
        async _completeReadyJobs(token, packet) {
            if (!packet.queue) return;
            const ready = packet.queue.filter((j) => j.status === 'TAKEN' && j.raw && j.raw.canComplete === true);
            if (ready.length === 0) { this.debug('READY_TO_COMPLETE → none'); return; }
            this.info(`READY_TO_COMPLETE → completing ${ready.length} finished job(s)`);
            for (let i = 0; i < ready.length; i++) {
                if (!this._alive(token)) return;
                const job = ready[i];
                if (!job.marketId) { this.warn(`READY_TO_COMPLETE: job ${job.id} has no marketId — cannot complete`); continue; }
                Bus.window.post(C.MSG.GAME.COMPLETE_JOB, { jobId: job.id, marketId: job.marketId });
                this.info(`READY_TO_COMPLETE · complete ${job.id} (${job.type || '?'}) @ ${job.marketSlot}`);
                // Pace the completes (each remote-market one does a set.endpoint
                // flip+revert in the interceptor); skip the wait after the last.
                if (i < ready.length - 1) await new Promise((r) => setTimeout(r, LOOP.ACCEPT_PACING_MS));
            }
            // A remote-market complete may have left the endpoint on DARK/SRM.
            Bus.window.post(C.MSG.GAME.REVERT_ENDPOINT_TO_HOME, null);
        }

        // Auto-dismiss every FAILED job on the board (status 'FAILED', stamped by
        // UPDATE_MARKETS from the market's recentJobs). Gated by the
        // Master-Switches "Auto-dismiss FAILED" toggle — OFF by default, so the
        // user can inspect failed jobs first; nothing is cleared until they opt
        // in. We send market.job.dismiss (MSG.GAME.DISMISS_JOB → __cor3DismissJob;
        // the interceptor does the per-market endpoint flip+revert), paced like
        // the completes, then revert to home. Fire-and-forget + self-healing: a
        // dismiss that fails leaves the job FAILED → retried next cycle.
        async _dismissFailedJobs(token, packet) {
            if (!packet.queue) return;
            // Read the toggle straight from its source (no prior-stage coupling —
            // this step runs before CHECK_CONDITION stamps packet.masterSwitches).
            // Absent === OFF (opposite of the markets/jobTypes switches): the user
            // must explicitly enable auto-dismiss.
            const switches = await Store.local.getOne(SL.AJ_MASTER_SWITCHES, {});
            const on = !!(switches && switches.behaviour && switches.behaviour.autoDismissFailed);
            if (!on) { this.debug('DISMISS_FAILED → auto-dismiss disabled (Master Switches)'); return; }

            const failed = packet.queue.filter((j) => j.status === 'FAILED');
            if (failed.length === 0) { this.debug('DISMISS_FAILED → none'); return; }
            this.info(`DISMISS_FAILED → dismissing ${failed.length} failed job(s)`);
            for (let i = 0; i < failed.length; i++) {
                if (!this._alive(token)) return;
                const job = failed[i];
                if (!job.marketId) { this.warn(`DISMISS_FAILED: job ${job.id} has no marketId — cannot dismiss`); continue; }
                Bus.window.post(C.MSG.GAME.DISMISS_JOB, { jobId: job.id, marketId: job.marketId });
                this.info(`DISMISS_FAILED · dismiss ${job.id} (${job.type || '?'}) @ ${job.marketSlot}`);
                // Pace the dismisses (each remote-market one does a set.endpoint
                // flip+revert in the interceptor); skip the wait after the last.
                if (i < failed.length - 1) await new Promise((r) => setTimeout(r, LOOP.ACCEPT_PACING_MS));
            }
            // A remote-market dismiss may have left the endpoint on DARK/SRM.
            Bus.window.post(C.MSG.GAME.REVERT_ENDPOINT_TO_HOME, null);
        }

        // Manual dismiss of ONE failed job from the popup Jobs list (the ✕ button).
        // Refused while the loop runs — __cor3SetEndpoint (used by the SAI flows) is
        // NOT serialised through the interceptor's dismiss chain, so a manual
        // endpoint flip could flap a running SAI batch's session. While running,
        // the auto-dismiss step clears failed jobs instead. The interceptor's
        // __cor3DismissJob self-reverts to the saved endpoint, so no REVERT here.
        _dismissOne(payload) {
            if (this._running) {
                this.warn('Dismiss ignored — pipeline is running (enable Auto-dismiss FAILED in Master Switches to clear them while running)');
                return { success: false, reason: 'running' };
            }
            const jobId = payload && payload.jobId;
            const marketId = payload && payload.marketId;
            if (!jobId || !marketId) {
                this.warn('Dismiss ignored — missing jobId/marketId', { jobId, marketId });
                return { success: false, reason: 'missing-id' };
            }
            this.info(`DISMISS_FAILED (manual) → dismiss ${jobId}`);
            Bus.window.post(C.MSG.GAME.DISMISS_JOB, { jobId, marketId });
            return { success: true };
        }

        // Run THIS cycle's BATCH of in-progress (TAKEN) jobs back-to-back, then
        // fall through to the inter-cycle DELAY. The batch (see _selectBatch) is either every
        // TAKEN file_decryption (absolute priority — local minigames, no login)
        // or every wired SAI job on ONE server. Running a server's jobs in a
        // single pass means it is connected + logged into ONCE (the flows share
        // the login via the per-batch session token), saving cycles AND logins.
        // Bugged jobs were filtered before JOB:SKIP; we re-check here so a job
        // bugged earlier this cycle is skipped.
        async _runJobFlows(token, cycle, packet) {
            const p = pipeline();
            // CHECK_CONDITION (the sole predecessor of JOB_FLOW) always loads
            // the bugged registry onto the packet. A missing one means the
            // pipeline was wired wrong — fail loudly rather than silently
            // re-fetch (design rule: no defensive defaults).
            if (!packet.buggedJobs) throw new Error('JOB_FLOW: packet.buggedJobs missing (CHECK_CONDITION must run first)');
            const bugged = packet.buggedJobs;
            // Exclude jobs the game already reports finishable (raw.canComplete):
            // READY_TO_COMPLETE (run earlier this cycle) fired their job.complete
            // but does NOT mutate packet.queue, so without this guard _selectBatch
            // could re-dispatch a just-completed file_decryption and re-open its
            // already-decrypted file (no minigame → wasted ~90s).
            const allInProgress = packet.queue.filter((j) =>
                j.status === 'TAKEN' && !bugged[j.id] && !(j.raw && j.raw.canComplete === true));
            // #6 — postpone (do NOT dispatch) any SAI job whose target server is on
            // K/D cooldown or not accessible this cycle: the flow would only burn a
            // login/hack attempt failing ensureAccess. Postponing is NOT a failed
            // attempt (the retry budget is untouched) — the job runs unchanged the
            // moment the server is reachable again.
            const acc = packet.accessibility || {};
            const inProgress = [];
            let postponed = 0;
            for (const j of allInProgress) {
                if (this._jobServerReachable(j, acc)) inProgress.push(j);
                else postponed++;
            }
            if (postponed) this.info(`JOB_FLOW → ${postponed} in-progress SAI job(s) postponed (server on K/D / not accessible this cycle)`);
            // Returns whether a flow batch actually ran (≥1 job dispatched) — the
            // _loop uses it to chain on the SHORT active delay instead of DELAY:30s.
            if (inProgress.length === 0) { this.debug('JOB_FLOW → no resumable in-progress jobs to run this cycle'); return false; }

            const batch = this._selectBatch(inProgress, p);
            if (batch.jobs.length === 0) {
                this.info(`JOB_FLOW → ${inProgress.length} in-progress job(s), none of a wired type yet — skipping`);
                return false;
            }
            // batchKey scopes the SAI login reuse: every SAI job in this batch
            // shares ONE server, so the first establishes access and the rest
            // reuse it. The file_decryption pick carries no key (no SAI login).
            // Keyed by run-token + cycle so the next cycle (or a STOP→restart,
            // which bumps the token) re-authenticates from scratch.
            const batchKey = batch.serverId ? `${token}:${cycle}:${batch.serverId}` : null;
            // SAI batch (serverId set): DEFER each job's job.complete to AFTER all
            // actions. job.complete flips the endpoint to the market home and back,
            // which tears down the shared SAI session — so completing mid-batch
            // would log us out before the next job's WS action. Instead the flows
            // only ACT (their complete() is a no-op while deferComplete is set), the
            // endpoint stays on the server for the whole batch (ONE login), and the
            // orchestrator completes the actioned jobs in one pass at the end.
            const deferComplete = !!batch.serverId;
            const toComplete = [];
            this.info(`JOB_FLOW → batch of ${batch.jobs.length} ${batch.label} (of ${inProgress.length} in-progress this cycle)`);

            // Publish the live batch onto AJ_PIPELINE_STATE so the Jobs UI can
            // show "running N jobs in one batch on <server>" and which one is
            // live. `index` / `currentJobId` are bumped per job below; the whole
            // descriptor is cleared at GET_SERVERS (next cycle) and on STOP.
            const bd = {
                label: batch.label,
                serverId: batch.serverId,
                serverName: (batch.jobs[0] && batch.jobs[0].serverName) || null,
                jobIds: batch.jobs.map((j) => j.id),
                total: batch.jobs.length,
                index: 0,
                currentJobId: null,
                oneLogin: !!batch.serverId,
            };
            await this._setBatch(bd, token);

            for (let i = 0; i < batch.jobs.length; i++) {
                if (!this._alive(token)) return;
                const job = batch.jobs[i];
                bd.index = i + 1;
                bd.currentJobId = job.id;
                await this._setBatch(Object.assign({}, bd), token);

                // Build the type-specific FLOW_START payload — the target server +
                // the entities to act on, read from the TAKEN job's condition
                // details. A null payload means the job carries no resolvable
                // target → it genuinely can't be done → bug it (and move on to
                // the next job in the batch).
                const payload = this._buildFlowPayload(job, packet, batchKey);
                if (!payload) { await this._markBugged(job, 'could not resolve flow target from job conditions', token); continue; }
                if (deferComplete) payload.deferComplete = true;

                this.info(`JOB_FLOW → dispatch ${job.type} ${job.id} (${i + 1}/${batch.jobs.length})`, { target: this._payloadSummary(payload) });
                // NOTE: the payload field is `jobType`, NOT `type` — Bus.window
                // builds the envelope as Object.assign({type}, payload), so a
                // payload key named `type` would clobber the Bus message type and
                // the message would never reach the flow's listener.
                const result = await this._dispatchFlow(payload, token);
                if (!this._alive(token)) return;

                // STOP cancelled the dispatch (the flow was aborted) — the job is
                // untouched; don't bug it, and abandon the rest of the batch (it
                // resumes when the loop restarts). Skip the deferred completes too:
                // a cancelled batch's actions may be half-done, and READY_TO_COMPLETE
                // will finish anything the game now reports canComplete next cycle.
                if (result.cancelled) { this.info(`JOB_FLOW → ${job.id} cancelled (loop stopped)`); return; }

                if (result.success && result.didWork) {
                    this._flowAttempts.delete(job.id);  // succeeded — reset its retry budget
                    // Action landed. Deferred → queue the complete for the end of
                    // the batch; immediate → the flow already completed it.
                    if (deferComplete) {
                        if (job.marketId) {
                            toComplete.push(job);
                            this.info(`JOB_FLOW → ${job.id} actioned (complete deferred)`);
                        } else {
                            // Actioned but no marketId to job.complete with → it can
                            // be neither completed nor caught by READY_TO_COMPLETE
                            // (which also needs marketId). Bug it loudly rather than
                            // silently re-action it every cycle.
                            await this._markBugged(job, 'actioned but job has no marketId to complete', token);
                        }
                    } else {
                        this.info(`JOB_FLOW → ${job.id} completed`);
                    }
                    continue;
                }
                if (result.retryable) {
                    // flow-busy is the previous job still solving — NOT a real
                    // attempt at THIS job; retry next cycle without spending its
                    // budget.
                    if (result.reason === 'flow-busy') { this.info(`JOB_FLOW → ${job.id} deferred (flow-busy) — will retry`); continue; }
                    // TRANSIENT failure (timeout, DOM/loadout not ready, server
                    // action failed): retry up to MAX_FLOW_ATTEMPTS, then bug. A
                    // genuinely-stuck job (file never appears, hack keeps failing)
                    // is no longer retried forever — it becomes bugged and stops
                    // blocking the pipeline (decryption-priority + JOB:SKIP both
                    // exclude bugged jobs).
                    const n = (this._flowAttempts.get(job.id) || 0) + 1;
                    this._flowAttempts.set(job.id, n);
                    if (n < LOOP.MAX_FLOW_ATTEMPTS) {
                        this.info(`JOB_FLOW → ${job.id} not done (${result.reason || 'transient'}) — attempt ${n}/${LOOP.MAX_FLOW_ATTEMPTS}, will retry`);
                        continue;
                    }
                    await this._markBugged(job, `failed after ${n} attempts: ${result.reason || 'transient'}`, token);
                    continue;
                }
                // Non-retryable (genuinely can't do this job) → bug immediately.
                await this._markBugged(job, result.reason || 'flow failed', token);
            }

            // SAI batch end: all actions done, the shared SAI session is no longer
            // needed → complete the actioned jobs now (each complete-flip is safe
            // here — nothing else reads the server afterwards).
            if (deferComplete && toComplete.length) await this._completeBatchJobs(toComplete, token);
            // Batch done → clear the live-batch banner (the next cycle's
            // GET_SERVERS also clears it, this just drops it immediately so the
            // DELAY window shows no stale batch).
            await this._writeState({ batch: null });
            // Whole batch attempted (≥1 job dispatched) → return true so the loop
            // chains on the short active delay → next cycle picks the next batch
            // (next server, or the remaining file_decryption) without 30s of wait.
            return true;
        }

        // Publish the live batch descriptor onto AJ_PIPELINE_STATE (read by the
        // Jobs UI). Gated on _alive so a STOP mid-batch doesn't resurrect it after
        // _stopLoop cleared it.
        async _setBatch(batch, token) {
            if (!this._alive(token)) return;
            await this._writeState({ batch });
        }

        // Complete the SAI jobs whose action landed this batch (their flow's
        // own complete() was deferred). Same generic path as READY_TO_COMPLETE:
        // MSG.GAME.COMPLETE_JOB → __cor3CompleteJob (the interceptor does the
        // endpoint flip+send+revert), paced, then revert to HOME. Self-healing:
        // a complete that fails leaves the job TAKEN → next cycle READY_TO_COMPLETE
        // (which runs before JOB_FLOW) catches it once the game flips canComplete.
        async _completeBatchJobs(jobs, token) {
            this.info(`JOB_FLOW → completing ${jobs.length} actioned SAI job(s)`);
            for (let i = 0; i < jobs.length; i++) {
                if (!this._alive(token)) return;
                const job = jobs[i];
                Bus.window.post(C.MSG.GAME.COMPLETE_JOB, { jobId: job.id, marketId: job.marketId });
                this.info(`JOB_FLOW · complete ${job.id} (${job.type || '?'}) @ ${job.marketSlot}`);
                if (i < jobs.length - 1) await new Promise((r) => setTimeout(r, LOOP.ACCEPT_PACING_MS));
            }
            Bus.window.post(C.MSG.GAME.REVERT_ENDPOINT_TO_HOME, null);
        }

        // Choose the set of in-progress jobs to run THIS cycle, back-to-back:
        //   • file_decryption FIRST, ONE per cycle (local minigames, nothing to
        //     batch); absolute priority drains decrypts before any SAI type,
        //     matching JOB_ACCEPTION's decrypt-first acceptance.
        //   • else every wired SAI job on ONE server (the one with the most
        //     in-progress jobs) — so it is logged into once and all its jobs run
        //     in a single pass.
        // Returns { jobs, serverId, label }; serverId is null for the
        // file_decryption pick (no SAI login → no batchKey). WIRED_FLOW_TYPES is
        // the same gate JOB_ACCEPTION uses, so a TAKEN job of an unwired type is
        // left for a later build, never stranded.
        _jobServerReachable(job, accessibility) {
            // Shared with JOB_ACCEPTION's hold-gate so "workable this cycle" means
            // exactly the same thing on both the accept and execute sides.
            return pipeline().jobServerReachable(job, accessibility);
        }

        _selectBatch(inProgress, p) {
            // file_decryption keeps ABSOLUTE priority but runs ONE per cycle: each
            // is a separate local minigame (no server / no SAI login to share), so
            // there is nothing to batch. Draining one per cycle (until none remain)
            // before any SAI job is the established decrypt-first behaviour.
            const decryption = inProgress.find((j) => j.type === C.FLOW.FILE_DECRYPTION);
            if (decryption) return { jobs: [decryption], serverId: null, label: 'file_decryption (1/cycle)' };

            const wired = inProgress.filter((j) => p.WIRED_FLOW_TYPES.has(j.type));
            if (wired.length === 0) return { jobs: [], serverId: null, label: '' };

            // Group the wired SAI jobs by their target server (conditions
            // .serverConfigId), pick the biggest group.
            const byServer = new Map();
            for (const j of wired) {
                const sid = p.serverConfigId(j.raw);
                if (!sid) continue;   // unresolvable target — handled below
                if (!byServer.has(sid)) byServer.set(sid, []);
                byServer.get(sid).push(j);
            }
            if (byServer.size === 0) {
                // No wired job resolved a server (malformed targets) — dispatch them
                // anyway so _buildFlowPayload returns null → each is bugged once.
                return { jobs: wired, serverId: null, label: 'unresolved SAI job(s)' };
            }
            let best = null;
            for (const [sid, jobs] of byServer) if (!best || jobs.length > best.jobs.length) best = { sid, jobs };
            const name = best.jobs[0].serverName || best.sid;
            return { jobs: best.jobs, serverId: best.sid, label: `SAI job(s) on "${name}"` };
        }

        // Build the per-type FLOW_START payload for a TAKEN job. file_decryption
        // works on the LOCAL Downloads (no server) and carries `fileCondition`;
        // every SAI flow carries { serverId, serverType, serverName } + the
        // resolved target (ips / fileNames / logSeqs+logNames). serverId is the
        // job's conditions.serverConfigId (== relatedServers[0].id, verified
        // live); serverType is looked up in the NM graph for the hack path.
        // batchKey (passed by JOB_FLOW for SAI batches) rides along so the flow's
        // ensureAccess reuses one login across the server's batch; file_decryption
        // carries none (no SAI login). Returns null when the target can't be
        // resolved → the caller bugs it.
        _buildFlowPayload(job, packet, batchKey) {
            const p = pipeline();
            const base = { jobId: job.id, marketId: job.marketId, jobType: job.type };

            if (job.type === C.FLOW.FILE_DECRYPTION) {
                const fileCondition = p.fileConditionForDecrypt(job.raw);
                return fileCondition ? Object.assign(base, { fileCondition }) : null;
            }

            // SAI flows — resolve the target server (serverId + type/name).
            const serverId = p.serverConfigId(job.raw);
            if (!serverId) return null;
            const srv = (packet.servers || []).find((s) => s && s.id === serverId) || null;
            const sai = {
                serverId,
                serverType: srv ? (srv.serverTypeName || null) : null,
                // NM_GRAPH server objects expose `name` (NOT `serverName`); the
                // old `srv.serverName` was always undefined, silently relying on
                // the job.serverName fallback. Read the right field so the NM
                // lookup actually covers a job whose own serverName is missing.
                serverName: (srv && srv.name) || job.serverName || null,
                batchKey: batchKey || null,
            };

            switch (job.type) {
                case C.FLOW.IP_INJECTION:
                case C.FLOW.IP_CLEANUP: {
                    const ips = p.ipsForJob(job.raw);
                    return ips.length ? Object.assign(base, sai, { ips }) : null;
                }
                case C.FLOW.FILE_ELIMINATION:
                case C.FLOW.DATA_DOWNLOAD:
                case C.FLOW.FILE_UPLOAD:
                case C.FLOW.DECRYPT_EXTRACT: {
                    const fileNames = p.fileNamesForJob(job.raw);
                    return fileNames.length ? Object.assign(base, sai, { fileNames }) : null;
                }
                case C.FLOW.LOG_DELETION:
                case C.FLOW.LOG_DOWNLOAD: {
                    const logSeqs = p.logSeqsForJob(job.raw);
                    const logNames = p.logNamesForJob(job.raw);
                    return (logSeqs.length || logNames.length) ? Object.assign(base, sai, { logSeqs, logNames }) : null;
                }
                default:
                    return null;
            }
        }

        // Compact, log-friendly view of a FLOW_START payload (avoid dumping big
        // arrays / the raw job into the Activity Log).
        _payloadSummary(payload) {
            const s = { server: payload.serverName || null };
            if (payload.fileCondition) s.fileCondition = payload.fileCondition;
            if (Array.isArray(payload.ips)) s.ips = payload.ips.length;
            if (Array.isArray(payload.fileNames)) s.fileNames = payload.fileNames;
            if (Array.isArray(payload.logSeqs)) s.logSeqs = payload.logSeqs;
            if (Array.isArray(payload.logNames) && payload.logNames.length) s.logNames = payload.logNames;
            return s;
        }

        // Post FLOW_START to MAIN and resolve with the matching FLOW_RESULT.
        // Always resolves an object (never null):
        //   • the FLOW_RESULT envelope                         — the flow replied
        //   • { success:false, retryable:true, reason:'flow timed out … ' } — timeout
        //   • { cancelled:true }                               — STOP invalidated the run
        // On timeout OR cancel it posts FLOW_ABORT so the MAIN flow stops
        // (rather than running on and completing the job in-game after we've
        // already given up), and tears down the FLOW_STEP/FLOW_RESULT
        // subscriptions immediately — they live outside this.track(), so a
        // `watch` interval drops them within 200ms of STOP instead of leaking
        // for up to FLOW_TIMEOUT_MS. While the flow runs, FLOW_STEP messages
        // are relayed into the live pipeline node so the pipeline status shows
        // the sub-step the MAIN flow is on.
        _dispatchFlow(payload, token) {
            return new Promise((resolve) => {
                let settled = false;
                const finish = (v, abort) => {
                    if (settled) return;
                    settled = true;
                    try { unsubResult(); } catch (_) { /* noop */ }
                    try { unsubStep(); } catch (_) { /* noop */ }
                    clearTimeout(timer);
                    clearInterval(watch);
                    if (abort) Bus.window.post(C.MSG.AUTOJOBS.FLOW_ABORT, { jobId: payload.jobId });
                    resolve(v);
                };
                const unsubStep = Bus.window.on(C.MSG.AUTOJOBS.FLOW_STEP, (env) => {
                    if (env && env.jobId === payload.jobId && env.node) this._setNode(env.node, token);
                });
                const unsubResult = Bus.window.on(C.MSG.AUTOJOBS.FLOW_RESULT, (env) => {
                    if (env && env.jobId === payload.jobId) finish(env, false);
                });
                // STOP / reload → abort the MAIN flow, resolve as cancelled, and
                // drop the subscriptions promptly.
                const watch = setInterval(() => {
                    if (!this._alive(token)) finish({ cancelled: true }, true);
                }, 200);
                // Hard ceiling → retryable timeout (abort + retry next cycle,
                // not a permanent bug for a merely-slow minigame).
                const timer = setTimeout(
                    () => finish({ success: false, retryable: true, reason: 'flow timed out — no FLOW_RESULT' }, true),
                    LOOP.FLOW_TIMEOUT_MS,
                );
                Bus.window.post(C.MSG.AUTOJOBS.FLOW_START, payload);
            });
        }

        async _markBugged(job, reason, token) {
            await this._setNode(NODE.MARK_AS_BUGGED, token);
            this._flowAttempts.delete(job.id);  // bugged is terminal — drop its retry budget
            const reg = await Store.local.getOne(SL.AJ_BUGGED_JOBS, {});
            reg[job.id] = { reason: String(reason), since: Date.now() };
            await Store.local.setOne(SL.AJ_BUGGED_JOBS, reg);
            this.warn(`MARK_AS_BUGGED ${job.id}: ${reason}`);
        }

        // One-shot board rebuild for the popup Jobs "refresh" button: run the
        // read-only half of the pipeline (servers → access → markets → queue →
        // condition) and republish AJ_JOB_QUEUE, WITHOUT accepting or running
        // any job. Refused while the loop runs (it already rebuilds each cycle)
        // and debounced against itself. Does not touch the pipeline-status state.
        async _refreshBoardOnce() {
            if (this._running) { this.warn('Jobs refresh ignored — the pipeline is running (it rebuilds the board each cycle)'); return; }
            if (this._refreshing) { this.debug('Jobs refresh already in progress'); return; }
            const p = pipeline();
            if (!p) { this.error('Jobs refresh — pipeline stages not loaded'); return; }
            this._refreshing = true;
            try {
                const ctx = this._makeCtx(() => this._refreshing);
                this.info('Jobs board refresh (one-shot) — rebuilding the queue from current markets');
                let packet = p.createPacket(0);
                packet = await p.stages.getServers.run(packet, ctx);
                packet = await p.stages.checkAccess.run(packet, ctx);
                packet = await p.stages.updateMarkets.run(packet, ctx);
                packet = await p.stages.jobQueue.run(packet, ctx);
                packet = await p.stages.checkCondition.run(packet, ctx);
                this.info('Jobs board refresh done');
            } catch (e) {
                this.error('Jobs board refresh failed', { error: String(e && e.message || e) });
            } finally {
                this._refreshing = false;
            }
        }

        // Clear the Activity Log: drop every entry under this module's id and
        // any flow-* id from the Logger's ring + storage. Runs here (isolated
        // world) because this is where the authoritative buffer lives; the popup
        // viewer re-renders off the LOGS storage change the clear writes. The
        // single "cleared" line below is intentional confirmation feedback.
        async _clearActivityLog() {
            const L = root.COR3 && root.COR3.Logger;
            if (!L || typeof L.clear !== 'function') { this.warn('Clear Log — Logger.clear unavailable'); return; }
            await L.clear(/^(auto-jobs|flow-.+)$/);
            this.info('Activity Log cleared');
        }

        _ctx(token) {
            // Lets long-running stages (JOB_ACCEPTION's paced accept batch) bail
            // the instant STOP invalidates this run.
            return this._makeCtx(() => this._alive(token));
        }

        // ctx shared by the cycle loop and the one-shot board refresh.
        _makeCtx(alive) {
            return {
                store: Store,
                bus: Bus,
                C,
                alive,
                log: {
                    debug: (m, c) => this.debug(m, c),
                    info: (m, c) => this.info(m, c),
                    warn: (m, c) => this.warn(m, c),
                    error: (m, c) => this.error(m, c),
                },
            };
        }

        // ── pipeline-state persistence (drives the pipeline status readout) ──
        async _setNode(node, token, extra) {
            if (!this._alive(token)) return;
            await this._writeState(Object.assign({ running: true, node }, extra));
        }

        async _writeState(patch) {
            Object.assign(this._state, patch, { updatedAt: Date.now() });
            await Store.local.setOne(SL.AJ_PIPELINE_STATE, Object.assign({}, this._state));
        }
    }

    Registry.register(new AutoJobsModule());
})();
