// src/modules/automation/auto-simple-decrypt.js
// Reads chrome.storage.sync.autoSimpleDecryptEnabled. When true on boot,
// sends COR3_START_SIMPLE_DECRYPT to MAIN. Reacts to subsequent toggles.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Store, Registry, constants: C } = root.COR3;

    // owner:'user' — the standalone toggle. solver-simple-decrypt ref-counts owners
    // so this watcher survives an Auto-Jobs v2 flow's STOP (owner:'flow') and vice-versa.
    function start() { Bus.window.post(C.MSG.SOLVER.START_SIMPLE_DECRYPT, { owner: 'user' }); }
    function stop() { Bus.window.post(C.MSG.SOLVER.STOP_SIMPLE_DECRYPT, { owner: 'user' }); }

    class AutoSimpleDecryptModule extends Module {
        constructor() {
            super({
                id: 'auto-simple-decrypt',
                name: 'Auto-simple-decrypt solver',
                category: C.CATEGORY.AUTOMATION,
                owns: { storageKeys: [C.STORAGE_SYNC.AUTO_SIMPLE_DECRYPT_ENABLED] },
            });
        }
        async start() {
            const enabled = await Store.sync.getOne(C.STORAGE_SYNC.AUTO_SIMPLE_DECRYPT_ENABLED, false);
            if (enabled) { this.info('starting simple-decrypt solver'); start(); }

            this.track(Store.sync.onSettingChange(C.STORAGE_SYNC.AUTO_SIMPLE_DECRYPT_ENABLED, (newValue) => {
                if (newValue) { this.info('toggle ON'); start(); }
                else { this.info('toggle OFF'); stop(); }
            }));

            this.info('auto-simple-decrypt ready');
        }
    }

    Registry.register(new AutoSimpleDecryptModule());
})();
