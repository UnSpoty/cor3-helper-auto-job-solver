// src/modules/data/mercenaries.js
// Owns: mercenariesData + mercenariesUpdatedAt.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Store, Registry, constants: C } = root.COR3;

    const HOME_MARKET_ID = C.HOME_MARKET_ID;

    class MercenariesModule extends Module {
        constructor() {
            super({
                id: 'mercenaries',
                name: 'Mercenaries',
                category: C.CATEGORY.DATA,
                owns: {
                    storageKeys: [
                        C.STORAGE_LOCAL.MERCENARIES, C.STORAGE_LOCAL.MERCENARIES_AT,
                        C.STORAGE_LOCAL.MERC_MARKETS, C.STORAGE_LOCAL.MERC_MARKETS_AT,
                    ],
                    busTypes: [C.MSG.WS.MERCENARIES],
                },
            });
            // Serialise read-modify-write of the per-market map — a multi-market
            // refresh fires 4 frames back-to-back and they must not clobber.
            this._writeChain = Promise.resolve();
        }

        async start() {
            this.track(Bus.window.on(C.MSG.WS.MERCENARIES, (env) => {
                if (!env.data) return;
                const mid = env.marketId || null;
                // Require an explicit marketId. The interceptor only tags
                // SOLICITED replies (matched to an in-flight request); an
                // untagged frame is unexpected and must NOT be stored — writing
                // it would risk overwriting the wrong market's roster (or the
                // HOME mirror that auto-send reads).
                if (!mid) { this.warn('mercenaries frame without marketId — dropped'); return; }
                this._writeChain = this._writeChain.then(async () => {
                    const map = (await Store.local.getOne(C.STORAGE_LOCAL.MERC_MARKETS, {})) || {};
                    map[mid] = env.data;
                    const set = {
                        [C.STORAGE_LOCAL.MERC_MARKETS]: map,
                        [C.STORAGE_LOCAL.MERC_MARKETS_AT]: Date.now(),
                    };
                    // MERCENARIES mirrors ONLY the HOME market (auto-send + legacy roster).
                    if (mid === HOME_MARKET_ID) {
                        set[C.STORAGE_LOCAL.MERCENARIES] = env.data;
                        set[C.STORAGE_LOCAL.MERCENARIES_AT] = Date.now();
                    }
                    await Store.local.set(set);
                }).catch((e) => this.warn('mercenaries write failed', { error: String(e) }));
                const list = Array.isArray(env.data) ? env.data : env.data.mercenaries;
                this.debug('mercenaries frame', { marketId: mid, count: Array.isArray(list) ? list.length : 0 });
            }));
        }
    }

    Registry.register(new MercenariesModule());
})();
