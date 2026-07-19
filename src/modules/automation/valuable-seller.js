// src/modules/automation/valuable-seller.js
// Valuable Seller ORCHESTRATOR (isolated world). The thin half that owns the
// storage + guards; the actual scan/download/sell work runs in the MAIN-world
// engine (src/modules/game/valuable-seller.js) over MSG.VALUABLE.*.
//
// Responsibilities:
//   • popup runtime actions (vsScan / vsSell / vsStop / vsSelect) → validate,
//     compute the scan candidate list off NM_GRAPH (live transit-rule BFS —
//     COR3.autoJobs.reachability, the same verdict Auto Jobs enforces; no
//     hardcoded topology like the competitor's SERVER_PATH_MAP), dispatch to
//     the MAIN engine.
//   • mirror the engine's progress stream (SERVER_RESULT / DOWNLOADS_RESULT /
//     PROGRESS / DONE) into STORAGE_LOCAL.VS_STATE for the popup Valuables tab.
//   • mutual exclusion: refuse to start while the Auto Jobs loop runs
//     (AJ_PIPELINE_STATE.running) — the two subsystems share the endpoint and
//     the SAI session; the engine additionally holds __cor3FlowLock in MAIN.
//
// Owned storage: STORAGE_LOCAL.VS_STATE.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Store, Registry, constants: C } = root.COR3;
    const VS = C.MSG.VALUABLE;
    const LOG_CAP = 80;

    class ValuableSellerModule extends Module {
        constructor() {
            super({
                id: 'valuable-seller',
                name: 'Valuable Seller',
                category: C.CATEGORY.AUTOMATION,
                owns: {
                    storageKeys: [C.STORAGE_LOCAL.VS_STATE],
                    busTypes: [VS.SCAN_START, VS.SELL_START, VS.STOP],
                },
            });
            this._state = null;
            this._persistTimer = null;
        }

        // ── VS_STATE persistence (trailing debounce — PROGRESS lines arrive
        // about once a second during a run; one storage write per burst). ──
        _persist(immediate) {
            this._state.updatedAt = Date.now();
            if (immediate) {
                if (this._persistTimer) { clearTimeout(this._persistTimer); this._persistTimer = null; }
                Store.local.setOne(C.STORAGE_LOCAL.VS_STATE, this._state);
                return;
            }
            if (this._persistTimer) return;
            this._persistTimer = setTimeout(() => {
                this._persistTimer = null;
                Store.local.setOne(C.STORAGE_LOCAL.VS_STATE, this._state);
            }, 200);
        }

        _log(level, msg) {
            this._state.log.push({ ts: Date.now(), level, msg });
            if (this._state.log.length > LOG_CAP) this._state.log.splice(0, this._state.log.length - LOG_CAP);
        }

        // Scan candidates off the live NM graph: every reachable, non-K/D,
        // non-HOME server, FURTHEST first (deep leaves before hubs — a hub
        // going K/D mid-run cuts off less of the remaining work that way).
        // Reachability is the shared transit-rule BFS — the exact set
        // set.endpoint will accept this cycle.
        async _candidates() {
            const g = await Store.local.getOne(C.STORAGE_LOCAL.NM_GRAPH);
            if (!g || !Array.isArray(g.servers) || !g.home) return { error: 'no-nm-graph' };
            const reach = root.COR3.autoJobs && root.COR3.autoJobs.reachability;
            if (!reach) return { error: 'no-reachability' };
            const reachable = reach.reachableSet(g.servers, g.connections || [], g.home);
            const list = g.servers
                .filter((s) => s && s.name && s.name !== g.home && reachable.has(s.name) && !s.isInMaintenance)
                .map((s) => ({ id: s.id, name: s.name, serverType: s.serverTypeName, depth: (typeof s.depth === 'number') ? s.depth : -1 }))
                .sort((a, b) => b.depth - a.depth);
            return { list };
        }

        async _guard() {
            if (this._state.running) return 'already-running';
            const aj = await Store.local.getOne(C.STORAGE_LOCAL.AJ_PIPELINE_STATE);
            if (aj && aj.running) return 'auto-jobs-running';
            return null;
        }

        async start() {
            this._state = (await Store.local.getOne(C.STORAGE_LOCAL.VS_STATE)) || {
                running: false, mode: null, startedAt: null, updatedAt: null,
                scannedAt: null, servers: [], downloads: [], log: [],
                lastRun: null, lifetime: { credits: 0, rep: 0, items: 0 },
            };
            // Back-fill counters for a VS_STATE saved before they existed.
            if (!this._state.lifetime) this._state.lifetime = { credits: 0, rep: 0, items: 0 };
            if (this._state.lastRun === undefined) this._state.lastRun = null;
            // A page reload mid-run leaves running:true behind with no engine
            // alive — reset so the popup buttons aren't dead-locked.
            if (this._state.running) { this._state.running = false; this._state.mode = null; this._log('warn', 'run interrupted by page reload'); this._persist(true); }

            // ── popup runtime actions ─────────────────────────────────────
            this.track(Bus.runtime.on(VS.SCAN_ACTION, async () => {
                const blocked = await this._guard();
                if (blocked) return { success: false, reason: blocked };
                const cand = await this._candidates();
                if (cand.error) return { success: false, reason: cand.error };
                // A new scan clears the server board + downloads but PRESERVES
                // the profit counters (lastRun + lifetime) and scannedAt.
                this._state = {
                    running: true, mode: 'scan', startedAt: Date.now(), updatedAt: null,
                    scannedAt: this._state.scannedAt,
                    lastRun: this._state.lastRun || null,
                    lifetime: this._state.lifetime || { credits: 0, rep: 0, items: 0 },
                    servers: cand.list.map((s) => ({ ...s, status: 'pending', selected: false, files: [], logs: [] })),
                    downloads: [], log: [],
                };
                this._log('info', `scan dispatched — ${cand.list.length} server(s)`);
                this._persist(true);
                Bus.window.post(VS.SCAN_START, { servers: cand.list });
                this.info(`scan dispatched (${cand.list.length} servers)`);
                return { success: true, count: cand.list.length };
            }));

            this.track(Bus.runtime.on(VS.SELL_ACTION, async (payload) => {
                const blocked = await this._guard();
                if (blocked) return { success: false, reason: blocked };
                const ids = new Set((payload && payload.serverIds) || []);
                const servers = this._state.servers
                    .filter((s) => ids.has(s.id))
                    .map((s) => ({ id: s.id, name: s.name, serverType: s.serverType, depth: s.depth }));
                this._state.running = true;
                this._state.mode = 'sell';
                this._state.startedAt = Date.now();
                this._log('info', `sell dispatched — ${servers.length} server(s)`);
                this._persist(true);
                Bus.window.post(VS.SELL_START, { servers, minPrice: (payload && payload.minPrice) || 0 });
                this.info(`sell dispatched (${servers.length} servers)`);
                return { success: true, count: servers.length };
            }));

            // NOTE: async handlers — Bus.runtime only relays PROMISE results
            // back to the sender (a sync return value is dropped), and the
            // popup reads the reply to surface refusals.
            this.track(Bus.runtime.on(VS.STOP_ACTION, async () => {
                if (!this._state.running) return { success: false, reason: 'not-running' };
                Bus.window.post(VS.STOP, {});
                this._log('warn', 'stop requested');
                this._persist(true);
                return { success: true };
            }));

            this.track(Bus.runtime.on(VS.SELECT_ACTION, async (payload) => {
                const s = this._state.servers.find((x) => x.id === (payload && payload.serverId));
                if (!s) return { success: false, reason: 'unknown-server' };
                s.selected = !!payload.selected;
                this._persist(true);
                return { success: true };
            }));

            // ── engine progress stream ────────────────────────────────────
            this.track(Bus.window.on(VS.SERVER_RESULT, (env) => {
                if (!env || !env.serverId) return;
                const s = this._state.servers.find((x) => x.id === env.serverId);
                if (!s) return;
                s.status = env.status;
                s.reason = env.reason || null;
                s.files = env.files || [];
                s.logs = env.logs || [];
                // Fresh scan finds default to SELECTED — the common path is
                // "scan → sell everything found"; unticking is the exception.
                if (env.status === 'open') s.selected = true;
                this._persist();
            }));

            this.track(Bus.window.on(VS.DOWNLOADS_RESULT, (env) => {
                this._state.downloads = (env && env.files) || [];
                this._persist();
            }));

            this.track(Bus.window.on(VS.PROGRESS, (env) => {
                if (!env || !env.msg) return;
                this._log(env.level || 'info', env.msg);
                this._persist();
            }));

            this.track(Bus.window.on(VS.DONE, (env) => {
                this._state.running = false;
                this._state.mode = null;
                if (env && env.mode === 'scan' && env.ok) this._state.scannedAt = Date.now();
                if (env && env.mode === 'sell') {
                    // Attribute the run's earnings (exact per-item price/rep from
                    // the engine) to lastRun + accumulate into lifetime.
                    const credits = Number(env.credits) || 0;
                    const rep = Number(env.rep) || 0;
                    const items = Number(env.sold) || 0;
                    this._state.lastRun = { credits, rep, items, at: Date.now() };
                    const lt = this._state.lifetime || { credits: 0, rep: 0, items: 0 };
                    lt.credits += credits; lt.rep += rep; lt.items += items;
                    this._state.lifetime = lt;
                }
                if (env && !env.ok && env.reason) this._log('warn', `${env.mode || 'run'} ended: ${env.reason}`);
                else this._log('info', `${(env && env.mode) || 'run'} finished${env && env.sold != null ? ` — ${env.sold} sold, +${Number(env.credits) || 0} CR` : ''}`);
                this._persist(true);
                this.info(`engine DONE: ${JSON.stringify(env || {})}`);
            }));

            this.info('valuable-seller orchestrator ready');
        }
    }

    Registry.register(new ValuableSellerModule());
})();
