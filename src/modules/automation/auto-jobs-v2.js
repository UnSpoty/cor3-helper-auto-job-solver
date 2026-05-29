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
// JOB_FLOW dispatches ONE in-progress (TAKEN) job per cycle to its MAIN-world
// flow-v2 module (FLOW_START) and parks on FLOW_RESULT — so the loop pauses for
// that job's minigame, then goes to DELAY:30s and the next cycle handles the
// next job. file_decryption is wired; other types are skipped until their
// flow-v2 module lands. A flow that can't do the job (no decrypt capability /
// file missing / timeout) is written to AJV2_BUGGED_JOBS (MARK_AS_BUGGED).
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
                    ],
                },
            });
            this._running = false;
            this._runToken = 0;
            this._state = { running: false, cycle: 0, node: null, startedAt: null, updatedAt: null, error: null };
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
            this.info(`${label} → ${serverName || 'home'}`);
            Bus.window.post(windowType, { serverName });
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
            this._writeState({ running: false, node: null });
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

            await this._setNode(NODE.GET_SERVERS, token, { cycle, error: null });
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

        // Run exactly ONE in-progress (TAKEN) job this cycle, then fall through
        // to DELAY:30s — the next cycle picks up the next one. (One job per
        // cycle: solve → complete → wait, rather than draining all accepted
        // jobs in a single JOB_FLOW pass.) Bugged jobs were filtered before
        // JOB:SKIP; we re-check here so a job bugged earlier this cycle is
        // skipped.
        async _runJobFlows(token, cycle, packet) {
            const p = pipeline();
            const bugged = packet.buggedJobs || await Store.local.getOne(SL.AJV2_BUGGED_JOBS, {});
            const inProgress = packet.queue.filter((j) => j.status === 'TAKEN' && !bugged[j.id]);
            if (inProgress.length === 0) { this.debug('JOB_FLOW → no in-progress jobs to run'); return; }

            // Pick the first in-progress job of a supported type. (Only
            // file_decryption is wired so far.)
            const job = inProgress.find((j) => j.type === C.FLOW.FILE_DECRYPTION);
            if (!job) {
                this.info(`JOB_FLOW → ${inProgress.length} in-progress job(s), none of a supported type yet — skipping`);
                return;
            }
            this.info(`JOB_FLOW → running 1 of ${inProgress.length} in-progress job(s) this cycle`);

            const fileCondition = p.fileConditionForDecrypt(job.raw);
            if (!fileCondition) { await this._markBugged(job, 'no file condition in job', token); return; }

            this.info(`JOB_FLOW → dispatch file_decryption ${job.id} "${fileCondition}"`);
            // NOTE: the payload field is `jobType`, NOT `type` — Bus.window
            // builds the envelope as Object.assign({type}, payload), so a
            // payload key named `type` would clobber the Bus message type and
            // the message would never reach the flow's listener.
            const result = await this._dispatchFlow({
                jobId: job.id, marketId: job.marketId, jobType: job.type, fileCondition,
            }, token);
            if (!this._alive(token)) return;

            if (!result) { await this._markBugged(job, 'flow timed out — no FLOW_RESULT', token); return; }
            if (result.success && result.didWork) {
                this.info(`JOB_FLOW → ${job.id} completed`);
            } else if (result.success && !result.didWork) {
                await this._markBugged(job, result.reason || 'nothing to do', token);
            } else {
                await this._markBugged(job, result.reason || 'flow failed', token);
            }
            // One job done → return → DELAY:30s → next cycle handles the next.
        }

        // Post FLOW_START to MAIN and resolve with the matching FLOW_RESULT, or
        // null on timeout. While the flow runs, relay its FLOW_STEP messages
        // into the live pipeline node so the Flow Map highlights the sub-step
        // the MAIN flow is on. Cancellation is handled by the caller's _alive.
        _dispatchFlow(payload, token) {
            return new Promise((resolve) => {
                let settled = false;
                const finish = (v) => {
                    if (settled) return;
                    settled = true;
                    try { unsubResult(); } catch (_) { /* noop */ }
                    try { unsubStep(); } catch (_) { /* noop */ }
                    clearTimeout(timer);
                    resolve(v);
                };
                const unsubStep = Bus.window.on(C.MSG.AUTOJOBS_V2.FLOW_STEP, (env) => {
                    if (env && env.jobId === payload.jobId && env.node) this._setNode(env.node, token);
                });
                const unsubResult = Bus.window.on(C.MSG.AUTOJOBS_V2.FLOW_RESULT, (env) => {
                    if (env && env.jobId === payload.jobId) finish(env);
                });
                const timer = setTimeout(() => finish(null), LOOP.FLOW_TIMEOUT_MS);
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

        _ctx(token) {
            return {
                store: Store,
                bus: Bus,
                C,
                // Lets long-running stages (JOB_ACCEPTION's paced accept batch)
                // bail the instant STOP invalidates this run.
                alive: () => this._alive(token),
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
