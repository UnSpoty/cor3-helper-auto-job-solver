// Owns: stashData (and a non-canonical stashDataUpdatedAt).

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Store, Registry, constants: C } = root.COR3;

    class StashModule extends Module {
        constructor() {
            super({
                id: 'stash',
                name: 'Stash',
                category: C.CATEGORY.DATA,
                owns: {
                    storageKeys: [C.STORAGE_LOCAL.STASH],
                    busTypes: [C.MSG.WS.STASH],
                },
            });
        }

        async start() {
            this.track(Bus.window.on(C.MSG.WS.STASH, (env) => {
                if (!env.stash) return;
                Store.local.set({
                    [C.STORAGE_LOCAL.STASH]: env.stash,
                    stashDataUpdatedAt: Date.now(),
                });
                const usage = env.stash.currentUsage;
                const cap = env.stash.maxCapacity;
                this.debug('stash frame', { usage, cap });
            }));
        }
    }

    Registry.register(new StashModule());
})();
