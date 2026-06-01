// src/modules/automation/auto-ice-wall.js
// Reads chrome.storage.sync.autoIceWallEnabled. When true on boot, starts
// the MAIN-world solver-ice-wall watcher. Reacts to subsequent toggles.
// Same pattern as auto-decrypt.js — just different MSG types.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Store, Registry, constants: C } = root.COR3;

    // owner:'user' — the standalone toggle. solver-ice-wall ref-counts owners so
    // this watcher survives an Auto Jobs flow's STOP (owner:'flow') and vice-versa.
    function start() { Bus.window.post(C.MSG.SOLVER.START_ICE_WALL, { owner: 'user' }); }
    function stop()  { Bus.window.post(C.MSG.SOLVER.STOP_ICE_WALL,  { owner: 'user' }); }

    class AutoIceWallModule extends Module {
        constructor() {
            super({
                id: 'auto-ice-wall',
                name: 'Auto ICE WALL solver',
                category: C.CATEGORY.AUTOMATION,
                owns: { storageKeys: [C.STORAGE_SYNC.AUTO_ICE_WALL_ENABLED] },
            });
        }
        async start() {
            // Default ON: the ICE WALL solver watches + solves whenever a puzzle
            // appears, independently of Auto Jobs. When this toggle is OFF the
            // 'user' owner is absent, so an Auto Jobs flow that turns the solver
            // on for a hack (owner 'flow') turns it back off when it finishes —
            // a manually-opened ICE WALL afterwards is NOT auto-solved.
            const enabled = await Store.sync.getOne(C.STORAGE_SYNC.AUTO_ICE_WALL_ENABLED, true);
            if (enabled) { this.info('starting ice-wall solver (standalone, default on)'); start(); }

            this.track(Store.sync.onSettingChange(C.STORAGE_SYNC.AUTO_ICE_WALL_ENABLED, (newValue) => {
                if (newValue) { this.info('toggle ON'); start(); }
                else { this.info('toggle OFF'); stop(); }
            }));

            // ── Learned ICE WALL click-DB persistence (on behalf of the MAIN
            // solver, which has no chrome.storage). Reply to its load request,
            // and persist each learned shape→click. ──
            this.track(Bus.window.on(C.MSG.SOLVER.ICE_WALL_DB_REQUEST, async () => {
                const db = await Store.local.getOne(C.STORAGE_LOCAL.ICE_WALL_CLICK_DB, {});
                Bus.window.post(C.MSG.SOLVER.ICE_WALL_DB, { db: db || {} });
            }));

            // Serialize learn-writes: the MAIN solver fires one ICE_WALL_LEARN per
            // solved round, and a full puzzle solves several in rapid succession.
            // Un-chained, two handlers would both read the same baseline DB and the
            // later setOne would drop the earlier round's shape (last-writer-wins).
            // A promise chain makes each read-modify-write see the prior result.
            let writeChain = Promise.resolve();
            this.track(Bus.window.on(C.MSG.SOLVER.ICE_WALL_LEARN, (env) => {
                if (!env || !env.key || !env.entry) return;
                writeChain = writeChain.then(async () => {
                    const db = (await Store.local.getOne(C.STORAGE_LOCAL.ICE_WALL_CLICK_DB, {})) || {};
                    db[env.key] = env.entry;
                    await Store.local.setOne(C.STORAGE_LOCAL.ICE_WALL_CLICK_DB, db);
                    this.debug(`ice-wall: learned shape saved (${Object.keys(db).length} total)`);
                }).catch((e) => this.warn(`ice-wall: learn write failed: ${String(e)}`));
            }));

            // Propagate EVERY change of the stored DB to the LIVE MAIN solver,
            // which otherwise keeps its in-memory DB until the next start(). This
            // covers the Overview "Clear base" (writes {}) AND a popup EDIT of a
            // shape's click cell — both take effect immediately. Pushing the
            // freshly-written value is safe even mid-solve: the storage write that
            // fires this already includes any just-learned entry (the learn write
            // completes before onChanged), so a re-push during solving is a
            // no-op, not a regression.
            this.track(Store.local.onChanged((changes) => {
                const ch = changes[C.STORAGE_LOCAL.ICE_WALL_CLICK_DB];
                if (!ch) return;
                const nv = ch.newValue || {};
                Bus.window.post(C.MSG.SOLVER.ICE_WALL_DB, { db: nv });
                this.debug(`ice-wall: DB change pushed to solver (${Object.keys(nv).length} shape(s))`);
            }));

            // The MAIN solver posts ICE_WALL_DB_REQUEST at document_start, BEFORE
            // this isolated listener is registered (document_idle), so that request
            // is dropped. Push the DB unprompted now (this module starts after MAIN)
            // so the solver gets its learned base without depending on that request.
            const initialDb = await Store.local.getOne(C.STORAGE_LOCAL.ICE_WALL_CLICK_DB, {});
            Bus.window.post(C.MSG.SOLVER.ICE_WALL_DB, { db: initialDb || {} });

            this.info('auto-ice-wall ready');
        }
    }

    Registry.register(new AutoIceWallModule());
})();
