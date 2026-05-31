// Auto-Jobs v2 — orchestrator.
//
// The one registered module for the v2 subsystem (id 'auto-jobs-v2', so all
// its logs and the stages' logs land in the v2 Activity Log). It does NOT
// implement job logic itself — it drives the flowchart:
//
//   START → DELAY:10s → ┌─ GET_SERVERS → CHECK_SERVERS_ACCESABILITY
//                       │   → UPDATE_MARKETS → JOB_QUEUE → <QUEUE:EMPTY?>
//                       │     YES ───────────────────────────────────────┐
//                       │     NO → <HAVE_TASKS_IN_PROGRESS?>              │
//                       │            YES → <BUGGED_JOBS?>                 │
//                       │                    YES → JOB:SKIP ──────────────┤
//                       │                    NO  ─┐                       │
//                       │            NO ──────────┴→ CHECK_CONDITION      │
//                       │                            → JOB_ACCEPTION      │
//                       │                            → JOB_FLOW            │
//                       └──────────────── DELAY:30s ←─────────────────────┘  (loop)
//
// JOB_FLOW dispatches a BATCH of in-progress (TAKEN) jobs per cycle, then parks
// on each one's FLOW_RESULT in turn — so the loop pauses for each minigame,
// then goes to DELAY:30s. The batch is chosen to minimise cycles + logins:
// file_decryption FIRST (every TAKEN one — local minigames, no server), else
// every wired SAI job that targets ONE server (the busiest), run back-to-back
// so that server is connected + logged into ONCE (the SAI flows share the login
// via the per-batch session, keyed `${cycle}:${serverId}`). Failure handling
// is per job and splits by `retryable`: a job that is
// genuinely undoable (no owned decrypt software, malformed job) is written to
// AJV2_BUGGED_JOBS (MARK_AS_BUGGED) and stays there until the user clears it;
// a TRANSIENT failure (orchestrator timeout, DOM/loadout not ready yet,
// flow-busy, STOP) is skipped and retried next cycle — never bugged. On STOP
// or timeout the orchestrator sends FLOW_ABORT so the MAIN flow stops instead
// of completing the job in-game behind our back.
//
// Responsibilities:
//   • Own START/STOP. The toggle is driven by AUTOJOBS_V2_SETTINGS.enabled
//     (and the matching toggleAutoJobsV2 runtime message for Firefox).
//   • Run the infinite loop, calling each stage in order, passing the one
//     packet between them (the stages live in auto-jobs-v2/pipeline.js).
//   • Drive the Flow Map: write AJV2_PIPELINE_STATE (running, cycle, node) on
//     every node transition so the popup highlights the live stage.
//   • Cancel cleanly on STOP — a generation token invalidates any in-flight
//     sleep so a half-run cycle never leaks past a STOP.
//
// v2 isolation (CLAUDE.md): touches only its own keys (AJV2_*,
// AUTOJOBS_V2_SETTINGS) plus the read-only shared game state the stages read.
// The only window message it posts is the generic market refresh.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Store, Registry, constants: C } = root.COR3;
    const SL = C.STORAGE_LOCAL;
    const SS = C.STORAGE_SYNC;
    const NODE = C.AJV2.NODE;
    const LOOP = C.AJV2.LOOP;

    // Order the orchestrator walks the stages each cycle.
    function pipeline() { return root.COR3.autoJobsV2 && root.COR3.autoJobsV2.pipeline; }

    class AutoJobsV2Module extends Module {
        constructor() {
            super({
                id: 'auto-jobs-v2',
                name: 'Auto-Jobs v2',
                category: C.CATEGORY.AUTOMATION,
                dependsOn: ['market', 'dark-market', 'srm-market'],
                owns: {
                    storageKeys: [
                        SS.AUTOJOBS_V2_SETTINGS,
                        SL.AJV2_PIPELINE_STATE,
                        SL.AJV2_JOB_QUEUE,
                        SL.AJV2_BUGGED_JOBS,
                    ],
                    busTypes: [
                        C.MSG.AUTOJOBS_V2.TOGGLE,
                        C.MSG.AUTOJOBS_V2.OPEN_SAI_ACTION,
                        C.MSG.AUTOJOBS_V2.OPEN_MARKET_ACTION,
                        C.MSG.AUTOJOBS_V2.REFRESH_BOARD,
                        C.MSG.AUTOJOBS_V2.OPEN_SAI,
                        C.MSG.AUTOJOBS_V2.OPEN_MARKET,
                        C.MSG.GAME.REFRESH_MARKET,
                        C.MSG.GAME.REFRESH_DARK_MARKET,
                        C.MSG.GAME.REFRESH_SRM_MARKET,
                        C.MSG.GAME.ACCEPT_JOB,
                        C.MSG.GAME.REVERT_ENDPOINT_TO_HOME,
                        C.MSG.AUTOJOBS_V2.FLOW_START,
                        C.MSG.AUTOJOBS_V2.FLOW_RESULT,
                        C.MSG.AUTOJOBS_V2.FLOW_STEP,
                        C.MSG.AUTOJOBS_V2.FLOW_ABORT,
                    ],
                },
            });
            this._running = false;
            this._runToken = 0;
            this._refreshing = false;   // one-shot Jobs-panel board refresh in flight
            this._state = { running: false, cycle: 0, node: null, startedAt: null, updatedAt: null, error: null, batch: null };
        }

        async start() {
            if (!pipeline()) {
                this.error('pipeline stages not loaded — auto-jobs-v2/pipeline.js must load before this module');
                return;
            }
            // Reset the persisted progress so a reload shows an idle map, not a
            // stale "running" highlight from a previous session.
            await this._writeState({ running: false, cycle: 0, node: null, error: null });

            this.track(Store.sync.onSettingChange(SS.AUTOJOBS_V2_SETTINGS, (v) => {
                this._applyEnabled(!!(v && v.enabled));
            }));
            this.track(Bus.runtime.on(C.MSG.AUTOJOBS_V2.TOGGLE, (payload) => {
                this._applyEnabled(!!(payload && payload.settings && payload.settings.enabled));
            }));

            // Network Map context-menu actions: forward to the MAIN-world v2
            // bridge — but ONLY while the loop is stopped. The user must not
            // interfere with a running pipeline (a manual connect would flap
            // the endpoint mid-cycle).
            this.track(Bus.runtime.on(C.MSG.AUTOJOBS_V2.OPEN_SAI_ACTION, (payload) => this._forwardGameAction(C.MSG.AUTOJOBS_V2.OPEN_SAI, 'Open SAI', payload)));
            this.track(Bus.runtime.on(C.MSG.AUTOJOBS_V2.OPEN_MARKET_ACTION, (payload) => this._forwardGameAction(C.MSG.AUTOJOBS_V2.OPEN_MARKET, 'Open Market', payload)));

            // Jobs panel "refresh" — rebuild the saved board once from the
            // current markets. Always available (even while the loop is
            // stopped); refused only while the loop runs.
            this.track(Bus.runtime.on(C.MSG.AUTOJOBS_V2.REFRESH_BOARD, () => { this._refreshBoardOnce(); return { success: true }; }));

            const settings = await Store.sync.getOne(SS.AUTOJOBS_V2_SETTINGS, { enabled: false });
            this._applyEnabled(!!settings.enabled);
        }

        async stop() {
            this._stopLoop();
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
            await this._setNode(NODE.DELAY_INITIAL, token);
            if (!(await this._sleep(LOOP.INITIAL_DELAY_MS, token))) return;

            let cycle = 0;
            while (this._alive(token)) {
                cycle++;
                try {
                    await this._runCycle(token, cycle);
                } catch (e) {
                    this.error(`cycle ${cycle} aborted`, { error: String(e) });
                    await this._writeState({ running: true, cycle, node: null, error: String(e && e.message || e) });
                }
                if (!this._alive(token)) return;
                await this._setNode(NODE.DELAY_CYCLE, token, { cycle });
                if (!(await this._sleep(LOOP.CYCLE_DELAY_MS, token))) return;
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

            await this._setNode(NODE.QUEUE_EMPTY, token, { cycle });
            const empty = !packet.queue || packet.queue.length === 0;
            this.debug(`QUEUE:EMPTY? → ${empty ? 'YES' : 'NO'}`, { jobs: packet.queue ? packet.queue.length : 0 });
            if (empty) return;  // YES branch → fall through to DELAY:30s

            // QUEUE:HAVE_TASKS_IN_PROGRESS? — any job we've accepted (status
            // TAKEN) is in progress.
            await this._setNode(NODE.HAVE_TASKS_IN_PROGRESS, token, { cycle });
            const inProgress = packet.queue.filter((j) => j.status === 'TAKEN');
            const hasInProgress = inProgress.length > 0;
            this.debug(`HAVE_TASKS_IN_PROGRESS? → ${hasInProgress ? 'YES' : 'NO'}`, { taken: inProgress.length });

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
                    // JOB:SKIP — nothing resumable this cycle; loop back.
                    await this._setNode(NODE.JOB_SKIP, token, { cycle });
                    this.info(`JOB:SKIP — ${inProgress.length} in-progress job(s), all bugged — skipping cycle`);
                    return;
                }
            }

            await this._setNode(NODE.CHECK_CONDITION, token, { cycle });
            packet = await p.stages.checkCondition.run(packet, ctx);
            if (!this._alive(token)) return;

            await this._setNode(NODE.JOB_ACCEPTION, token, { cycle });
            packet = await p.stages.jobAcception.run(packet, ctx);
            if (!this._alive(token)) return;

            // JOB_FLOW — execute ONE in-progress (TAKEN) job in MAIN, then fall
            // through to DELAY. The orchestrator parks on its FLOW_RESULT, so
            // the loop is paused for the duration of that job's minigame.
            await this._setNode(NODE.JOB_FLOW, token, { cycle });
            await this._runJobFlows(token, cycle, packet);
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

        // Run THIS cycle's BATCH of in-progress (TAKEN) jobs back-to-back, then
        // fall through to DELAY:30s. The batch (see _selectBatch) is either every
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
            // re-fetch (v2 rule: no defensive defaults).
            if (!packet.buggedJobs) throw new Error('JOB_FLOW: packet.buggedJobs missing (CHECK_CONDITION must run first)');
            const bugged = packet.buggedJobs;
            // Exclude jobs the game already reports finishable (raw.canComplete):
            // READY_TO_COMPLETE (run earlier this cycle) fired their job.complete
            // but does NOT mutate packet.queue, so without this guard _selectBatch
            // could re-dispatch a just-completed file_decryption and re-open its
            // already-decrypted file (no minigame → wasted ~90s).
            const inProgress = packet.queue.filter((j) =>
                j.status === 'TAKEN' && !bugged[j.id] && !(j.raw && j.raw.canComplete === true));
            if (inProgress.length === 0) { this.debug('JOB_FLOW → no in-progress jobs to run'); return; }

            const batch = this._selectBatch(inProgress, p);
            if (batch.jobs.length === 0) {
                this.info(`JOB_FLOW → ${inProgress.length} in-progress job(s), none of a wired type yet — skipping`);
                return;
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

            // Publish the live batch onto AJV2_PIPELINE_STATE so the Jobs UI can
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
                // TRANSIENT failure (timeout, DOM/loadout not ready, flow-busy):
                // skip and retry next cycle — do NOT bug. Bugged jobs are permanent
                // until the user clears them (no TTL), so only a genuine "can't do
                // this job" (retryable:false / absent) is written to the registry.
                if (result.retryable) { this.info(`JOB_FLOW → ${job.id} not done this cycle (${result.reason || 'transient'}) — will retry`); continue; }
                await this._markBugged(job, result.reason || 'flow failed', token);
            }

            // SAI batch end: all actions done, the shared SAI session is no longer
            // needed → complete the actioned jobs now (each complete-flip is safe
            // here — nothing else reads the server afterwards).
            if (deferComplete && toComplete.length) await this._completeBatchJobs(toComplete, token);
            // Batch done → clear the live-batch banner (the next cycle's
            // GET_SERVERS also clears it, this just drops it immediately so the
            // DELAY:30s window shows no stale batch).
            await this._writeState({ batch: null });
            // Whole batch attempted → return → DELAY:30s → next cycle picks the
            // next batch (next server, or the remaining file_decryption).
        }

        // Publish the live batch descriptor onto AJV2_PIPELINE_STATE (read by the
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
        // are relayed into the live pipeline node so the Flow Map highlights
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
                    if (abort) Bus.window.post(C.MSG.AUTOJOBS_V2.FLOW_ABORT, { jobId: payload.jobId });
                    resolve(v);
                };
                const unsubStep = Bus.window.on(C.MSG.AUTOJOBS_V2.FLOW_STEP, (env) => {
                    if (env && env.jobId === payload.jobId && env.node) this._setNode(env.node, token);
                });
                const unsubResult = Bus.window.on(C.MSG.AUTOJOBS_V2.FLOW_RESULT, (env) => {
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
                Bus.window.post(C.MSG.AUTOJOBS_V2.FLOW_START, payload);
            });
        }

        async _markBugged(job, reason, token) {
            await this._setNode(NODE.MARK_AS_BUGGED, token);
            const reg = await Store.local.getOne(SL.AJV2_BUGGED_JOBS, {});
            reg[job.id] = { reason: String(reason), since: Date.now() };
            await Store.local.setOne(SL.AJV2_BUGGED_JOBS, reg);
            this.warn(`MARK_AS_BUGGED ${job.id}: ${reason}`);
        }

        // One-shot board rebuild for the popup Jobs "refresh" button: run the
        // read-only half of the pipeline (servers → access → markets → queue →
        // condition) and republish AJV2_JOB_QUEUE, WITHOUT accepting or running
        // any job. Refused while the loop runs (it already rebuilds each cycle)
        // and debounced against itself. Does not touch the Flow-Map state.
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

        // ── pipeline-state persistence (drives the Flow Map highlight) ─────
        async _setNode(node, token, extra) {
            if (!this._alive(token)) return;
            await this._writeState(Object.assign({ running: true, node }, extra));
        }

        async _writeState(patch) {
            Object.assign(this._state, patch, { updatedAt: Date.now() });
            await Store.local.setOne(SL.AJV2_PIPELINE_STATE, Object.assign({}, this._state));
        }
    }

    Registry.register(new AutoJobsV2Module());
})();
