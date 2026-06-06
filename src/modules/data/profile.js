// src/modules/data/profile.js
// Owns: profileData (credit balance + account RENOWN) + profileDataUpdatedAt.
//
// MSG.WS.PROFILE frames are PARTIAL — a profile.receive.credits push carries
// only balance/creditsDelta, a receive.progress push carries only renown, and
// the market.get.options seed carries only balance. So we MERGE each frame into
// the existing snapshot rather than replacing it (mirrors merc-config.js: the
// read-modify-write is serialised through a write-chain to avoid interleave).
//
// `balance` is what the Expeditions min/max auto-send reads.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Store, Registry, constants: C } = root.COR3;

    class ProfileModule extends Module {
        constructor() {
            super({
                id: 'profile',
                name: 'Profile (credits/renown)',
                category: C.CATEGORY.DATA,
                owns: {
                    storageKeys: [C.STORAGE_LOCAL.PROFILE, C.STORAGE_LOCAL.PROFILE_AT],
                    busTypes: [C.MSG.WS.PROFILE],
                },
            });
        }

        async start() {
            let writeChain = Promise.resolve();
            this.track(Bus.window.on(C.MSG.WS.PROFILE, (env) => {
                if (!env) return;
                writeChain = writeChain.then(async () => {
                    const cur = (await Store.local.getOne(C.STORAGE_LOCAL.PROFILE, {})) || {};
                    if (typeof env.balance === 'number') cur.balance = env.balance;
                    if (typeof env.renownLevel === 'number') cur.renownLevel = env.renownLevel;
                    if (typeof env.renownProgress === 'number') cur.renownProgress = env.renownProgress;
                    if (typeof env.renownNext === 'number') cur.renownNext = env.renownNext;
                    cur.updatedAt = Date.now();
                    await Store.local.set({
                        [C.STORAGE_LOCAL.PROFILE]: cur,
                        [C.STORAGE_LOCAL.PROFILE_AT]: Date.now(),
                    });
                    this.debug('profile', { balance: cur.balance, src: env.source });
                }).catch((e) => this.warn('profile write failed', { error: String(e) }));
            }));
        }
    }

    Registry.register(new ProfileModule());
})();
