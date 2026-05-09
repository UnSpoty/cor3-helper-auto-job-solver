// src/modules/data/dark-market.js
// Owns: darkMarketData, darkMarketAvailable, darkMarketDataUpdatedAt.
// `darkMarketAvailable` flips false on COR3_WS_DARK_MARKET_UNREACHABLE
// (no-path-to-server) and true again on the next successful frame.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Store, Registry, constants: C } = root.COR3;

    class DarkMarketModule extends Module {
        constructor() {
            super({
                id: 'dark-market',
                name: 'Dark Market',
                category: C.CATEGORY.DATA,
                owns: {
                    storageKeys: [
                        C.STORAGE_LOCAL.DARK_MARKET,
                        C.STORAGE_LOCAL.DARK_MARKET_AT,
                        C.STORAGE_LOCAL.DARK_MARKET_AVAILABLE,
                    ],
                    busTypes: [C.MSG.WS.DARK_MARKET, C.MSG.WS.DARK_MARKET_UNREACHABLE],
                },
            });
        }

        async start() {
            this.track(Bus.window.on(C.MSG.WS.DARK_MARKET, (env) => {
                if (!env.market) return;
                Store.local.set({
                    [C.STORAGE_LOCAL.DARK_MARKET]: env.market,
                    [C.STORAGE_LOCAL.DARK_MARKET_AVAILABLE]: true,
                    [C.STORAGE_LOCAL.DARK_MARKET_AT]: Date.now(),
                });
                const jobCount = Array.isArray(env.market?.jobs) ? env.market.jobs.length : 0;
                this.debug('dark market frame', { jobs: jobCount });
            }));
            this.track(Bus.window.on(C.MSG.WS.DARK_MARKET_UNREACHABLE, (env) => {
                Store.local.set({
                    [C.STORAGE_LOCAL.DARK_MARKET_AVAILABLE]: false,
                    [C.STORAGE_LOCAL.DARK_MARKET_AT]: Date.now(),
                });
                this.warn('dark market unreachable', { error: env.error, serverId: env.serverId });
            }));
        }
    }

    Registry.register(new DarkMarketModule());
})();
