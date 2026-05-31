// src/modules/automation/auto-refresh.js
// Periodic market polling. Watches the nextJobsResetAt of every supported
// market (Home, Dark, SRM7-M); when a timer crosses zero AND auto-refresh
// is enabled for that market in chrome.storage.sync.autoRefresh, sends the
// matching COR3_REFRESH_*_MARKET command to MAIN world.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Store, Registry, constants: C } = root.COR3;

    // Source-of-truth for which auto-refresh keys exist and how they map to
    // storage keys + refresh envelope types. Adding a 4th market = one entry.
    const MARKETS = [
        { key: 'home_jobs', storage: C.STORAGE_LOCAL.MARKET,      refresh: C.MSG.GAME.REFRESH_MARKET },
        { key: 'dark_jobs', storage: C.STORAGE_LOCAL.DARK_MARKET, refresh: C.MSG.GAME.REFRESH_DARK_MARKET },
        { key: 'srm_jobs',  storage: C.STORAGE_LOCAL.SRM_MARKET,  refresh: C.MSG.GAME.REFRESH_SRM_MARKET },
    ];

    let settings = { home_jobs: false, dark_jobs: false, srm_jobs: false };
    let retryPending = { home_jobs: false, dark_jobs: false, srm_jobs: false };
    let intervalId = null;
    let ticking = false;   // re-entrancy guard (tick() awaits a storage read)

    async function getSeconds(market) {
        const d = await Store.local.getOne(market.storage);
        if (d && d.nextJobsResetAt) {
            const diff = new Date(d.nextJobsResetAt).getTime() - Date.now();
            return diff > 0 ? Math.floor(diff / 1000) : 0;
        }
        return null;
    }

    async function tick(mod) {
        // Re-entrancy guard: tick() awaits a storage read before setting
        // retryPending, so two 1s ticks could both pass the synchronous guard
        // and double-post a refresh for the same market.
        if (ticking) return;
        ticking = true;
        try {
            for (const m of MARKETS) {
                if (!settings[m.key]) continue;
                if (retryPending[m.key]) continue;
                const sec = await getSeconds(m);
                if (sec !== null && sec <= 0) {
                    retryPending[m.key] = true;
                    mod.info(`auto-refresh: ${m.key} timer expired`);
                    Bus.window.post(m.refresh, null);
                    setTimeout(() => { retryPending[m.key] = false; }, 10000);
                }
            }
        } finally {
            ticking = false;
        }
    }

    class AutoRefreshModule extends Module {
        constructor() {
            super({
                id: 'auto-refresh',
                name: 'Auto-refresh markets',
                category: C.CATEGORY.AUTOMATION,
                dependsOn: ['market', 'dark-market', 'srm-market'],
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
