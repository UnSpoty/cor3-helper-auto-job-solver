// src/modules/automation/auto-decrypt.js
// Reads chrome.storage.sync.autoDecryptEnabled. When true on boot, sends
// COR3_START_DECRYPT_SOLVER to MAIN. Reacts to subsequent toggles.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Store, Registry, constants: C } = root.COR3;

    // owner:'user' — the standalone toggle. solver-decrypt ref-counts owners so
    // this watcher survives an Auto-Jobs v2 flow's STOP (owner:'flow') and vice-versa.
    function start() { Bus.window.post(C.MSG.SOLVER.START_DECRYPT, { owner: 'user' }); }
    function stop() { Bus.window.post(C.MSG.SOLVER.STOP_DECRYPT, { owner: 'user' }); }

    class AutoDecryptModule extends Module {
        constructor() {
            super({
                id: 'auto-decrypt',
                name: 'Auto-decrypt solver',
                category: C.CATEGORY.AUTOMATION,
                owns: { storageKeys: [C.STORAGE_SYNC.AUTO_DECRYPT_ENABLED] },
            });
        }
        async start() {
            const enabled = await Store.sync.getOne(C.STORAGE_SYNC.AUTO_DECRYPT_ENABLED, false);
            if (enabled) { this.info('starting decrypt solver'); start(); }

            this.track(Store.sync.onSettingChange(C.STORAGE_SYNC.AUTO_DECRYPT_ENABLED, (newValue) => {
                if (newValue) { this.info('toggle ON'); start(); }
                else { this.info('toggle OFF'); stop(); }
            }));

            // Legacy popup toggle support: chrome.runtime action
            this.track(Bus.runtime.on('toggleDecryptSolver', (payload) => {
                if (payload && payload.enabled) start(); else stop();
                return { success: true };
            }));
            this.info('auto-decrypt ready');
        }
    }

    Registry.register(new AutoDecryptModule());
})();
