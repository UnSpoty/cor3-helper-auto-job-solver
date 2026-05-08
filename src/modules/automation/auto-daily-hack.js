// src/modules/automation/auto-daily-hack.js
// Reads chrome.storage.sync.autoDailyHackEnabled. Forwards toggle state to
// the daily-hack solver in MAIN world. Also relays COR3_DAILY_HACK_LOG to
// chrome.storage.local.dailyHackLog so the legacy popup section keeps
// showing solver output (Phase 5 popup will read cor3_logs instead).

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Store, Registry, constants: C } = root.COR3;

    function start() { Bus.window.post('COR3_START_DAILY_HACK', null); }
    function stop() { Bus.window.post(C.MSG.SOLVER.STOP_DAILY_HACK, null); }

    class AutoDailyHackModule extends Module {
        constructor() {
            super({
                id: 'auto-daily-hack',
                name: 'Auto daily hack',
                category: C.CATEGORY.AUTOMATION,
                owns: {
                    storageKeys: [C.STORAGE_SYNC.AUTO_DAILY_HACK_ENABLED, C.STORAGE_LOCAL.DAILY_HACK_LOG],
                    busTypes: [C.MSG.SOLVER.DAILY_HACK_LOG],
                },
            });
        }
        async start() {
            const enabled = await Store.sync.getOne(C.STORAGE_SYNC.AUTO_DAILY_HACK_ENABLED, false);
            if (enabled) { this.info('starting daily-hack solver'); start(); }

            this.track(Store.sync.onChanged((changes) => {
                const ch = changes[C.STORAGE_SYNC.AUTO_DAILY_HACK_ENABLED];
                if (!ch) return;
                if (ch.newValue) { this.info('toggle ON'); start(); }
                else { this.info('toggle OFF'); stop(); }
            }));

            this.track(Bus.window.on(C.MSG.SOLVER.DAILY_HACK_LOG, (env) => {
                Store.local.set({
                    [C.STORAGE_LOCAL.DAILY_HACK_LOG]: env.message,
                    [C.STORAGE_LOCAL.DAILY_HACK_LOG_AT]: Date.now(),
                });
            }));

            this.track(Bus.runtime.on('toggleDailyHackSolver', (payload) => {
                if (payload && payload.enabled) start(); else stop();
                return { success: true };
            }));
            this.info('auto-daily-hack ready');
        }
    }

    Registry.register(new AutoDailyHackModule());
})();
