// src/modules/automation/daily-ops.js
// Daily ops fetcher. Triggered by:
//   • COR3_FETCH_DAILY_OPS postMessage (fired by interceptor on WS open)
//   • chrome.runtime fetchDailyOps action (popup refresh button)
// Uses bearerToken from chrome.storage.local. Stores response in
// chrome.storage.local.dailyOpsData.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Store, Registry, constants: C } = root.COR3;

    async function fetchOps(mod) {
        const token = await Store.local.getOne(C.STORAGE_LOCAL.BEARER_TOKEN);
        if (!token) { mod.debug('no bearer token, skip'); return null; }
        try {
            const r = await fetch('https://svc-corie.cor3.gg/api/user-daily-claim', {
                headers: { Authorization: token },
            });
            if (r.ok) {
                const data = await r.json();
                await Store.local.set({
                    [C.STORAGE_LOCAL.DAILY_OPS]: data,
                    [C.STORAGE_LOCAL.DAILY_OPS_AT]: Date.now(),
                    [C.STORAGE_LOCAL.DAILY_OPS_ERROR]: null,
                });
                mod.debug('daily ops fetched');
                // Refresh rewards too
                fetchRewards(token).catch(() => {});
                return data;
            }
            if (r.status === 400 || r.status === 401 || r.status === 403) {
                mod.warn(`daily ops fetch failed (${r.status}) — token expired`);
                await Store.local.set({
                    [C.STORAGE_LOCAL.DAILY_OPS_ERROR]: 'token_expired',
                    [C.STORAGE_LOCAL.DAILY_OPS_ERROR_AT]: Date.now(),
                });
                return null;
            }
            mod.warn(`daily ops fetch failed (${r.status})`);
            return null;
        } catch (e) {
            mod.error('daily ops fetch threw', { error: String(e) });
            return null;
        }
    }

    async function fetchRewards(token) {
        try {
            const r = await fetch('https://svc-corie.cor3.gg/api/user-daily-claim/rewards', {
                headers: { Authorization: token },
            });
            if (r.ok) {
                const data = await r.json();
                if (Array.isArray(data)) await Store.local.setOne(C.STORAGE_LOCAL.DAILY_REWARDS, data);
            }
        } catch (_) { /* swallow */ }
    }

    class DailyOpsModule extends Module {
        constructor() {
            super({
                id: 'daily-ops',
                name: 'Daily Ops fetch',
                category: C.CATEGORY.AUTOMATION,
                dependsOn: ['auth'],
                owns: { storageKeys: [C.STORAGE_LOCAL.DAILY_OPS, C.STORAGE_LOCAL.DAILY_OPS_AT, C.STORAGE_LOCAL.DAILY_OPS_ERROR] },
            });
        }
        async start() {
            this.track(Bus.window.on('COR3_FETCH_DAILY_OPS', () => fetchOps(this)));

            this.track(Bus.runtime.on('fetchDailyOps', async () => {
                const data = await fetchOps(this);
                return data ? { data } : { error: 'fetch failed' };
            }));
            this.info('daily-ops ready');
        }
    }

    Registry.register(new DailyOpsModule());
})();
