// src/modules/automation/anti-afk.js
// Bridges the Overview "Anti-AFK" toggle
// (chrome.storage.sync.antiAfkEnabled, default OFF) to the MAIN-world anti-afk
// module, which has no chrome.storage access. Same pattern as
// appearance/loadout-widget.js: read on boot, react to changes, post the
// verdict over Bus.window (MSG.UI.ANTI_AFK, payload { enabled }).
//
// The MAIN module then keeps cor3.gg awake past its 5-minute inactivity Sleep
// Mode (synthetic activity tick + auto-exit of the sleep overlay).

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Store, Registry, constants: C } = root.COR3;

    function post(enabled) {
        Bus.window.post(C.MSG.UI.ANTI_AFK, { enabled: !!enabled });
    }

    class AntiAfkBridgeModule extends Module {
        constructor() {
            super({
                id: 'anti-afk-bridge',
                name: 'Anti-AFK bridge',
                category: C.CATEGORY.AUTOMATION,
                owns: { storageKeys: [C.STORAGE_SYNC.ANTI_AFK_ENABLED] },
            });
        }

        async start() {
            // Default OFF. The MAIN module boots at document_start (before this
            // isolated module at document_idle) and waits for this verdict
            // rather than assuming a default.
            const enabled = await Store.sync.getOne(C.STORAGE_SYNC.ANTI_AFK_ENABLED, false);
            post(enabled);

            this.track(Store.sync.onSettingChange(C.STORAGE_SYNC.ANTI_AFK_ENABLED, (newValue) => {
                this.info(newValue ? 'anti-afk ON' : 'anti-afk OFF');
                post(newValue);
            }));

            this.info(`anti-afk ${enabled ? 'enabled' : 'disabled (default)'}`);
        }
    }

    Registry.register(new AntiAfkBridgeModule());
})();
