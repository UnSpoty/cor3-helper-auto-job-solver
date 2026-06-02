// src/modules/automation/timers.js
// Alarm engine. Reads alarm config from chrome.storage.sync.alarms, ticks
// every second, computes remaining seconds for each timerSource (daily,
// home_jobs, dark_jobs, exp_<id>), and plays an audio alert when the
// configured threshold is crossed.
//
// Owned storage: chrome.storage.sync.alarms (array of alarm objects).
// Bus: none (audio is local; UI controls alarms via storage).

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Store, Registry, constants: C } = root.COR3;

    let alarms = [];
    let triggered = {};
    let audioCtx = null;
    let continuousId = null;
    let tickIntervalId = null;

    function ensureAudio() {
        if (audioCtx) return audioCtx;
        try { audioCtx = new (root.AudioContext || root.webkitAudioContext)(); }
        catch (_) { audioCtx = null; }
        return audioCtx;
    }

    function playBeep(volumePercent) {
        const ctx = ensureAudio();
        if (!ctx) return;
        if (ctx.state === 'suspended') ctx.resume();
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(volumePercent / 100, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
        osc.connect(gain); gain.connect(ctx.destination);
        osc.start(); osc.stop(now + 0.5);
    }

    function startContinuous(volume) {
        if (continuousId) clearInterval(continuousId);
        playBeep(volume);
        continuousId = setInterval(() => playBeep(volume), 2000);
    }

    function stopContinuous() {
        if (continuousId) { clearInterval(continuousId); continuousId = null; }
    }

    async function getRemaining(timerSource) {
        if (timerSource === 'daily') {
            const d = await Store.local.getOne(C.STORAGE_LOCAL.DAILY_OPS);
            if (d && d.nextTaskTime) {
                const diff = new Date(d.nextTaskTime).getTime() - Date.now();
                return diff > 0 ? Math.floor(diff / 1000) : 0;
            }
            return null;
        }
        if (timerSource === 'home_jobs') {
            const d = await Store.local.getOne(C.STORAGE_LOCAL.MARKET);
            if (d && d.nextJobsResetAt) {
                const diff = new Date(d.nextJobsResetAt).getTime() - Date.now();
                return diff > 0 ? Math.floor(diff / 1000) : 0;
            }
            return null;
        }
        if (timerSource === 'dark_jobs') {
            const d = await Store.local.getOne(C.STORAGE_LOCAL.DARK_MARKET);
            if (d && d.nextJobsResetAt) {
                const diff = new Date(d.nextJobsResetAt).getTime() - Date.now();
                return diff > 0 ? Math.floor(diff / 1000) : 0;
            }
            return null;
        }
        if (timerSource === 'srm_jobs') {
            const d = await Store.local.getOne(C.STORAGE_LOCAL.SRM_MARKET);
            if (d && d.nextJobsResetAt) {
                const diff = new Date(d.nextJobsResetAt).getTime() - Date.now();
                return diff > 0 ? Math.floor(diff / 1000) : 0;
            }
            return null;
        }
        if (timerSource === 'usol_jobs') {
            const d = await Store.local.getOne(C.STORAGE_LOCAL.USOL_MARKET);
            if (d && d.nextJobsResetAt) {
                const diff = new Date(d.nextJobsResetAt).getTime() - Date.now();
                return diff > 0 ? Math.floor(diff / 1000) : 0;
            }
            return null;
        }
        if (timerSource && timerSource.startsWith('exp_')) {
            const expId = timerSource.substring(4);
            const exps = await Store.local.getOne(C.STORAGE_LOCAL.EXPEDITIONS, []);
            const exp = (exps || []).find((e) => e.id === expId);
            if (exp && exp.endTime) {
                const diff = new Date(exp.endTime).getTime() - Date.now();
                return diff > 0 ? Math.floor(diff / 1000) : 0;
            }
            return null;
        }
        return null;
    }

    async function tick(mod) {
        for (const a of alarms) {
            if (!a.enabled || a.thresholdSeconds <= 0) continue;
            const remaining = await getRemaining(a.timerSource);
            if (remaining === null) continue;
            if (remaining <= a.thresholdSeconds && remaining > 0 && !triggered[a.id]) {
                triggered[a.id] = true;
                mod.info(`alarm fire: ${a.timerSource} (≤ ${a.thresholdSeconds}s)`);
                if (a.continuous) startContinuous(a.volume);
                else playBeep(a.volume);
            } else if (remaining > a.thresholdSeconds) {
                triggered[a.id] = false;
            }
        }
    }

    class TimersModule extends Module {
        constructor() {
            super({
                id: 'timers',
                name: 'Alarms',
                category: C.CATEGORY.AUTOMATION,
                owns: { storageKeys: [C.STORAGE_SYNC.ALARMS] },
            });
        }
        async init() {
            alarms = (await Store.sync.getOne(C.STORAGE_SYNC.ALARMS, [])) || [];
        }
        async start() {
            this.track(Store.sync.onChanged((changes) => {
                if (changes[C.STORAGE_SYNC.ALARMS]) {
                    alarms = changes[C.STORAGE_SYNC.ALARMS].newValue || [];
                    triggered = {};
                    // Silence any running continuous beep — the alarm that
                    // started it may have just been deleted/disabled/edited.
                    // tick() re-starts it within 1s if one is still due.
                    stopContinuous();
                    this.debug(`alarms updated: ${alarms.length}`);
                }
            }));
            tickIntervalId = setInterval(() => tick(this), 1000);
            this.track(() => { if (tickIntervalId) { clearInterval(tickIntervalId); tickIntervalId = null; } });
            // Stop the continuous beep on module stop/reload — its interval is
            // otherwise unreachable (a fresh start can't see the old id) and
            // would keep beeping for the page lifetime.
            this.track(() => stopContinuous());

            // chrome.runtime listeners for popup test/stop
            this.track(root.COR3.Bus.runtime.on('testAlarm', (payload) => {
                const vol = (payload && payload.volume !== undefined) ? payload.volume : 50;
                if (payload && payload.continuous) startContinuous(vol);
                else playBeep(vol);
                return { success: true };
            }));
            this.track(root.COR3.Bus.runtime.on('stopAlarm', () => {
                stopContinuous();
                return { success: true };
            }));
            this.info('alarm engine ready');
        }
    }

    Registry.register(new TimersModule());
})();
