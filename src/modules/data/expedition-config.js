// src/modules/data/expedition-config.js
// Owns: expeditionConfigData (locations/zones/objectives) + …UpdatedAt.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Store, Registry, constants: C } = root.COR3;

    class ExpeditionConfigModule extends Module {
        constructor() {
            super({
                id: 'expedition-config',
                name: 'Expedition Config',
                category: C.CATEGORY.DATA,
                owns: {
                    storageKeys: [C.STORAGE_LOCAL.EXPEDITION_CONFIG, C.STORAGE_LOCAL.EXPEDITION_CONFIG_AT],
                    busTypes: [C.MSG.WS.EXPEDITION_CONFIG],
                },
            });
        }

        async start() {
            this.track(Bus.window.on(C.MSG.WS.EXPEDITION_CONFIG, (env) => {
                if (!env.data) return;
                Store.local.set({
                    [C.STORAGE_LOCAL.EXPEDITION_CONFIG]: env.data,
                    [C.STORAGE_LOCAL.EXPEDITION_CONFIG_AT]: Date.now(),
                });
                const locs = (env.data && env.data.locations) || [];
                this.debug('expedition config', { locations: locs.length });
            }));
        }
    }

    Registry.register(new ExpeditionConfigModule());
})();
