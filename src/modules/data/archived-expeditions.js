// Owns: archivedExpeditionsData + archivedExpeditionsUpdatedAt.
// Stores the most recent paginated fetch from expeditions:get.archived.
// Rendered by the Expeditions UI tab under "Recent runs" —
// see src/ui/sections/expeditions.js.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Store, Registry, constants: C } = root.COR3;

    class ArchivedExpeditionsModule extends Module {
        constructor() {
            super({
                id: 'archived-expeditions',
                name: 'Archived Expeditions',
                category: C.CATEGORY.DATA,
                owns: {
                    storageKeys: [
                        C.STORAGE_LOCAL.ARCHIVED_EXPEDITIONS,
                        C.STORAGE_LOCAL.ARCHIVED_EXPEDITIONS_AT,
                    ],
                    busTypes: [C.MSG.WS.ARCHIVED_EXPEDITIONS],
                },
            });
        }

        async start() {
            this.track(Bus.window.on(C.MSG.WS.ARCHIVED_EXPEDITIONS, (env) => {
                if (!Array.isArray(env.expeditions)) return;
                Store.local.set({
                    [C.STORAGE_LOCAL.ARCHIVED_EXPEDITIONS]: env.expeditions,
                    [C.STORAGE_LOCAL.ARCHIVED_EXPEDITIONS_AT]: Date.now(),
                });
                this.debug('archived expeditions', { count: env.expeditions.length });
            }));
        }
    }

    Registry.register(new ArchivedExpeditionsModule());
})();
