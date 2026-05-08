// src/modules/data/mercenaries.js
// Owns: mercenariesData + mercenariesUpdatedAt.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Store, Registry, constants: C } = root.COR3;

    class MercenariesModule extends Module {
        constructor() {
            super({
                id: 'mercenaries',
                name: 'Mercenaries',
                category: C.CATEGORY.DATA,
                owns: {
                    storageKeys: [C.STORAGE_LOCAL.MERCENARIES, C.STORAGE_LOCAL.MERCENARIES_AT],
                    busTypes: [C.MSG.WS.MERCENARIES],
                },
            });
        }

        async start() {
            this.track(Bus.window.on(C.MSG.WS.MERCENARIES, (env) => {
                if (!env.data) return;
                Store.local.set({
                    [C.STORAGE_LOCAL.MERCENARIES]: env.data,
                    [C.STORAGE_LOCAL.MERCENARIES_AT]: Date.now(),
                });
                const list = Array.isArray(env.data) ? env.data : env.data.mercenaries;
                this.debug('mercenaries frame', { count: Array.isArray(list) ? list.length : 0 });
            }));
        }
    }

    Registry.register(new MercenariesModule());
})();
