// src/modules/data/srm-market.js
// Owns: srmMarketData, srmMarketAvailable, srmMarketDataUpdatedAt.
// SRM7-M is a SOYUZ-faction public server with canSetEndpoint:true; the
// market behaves like Dark Market — get.jobs by marketId works without
// the user having to actually connect to the server first. Mirror of
// dark-market.js — kept as a sibling rather than parametrised so adding
// a 4th market later is just another file copy.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Store, Registry, constants: C } = root.COR3;

    class SrmMarketModule extends Module {
        constructor() {
            super({
                id: 'srm-market',
                name: 'SRM7-M Market',
                category: C.CATEGORY.DATA,
                owns: {
                    storageKeys: [
                        C.STORAGE_LOCAL.SRM_MARKET,
                        C.STORAGE_LOCAL.SRM_MARKET_AT,
                        C.STORAGE_LOCAL.SRM_MARKET_AVAILABLE,
                    ],
                    busTypes: [C.MSG.WS.SRM_MARKET, C.MSG.WS.SRM_MARKET_UNREACHABLE],
                },
            });
        }

        async start() {
            this.track(Bus.window.on(C.MSG.WS.SRM_MARKET, (env) => {
                if (!env.market) return;
                Store.local.set({
                    [C.STORAGE_LOCAL.SRM_MARKET]: env.market,
                    [C.STORAGE_LOCAL.SRM_MARKET_AVAILABLE]: true,
                    [C.STORAGE_LOCAL.SRM_MARKET_AT]: Date.now(),
                });
                const jobCount = Array.isArray(env.market?.jobs) ? env.market.jobs.length : 0;
                this.debug('srm market frame', { jobs: jobCount });
            }));
            this.track(Bus.window.on(C.MSG.WS.SRM_MARKET_UNREACHABLE, (env) => {
                Store.local.set({
                    [C.STORAGE_LOCAL.SRM_MARKET_AVAILABLE]: false,
                    [C.STORAGE_LOCAL.SRM_MARKET_AT]: Date.now(),
                });
                this.warn('srm market unreachable', { error: env.error, serverId: env.serverId });
            }));
        }
    }

    Registry.register(new SrmMarketModule());
})();
