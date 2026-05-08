// src/modules/data/decisions.js
// Owns: expeditionDecisions. Replaces the full list on every WS push (the
// interceptor sends an empty array on launch to clear stale decisions).

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Store, Registry, constants: C } = root.COR3;

    class DecisionsModule extends Module {
        constructor() {
            super({
                id: 'decisions',
                name: 'Expedition Decisions',
                category: C.CATEGORY.DATA,
                owns: {
                    storageKeys: [C.STORAGE_LOCAL.DECISIONS],
                    busTypes: [C.MSG.WS.DECISIONS],
                },
            });
        }

        async start() {
            this.track(Bus.window.on(C.MSG.WS.DECISIONS, (env) => {
                if (!Array.isArray(env.decisions)) return;
                Store.local.setOne(C.STORAGE_LOCAL.DECISIONS, env.decisions);
                this.debug('decisions', { count: env.decisions.length });
            }));
        }
    }

    Registry.register(new DecisionsModule());
})();
