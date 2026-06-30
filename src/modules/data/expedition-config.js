// src/modules/data/expedition-config.js
// Owns: expeditionConfigData (HOME locations/zones/goals) + …UpdatedAt, AND
// expeditionConfigsData — the per-market config map keyed by marketId.
//
// get.config is per-market now (the home "Skylift" set differs from USOL's
// "Koute" set; some markets reply with 0 locations = not launchable). The MAIN
// interceptor tags each reply with its marketId (serialize-one correlation).
// EXPEDITION_CONFIGS holds every market's config; EXPEDITION_CONFIG keeps
// mirroring HOME for the legacy single-config readers (sendMercNow, UI dropdowns).

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Store, Registry, constants: C } = root.COR3;

    const HOME_MARKET_ID = C.HOME_MARKET_ID;

    class ExpeditionConfigModule extends Module {
        constructor() {
            super({
                id: 'expedition-config',
                name: 'Expedition Config',
                category: C.CATEGORY.DATA,
                owns: {
                    storageKeys: [
                        C.STORAGE_LOCAL.EXPEDITION_CONFIG, C.STORAGE_LOCAL.EXPEDITION_CONFIG_AT,
                        C.STORAGE_LOCAL.EXPEDITION_CONFIGS, C.STORAGE_LOCAL.EXPEDITION_CONFIGS_AT,
                    ],
                    busTypes: [C.MSG.WS.EXPEDITION_CONFIG],
                },
            });
            // Serialise read-modify-write of the per-market map — a multi-market
            // config refresh fires several frames back-to-back (mirrors mercenaries).
            this._writeChain = Promise.resolve();
        }

        async start() {
            this.track(Bus.window.on(C.MSG.WS.EXPEDITION_CONFIG, (env) => {
                if (!env.data) return;
                // marketId is stamped by the interceptor (defaults to HOME for an
                // unsolicited/game-initiated reply we couldn't correlate).
                const mid = env.marketId || HOME_MARKET_ID;
                this._writeChain = this._writeChain.then(async () => {
                    const map = (await Store.local.getOne(C.STORAGE_LOCAL.EXPEDITION_CONFIGS, {})) || {};
                    map[mid] = env.data;
                    const set = {
                        [C.STORAGE_LOCAL.EXPEDITION_CONFIGS]: map,
                        [C.STORAGE_LOCAL.EXPEDITION_CONFIGS_AT]: Date.now(),
                    };
                    // EXPEDITION_CONFIG mirrors ONLY HOME (legacy single-config readers).
                    if (mid === HOME_MARKET_ID) {
                        set[C.STORAGE_LOCAL.EXPEDITION_CONFIG] = env.data;
                        set[C.STORAGE_LOCAL.EXPEDITION_CONFIG_AT] = Date.now();
                    }
                    await Store.local.set(set);
                }).catch((e) => this.warn('expedition config write failed', { error: String(e) }));
                const locs = (env.data && env.data.locations) || [];
                this.debug('expedition config', { marketId: mid, locations: locs.length });
            }));
        }
    }

    Registry.register(new ExpeditionConfigModule());
})();
