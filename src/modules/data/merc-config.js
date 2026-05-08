// src/modules/data/merc-config.js
// Owns: mercConfigData (per-mercenary cost/risk) + mercConfigUpdatedAt.
// Each WS_MERC_CONFIGURE event corresponds to ONE mercenary; we merge into
// the existing map rather than replacing the whole thing.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Store, Registry, constants: C } = root.COR3;

    class MercConfigModule extends Module {
        constructor() {
            super({
                id: 'merc-config',
                name: 'Mercenary Config',
                category: C.CATEGORY.DATA,
                owns: {
                    storageKeys: [C.STORAGE_LOCAL.MERC_CONFIG, C.STORAGE_LOCAL.MERC_CONFIG_AT],
                    busTypes: [C.MSG.WS.MERC_CONFIGURE],
                },
            });
        }

        async start() {
            this.track(Bus.window.on(C.MSG.WS.MERC_CONFIGURE, async (env) => {
                if (!env.mercenaryId || !env.data) return;
                const configs = (await Store.local.getOne(C.STORAGE_LOCAL.MERC_CONFIG, {})) || {};
                configs[env.mercenaryId] = env.data;
                await Store.local.set({
                    [C.STORAGE_LOCAL.MERC_CONFIG]: configs,
                    [C.STORAGE_LOCAL.MERC_CONFIG_AT]: Date.now(),
                });
                this.debug('merc config', {
                    mercId: env.mercenaryId,
                    cost: env.data && env.data.totalCost,
                    risk: env.data && env.data.riskScore,
                });
            }));
        }
    }

    Registry.register(new MercConfigModule());
})();
