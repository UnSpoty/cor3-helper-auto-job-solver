// src/modules/automation/auto-refresh.js
// Periodic market polling. Watches `marketData.nextJobsResetAt` and
// `darkMarketData.nextJobsResetAt`; when a timer crosses zero AND auto-refresh
// is enabled for that market in chrome.storage.sync.autoRefresh, sends a
// COR3_REFRESH_MARKET / COR3_REFRESH_DARK_MARKET command to MAIN world.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Store, Registry, constants: C } = root.COR3;

    let settings = { home_jobs: false, dark_jobs: false };
    let retryPending = { home_jobs: false, dark_jobs: false };
    let intervalId = null;

    async function getSeconds(which) {
        const key = which === 'home_jobs' ? C.STORAGE_LOCAL.MARKET : C.STORAGE_LOCAL.DARK_MARKET;
        const d = await Store.local.getOne(key);
        if (d && d.nextJobsResetAt) {
            const diff = new Date(d.nextJobsResetAt).getTime() - Date.now();
            return diff > 0 ? Math.floor(diff / 1000) : 0;
        }
        return null;
    }

    async function tick(mod) {
        for (const k of ['home_jobs', 'dark_jobs']) {
            if (!settings[k]) continue;
            if (retryPending[k]) continue;
            const sec = await getSeconds(k);
            if (sec !== null && sec <= 0) {
                retryPending[k] = true;
                mod.info(`auto-refresh: ${k} timer expired`);
                Bus.window.post(k === 'home_jobs' ? C.MSG.GAME.REFRESH_MARKET : C.MSG.GAME.REFRESH_DARK_MARKET, null);
                setTimeout(() => { retryPending[k] = false; }, 10000);
            }
        }
    }

    class AutoRefreshModule extends Module {
        constructor() {
            super({
                id: 'auto-refresh',
                name: 'Auto-refresh markets',
                category: C.CATEGORY.AUTOMATION,
                dependsOn: ['market', 'dark-market'],
                owns: { storageKeys: [C.STORAGE_SYNC.AUTO_REFRESH] },
            });
        }
        async init() {
            settings = (await Store.sync.getOne(C.STORAGE_SYNC.AUTO_REFRESH, settings)) || settings;
        }
        async start() {
            this.track(Store.sync.onChanged((changes) => {
                if (changes[C.STORAGE_SYNC.AUTO_REFRESH]) {
                    settings = changes[C.STORAGE_SYNC.AUTO_REFRESH].newValue || settings;
                    this.debug('auto-refresh settings changed', settings);
                }
            }));
            intervalId = setInterval(() => tick(this), 1000);
            this.track(() => { if (intervalId) { clearInterval(intervalId); intervalId = null; } });
            this.info('auto-refresh ready');
        }
    }

    Registry.register(new AutoRefreshModule());
})();
