// Owns: marketData + marketDataUpdatedAt (HOME market only).

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Store, Registry, constants: C } = root.COR3;

    class MarketModule extends Module {
        constructor() {
            super({
                id: 'market',
                name: 'Home Market',
                category: C.CATEGORY.DATA,
                owns: {
                    storageKeys: [C.STORAGE_LOCAL.MARKET, C.STORAGE_LOCAL.MARKET_AT],
                    busTypes: [C.MSG.WS.MARKET],
                },
            });
        }

        async start() {
            this.track(Bus.window.on(C.MSG.WS.MARKET, (env) => {
                if (!env.market) return;
                Store.local.set({
                    [C.STORAGE_LOCAL.MARKET]: env.market,
                    [C.STORAGE_LOCAL.MARKET_AT]: Date.now(),
                });
                // env.market shape: { marketId, jobs, recentJobs, nextJobsResetAt }
                const jobCount = Array.isArray(env.market?.jobs) ? env.market.jobs.length : 0;
                this.debug('market frame', { jobs: jobCount });
            }));
        }
    }

    Registry.register(new MarketModule());
})();
