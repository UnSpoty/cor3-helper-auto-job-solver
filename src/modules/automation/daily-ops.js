// src/modules/automation/daily-ops.js
// Daily ops fetcher + solve trigger + Auto watcher. Triggered by:
//   • COR3_FETCH_DAILY_OPS postMessage (fired by interceptor on WS open)
//   • chrome.runtime fetchDailyOps action (legacy popup refresh)
//   • chrome.runtime solveDailyOps action (popup "Solve" button) — forwards
//     to MAIN-world solver-daily-ops via COR3_START_DAILY_OPS envelope
//   • AUTO_DAILY_OPS_ENABLED watcher (popup "Auto" toggle) — a polling loop
//     that auto-launches the solver whenever the reset timer reaches 00:00
//     (a new task is available) or the current day is still unsolved
//     (dailyOpsData.hasClaimedToday === false). After a solve the solver
//     closes every Daily Ops window it opened (puzzle + Daily Ops + Game
//     Center), so each run leaves a clean desktop.
// Uses bearerToken from chrome.storage.local. Stores response in
// chrome.storage.local.dailyOpsData. Relays solver log lines from MAIN
// world into chrome.storage.local.dailyHackLog (reused; UI shows it).

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Store, Registry, constants: C } = root.COR3;

    // ─── Auto watcher timing ──────────────────────────────────────────────
    const AUTO_POLL_MS = 60 * 1000;             // how often we re-check the timer / claim state
    const AUTO_INITIAL_MS = 8 * 1000;           // first check after load (let WS + auth settle)
    const AUTO_WATCHDOG_MS = 4 * 60 * 1000;     // clear in-flight if no terminal solver log arrives
    const AUTO_FAIL_COOLDOWN_MS = 15 * 60 * 1000; // back off before retrying a failed / aborted solve

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

    // ─── Auto watcher ─────────────────────────────────────────────────────
    function startAuto(mod) {
        if (mod._autoTimer) return;
        mod.info('auto daily-ops: ON');
        mod._autoTimer = setInterval(() => {
            autoTick(mod).catch((e) => mod.error('auto tick threw', { error: String(e) }));
        }, AUTO_POLL_MS);
        mod._autoInitial = setTimeout(() => {
            autoTick(mod).catch((e) => mod.error('auto tick threw', { error: String(e) }));
        }, AUTO_INITIAL_MS);
    }

    function stopAuto(mod) {
        if (mod._autoTimer) { clearInterval(mod._autoTimer); mod._autoTimer = null; }
        if (mod._autoInitial) { clearTimeout(mod._autoInitial); mod._autoInitial = null; }
        if (mod._autoWatchdog) { clearTimeout(mod._autoWatchdog); mod._autoWatchdog = null; }
        mod._autoInFlight = false;
        mod.info('auto daily-ops: OFF');
    }

    async function autoTick(mod) {
        if (mod._autoEnabled !== true) return;
        if (mod._autoInFlight) return;                            // a solve is already running
        if (Date.now() < (mod._autoCooldownUntil || 0)) return;  // backing off after a failure

        let daily = await Store.local.getOne(C.STORAGE_LOCAL.DAILY_OPS);
        const now = Date.now();
        const resetAt = (daily && daily.nextTaskTime) ? new Date(daily.nextTaskTime).getTime() : NaN;
        const timerHitZero = !Number.isFinite(resetAt) || now >= resetAt;
        const looksSolved = !!(daily && daily.hasClaimedToday === true);

        // Refresh from the server whenever our snapshot can't be trusted to
        // reflect "solved today": the reset timer reached 00:00 (a NEW day, so
        // the snapshot is from the previous one), the snapshot says unsolved
        // (confirm it before acting), or there is no snapshot at all.
        if (timerHitZero || !looksSolved) {
            const fresh = await fetchOps(mod);
            if (fresh) daily = fresh;
        }
        if (!daily) return;  // no token / fetch failed — retry on the next tick

        if (daily.hasClaimedToday === false) {
            mod.info('auto: Daily Ops unsolved — launching solver');
            launchAutoSolve(mod);
        }
    }

    function launchAutoSolve(mod) {
        mod._autoInFlight = true;
        if (mod._autoWatchdog) clearTimeout(mod._autoWatchdog);
        mod._autoWatchdog = setTimeout(() => {
            if (!mod._autoInFlight) return;
            mod.warn('auto: solve watchdog fired (no terminal result) — backing off');
            mod._autoInFlight = false;
            mod._autoCooldownUntil = Date.now() + AUTO_FAIL_COOLDOWN_MS;
        }, AUTO_WATCHDOG_MS);
        Bus.window.post(C.MSG.SOLVER.START_DAILY_OPS, null);
    }

    // Called from the solver-log relay when an auto-launched run ends.
    function autoSolveDone(mod, ok) {
        if (mod._autoWatchdog) { clearTimeout(mod._autoWatchdog); mod._autoWatchdog = null; }
        mod._autoInFlight = false;
        // On success the re-fetch flips hasClaimedToday → true, which gates
        // further triggers on its own. On a failed / aborted run, back off so
        // the watcher doesn't retry-spam a puzzle that keeps failing.
        if (!ok) mod._autoCooldownUntil = Date.now() + AUTO_FAIL_COOLDOWN_MS;
    }

    class DailyOpsModule extends Module {
        constructor() {
            super({
                id: 'daily-ops',
                name: 'Daily Ops fetch',
                category: C.CATEGORY.AUTOMATION,
                dependsOn: ['auth'],
                owns: {
                    storageKeys: [C.STORAGE_LOCAL.DAILY_OPS, C.STORAGE_LOCAL.DAILY_OPS_AT, C.STORAGE_LOCAL.DAILY_OPS_ERROR],
                },
            });
            this._autoEnabled = false;
            this._autoInFlight = false;
            this._autoCooldownUntil = 0;
            this._autoTimer = null;
            this._autoInitial = null;
            this._autoWatchdog = null;
        }
        async start() {
            this.track(Bus.window.on('COR3_FETCH_DAILY_OPS', () => fetchOps(this)));

            this.track(Bus.runtime.on('fetchDailyOps', async () => {
                const data = await fetchOps(this);
                return data ? { data } : { error: 'fetch failed' };
            }));

            // Popup "Solve" button → kick the MAIN-world solver. Both manual
            // and Auto runs end by closing every Daily Ops window the solver
            // opened (puzzle + Daily Ops + Game Center), see solver finishWidgets().
            this.track(Bus.runtime.on('solveDailyOps', () => {
                Bus.window.post(C.MSG.SOLVER.START_DAILY_OPS, null);
                return { success: true };
            }));

            // Relay solver log lines into the daily-hack log key so the
            // popup's existing log viewer keeps working.
            this.track(Bus.window.on(C.MSG.SOLVER.DAILY_OPS_LOG, (env) => {
                if (!env || !env.message) return;
                Store.local.set({
                    [C.STORAGE_LOCAL.DAILY_HACK_LOG]: env.message,
                    [C.STORAGE_LOCAL.DAILY_HACK_LOG_AT]: Date.now(),
                });
                const solved = /^solved:/i.test(env.message);
                // Also re-fetch ops state once the solver claims a reward, so
                // the popup card flips from "Start" to "Replay" without the
                // user pressing Refresh.
                if (solved) setTimeout(() => fetchOps(this), 1500);
                // Release the auto in-flight latch on a terminal result. A
                // crash is logged as "Error: …"; anything else terminal is
                // covered by the watchdog.
                if (solved) autoSolveDone(this, true);
                else if (/^error:/i.test(env.message)) autoSolveDone(this, false);
            }));

            // ─── Auto toggle (AUTO_DAILY_OPS_ENABLED) ─────────────────────
            this._autoEnabled = await Store.sync.getOne(C.STORAGE_SYNC.AUTO_DAILY_OPS_ENABLED, false);
            if (this._autoEnabled) startAuto(this);
            this.track(Store.sync.onSettingChange(C.STORAGE_SYNC.AUTO_DAILY_OPS_ENABLED, (newValue) => {
                this._autoEnabled = !!newValue;
                if (this._autoEnabled) startAuto(this);
                else stopAuto(this);
            }));

            this.info('daily-ops ready');
        }

        async stop() {
            stopAuto(this);
        }
    }

    Registry.register(new DailyOpsModule());
})();
