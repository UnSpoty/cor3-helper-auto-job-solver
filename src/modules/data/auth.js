// src/modules/data/auth.js
// Owns: bearerToken, webVersion, systemVersion, dailyRewardsData.
// Listens for the four AUTH.* messages from the HTTP interceptor.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Store, Registry, constants: C } = root.COR3;

    class AuthModule extends Module {
        constructor() {
            super({
                id: 'auth',
                name: 'Auth & Versions',
                category: C.CATEGORY.DATA,
                owns: {
                    storageKeys: [
                        C.STORAGE_LOCAL.BEARER_TOKEN,
                        C.STORAGE_LOCAL.WEB_VERSION,
                        C.STORAGE_LOCAL.SYSTEM_VERSION,
                        C.STORAGE_LOCAL.DAILY_REWARDS,
                    ],
                    busTypes: [
                        C.MSG.AUTH.BEARER_TOKEN,
                        C.MSG.AUTH.WEB_VERSION,
                        C.MSG.AUTH.SYSTEM_VERSION,
                        C.MSG.AUTH.DAILY_REWARDS,
                        C.MSG.AUTH.TOKEN_EXPIRED,
                    ],
                },
            });
        }

        async start() {
            this.track(Bus.window.on(C.MSG.AUTH.BEARER_TOKEN, (env) => {
                if (!env.token) return;
                Store.local.setOne(C.STORAGE_LOCAL.BEARER_TOKEN, env.token);
                this.debug('bearer captured');
            }));
            this.track(Bus.window.on(C.MSG.AUTH.WEB_VERSION, (env) => {
                if (!env.version) return;
                Store.local.setOne(C.STORAGE_LOCAL.WEB_VERSION, env.version);
                this.debug('web version', { version: env.version });
            }));
            this.track(Bus.window.on(C.MSG.AUTH.SYSTEM_VERSION, (env) => {
                if (env.version === undefined || env.version === null) return;
                Store.local.setOne(C.STORAGE_LOCAL.SYSTEM_VERSION, env.version);
                this.debug('system version', { version: env.version });
            }));
            this.track(Bus.window.on(C.MSG.AUTH.DAILY_REWARDS, (env) => {
                if (!Array.isArray(env.rewards)) return;
                Store.local.setOne(C.STORAGE_LOCAL.DAILY_REWARDS, env.rewards);
                this.debug('daily rewards', { count: env.rewards.length });
            }));
            this.track(Bus.window.on(C.MSG.AUTH.TOKEN_EXPIRED, () => {
                this.warn('token expired — sockets being recycled');
            }));
        }
    }

    Registry.register(new AuthModule());
})();
