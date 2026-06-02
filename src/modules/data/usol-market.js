// src/modules/data/usol-market.js
// Owns: usolMarketData, usolMarketAvailable, usolMarketDataUpdatedAt.
// URM7-M is a USOL-faction public server with canSetEndpoint:true; the
// market behaves like Dark Market — get.jobs by marketId works without
// the user having to actually connect to the server first. Mirror of
// srm-market.js — kept as a sibling rather than parametrised so the
// market table stays a plain file-per-market copy.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Store, Registry, constants: C } = root.COR3;

    class UsolMarketModule extends Module {
        constructor() {
            super({
                id: 'usol-market',
                name: 'URM7-M Market',
                category: C.CATEGORY.DATA,
                owns: {
                    storageKeys: [
                        C.STORAGE_LOCAL.USOL_MARKET,
                        C.STORAGE_LOCAL.USOL_MARKET_AT,
                        C.STORAGE_LOCAL.USOL_MARKET_AVAILABLE,
                    ],
                    busTypes: [C.MSG.WS.USOL_MARKET, C.MSG.WS.USOL_MARKET_UNREACHABLE],
                },
            });
        }

        async start() {
            this.track(Bus.window.on(C.MSG.WS.USOL_MARKET, (env) => {
                if (!env.market) return;
                Store.local.set({
                    [C.STORAGE_LOCAL.USOL_MARKET]: env.market,
                    [C.STORAGE_LOCAL.USOL_MARKET_AVAILABLE]: true,
                    [C.STORAGE_LOCAL.USOL_MARKET_AT]: Date.now(),
                });
                const jobCount = Array.isArray(env.market?.jobs) ? env.market.jobs.length : 0;
                this.debug('usol market frame', { jobs: jobCount });
            }));
            this.track(Bus.window.on(C.MSG.WS.USOL_MARKET_UNREACHABLE, (env) => {
                Store.local.set({
                    [C.STORAGE_LOCAL.USOL_MARKET_AVAILABLE]: false,
                    [C.STORAGE_LOCAL.USOL_MARKET_AT]: Date.now(),
                });
                this.warn('usol market unreachable', { error: env.error, serverId: env.serverId });
            }));
        }
    }

    Registry.register(new UsolMarketModule());
})();
