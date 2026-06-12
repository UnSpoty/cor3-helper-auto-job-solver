// src/modules/appearance/loadout-widget.js
// Bridges the Overview "Show LOADOUT widget" toggle
// (chrome.storage.sync.showLoadoutWidget, default OFF) to the MAIN-world
// loadout-panel module, which has no chrome.storage access. Same pattern as
// auto-ice-wall.js: read on boot, react to changes, post the verdict over
// Bus.window (MSG.UI.SHOW_LOADOUT_WIDGET, payload { visible }).
//
// Hiding removes ONLY the injected pill/panel DOM. The headless
// COR3.game.loadout API (ensureDecrypt/ensureHack — Auto Jobs depends on it)
// lives on the loadout-panel module instance and stays functional either way.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Store, Registry, constants: C } = root.COR3;

    function post(visible) {
        Bus.window.post(C.MSG.UI.SHOW_LOADOUT_WIDGET, { visible: !!visible });
    }

    class LoadoutWidgetToggleModule extends Module {
        constructor() {
            super({
                id: 'appearance-loadout-widget',
                name: 'LOADOUT widget visibility',
                category: C.CATEGORY.APPEARANCE,
                owns: { storageKeys: [C.STORAGE_SYNC.SHOW_LOADOUT_WIDGET] },
            });
        }

        async start() {
            // Default OFF: the MAIN-world panel injects nothing until told to.
            // This initial post is the one the MAIN module relies on — it boots
            // at document_start (before this isolated module at document_idle)
            // and waits for the verdict rather than assuming a default.
            const enabled = await Store.sync.getOne(C.STORAGE_SYNC.SHOW_LOADOUT_WIDGET, false);
            post(enabled);

            this.track(Store.sync.onSettingChange(C.STORAGE_SYNC.SHOW_LOADOUT_WIDGET, (newValue) => {
                this.info(newValue ? 'LOADOUT widget ON' : 'LOADOUT widget OFF');
                post(newValue);
            }));

            this.info(`loadout widget ${enabled ? 'visible' : 'hidden (default)'}`);
        }
    }

    Registry.register(new LoadoutWidgetToggleModule());
})();
