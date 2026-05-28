// Auto-Jobs v2 — orchestrator.
//
// The one registered module for the v2 subsystem (id 'auto-jobs-v2', so all
// its logs and the stages' logs land in the v2 Activity Log). It does NOT
// implement job logic itself — it drives the flowchart:
//
//   START → DELAY:10s → ┌─ GET_SERVERS → CHECK_SERVERS_ACCESABILITY
//                       │   → UPDATE_MARKETS → JOB_QUEUE → <QUEUE:EMPTY?>
//                       │        YES ─────────────────────────────┐
//                       │        NO → BUGGED_JOBS → CHECK_CONDITION│
//                       └──────────────── DELAY:30s ←──────────────┘   (loop)
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
                        C.MSG.GAME.REFRESH_MARKET,
                        C.MSG.GAME.REFRESH_DARK_MARKET,
                        C.MSG.GAME.REFRESH_SRM_MARKET,
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

            const settings = await Store.sync.getOne(SS.AUTOJOBS_V2_SETTINGS, { enabled: false });
            this._applyEnabled(!!settings.enabled);
        }

        async stop() {
            this._stopLoop();
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
            const ctx = this._ctx();
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

            await this._setNode(NODE.BUGGED_JOBS, token, { cycle });
            packet = await p.stages.buggedJobs.run(packet, ctx);
            if (!this._alive(token)) return;

            await this._setNode(NODE.CHECK_CONDITION, token, { cycle });
            packet = await p.stages.checkCondition.run(packet, ctx);
        }

        _ctx() {
            return {
                store: Store,
                bus: Bus,
                C,
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
