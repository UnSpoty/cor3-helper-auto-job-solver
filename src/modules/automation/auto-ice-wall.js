// src/modules/automation/auto-ice-wall.js
// Reads chrome.storage.sync.autoIceWallEnabled. When true on boot, starts
// the MAIN-world solver-ice-wall watcher. Reacts to subsequent toggles.
// Same pattern as auto-decrypt.js — just different MSG types.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Store, Registry, constants: C } = root.COR3;

    function start() { Bus.window.post(C.MSG.SOLVER.START_ICE_WALL, null); }
    function stop()  { Bus.window.post(C.MSG.SOLVER.STOP_ICE_WALL,  null); }

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
            const enabled = await Store.sync.getOne(C.STORAGE_SYNC.AUTO_ICE_WALL_ENABLED, false);
            if (enabled) { this.info('starting ice-wall solver'); start(); }

            this.track(Store.sync.onChanged((changes) => {
                const ch = changes[C.STORAGE_SYNC.AUTO_ICE_WALL_ENABLED];
                if (!ch) return;
                if (ch.newValue) { this.info('toggle ON'); start(); }
                else { this.info('toggle OFF'); stop(); }
            }));

            this.info('auto-ice-wall ready');
        }
    }

    Registry.register(new AutoIceWallModule());
})();
