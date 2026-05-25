// Owns: expeditionsData + expeditionsDataUpdatedAt.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Store, Registry, constants: C } = root.COR3;

    class ExpeditionsModule extends Module {
        constructor() {
            super({
                id: 'expeditions',
                name: 'Expeditions',
                category: C.CATEGORY.DATA,
                owns: {
                    storageKeys: [C.STORAGE_LOCAL.EXPEDITIONS, C.STORAGE_LOCAL.EXPEDITIONS_AT],
                    busTypes: [C.MSG.WS.EXPEDITIONS],
                },
            });
        }

        async start() {
            this.track(Bus.window.on(C.MSG.WS.EXPEDITIONS, (env) => {
                if (!Array.isArray(env.expeditions)) return;
                Store.local.set({
                    [C.STORAGE_LOCAL.EXPEDITIONS]: env.expeditions,
                    [C.STORAGE_LOCAL.EXPEDITIONS_AT]: Date.now(),
                });
                this.debug('expeditions', { count: env.expeditions.length });
            }));
        }
    }

    Registry.register(new ExpeditionsModule());
})();
