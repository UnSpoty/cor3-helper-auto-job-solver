// src/modules/automation/timers.js
// Alarm engine. Reads alarm config from chrome.storage.sync.alarms, ticks
// every second, and fires an audio alert per alarm trigger:
//
//   • trigger 'threshold' (default; absent === threshold) — the classic
//     countdown pre-warning: fires once when the remaining seconds for the
//     alarm's timerSource (daily, home_jobs, dark_jobs, srm_jobs, usol_jobs,
//     exp_<id>) drop into the (0, thresholdSeconds] band; re-arms when a fresh
//     deadline lifts the countdown back above the threshold.
//   • trigger 'update' (markets + daily only) — "notify me when the data
//     actually updates". Fires on EITHER of two signals, once per deadline
//     value (so the two can't double-beep for the same reset):
//       (a) zero-cross — the tracked countdown reaches 0 (the reset moment
//           passed), even if no fresh envelope ever lands (auto-refresh off).
//           Edge-triggered: the deadline must have been OBSERVED in the
//           future first, so a deadline already past at page load (stale
//           hours-old data) does not beep on boot;
//       (b) envelope change — the stored market/daily envelope's deadline
//           field CHANGES value (a refresh delivered the post-reset data).
//     Note (b) compares VALUES, not writes: the Auto Jobs orchestrator
//     rewrites market envelopes every cycle with the SAME nextJobsResetAt,
//     and that must not beep.
//
// A continuous alarm keeps beeping until dismissed (popup Stop) OR until the
// alarm that started it re-arms (fresh deadline) — previously the loop
// literally never stopped on its own, which read as "alarms are broken".
//
// Owned storage: chrome.storage.sync.alarms (array of alarm objects
// { id, enabled, timerSource, trigger?, thresholdSeconds, volume, continuous }).
// Bus: none (audio is local; UI controls alarms via storage).

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Store, Registry, constants: C } = root.COR3;

    let alarms = [];
    let triggered = {};        // alarmId → bool (threshold band latch)
    let prevRemaining = {};    // alarmId → last remaining (update zero-cross edge)
    let firedForKey = {};      // alarmId → deadline value already fired for (update dedupe)
    let continuousOwner = null;// alarm id whose continuous beep is running
    let audioCtx = null;
    let continuousId = null;
    let tickIntervalId = null;

    // Sources the 'update' trigger watches: storage key + the deadline field
    // whose VALUE CHANGE means "the data updated". Single list shared by the
    // storage listener here and the popup form (which offers 'update' only
    // for these sources).
    const UPDATE_SOURCES = [
        { source: 'home_jobs', key: C.STORAGE_LOCAL.MARKET,      field: 'nextJobsResetAt' },
        { source: 'dark_jobs', key: C.STORAGE_LOCAL.DARK_MARKET, field: 'nextJobsResetAt' },
        { source: 'srm_jobs',  key: C.STORAGE_LOCAL.SRM_MARKET,  field: 'nextJobsResetAt' },
        { source: 'usol_jobs', key: C.STORAGE_LOCAL.USOL_MARKET, field: 'nextJobsResetAt' },
        { source: 'daily',     key: C.STORAGE_LOCAL.DAILY_OPS,   field: 'nextTaskTime' },
    ];

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
        continuousOwner = null;
    }

    // Deadline for a timerSource: { remaining (sec, clamped ≥0), deadline
    // (the raw field value — the dedupe key for 'update') } or null when the
    // source has no data.
    async function readSource(timerSource) {
        const mk = (raw) => {
            const diff = new Date(raw).getTime() - Date.now();
            return { remaining: diff > 0 ? Math.floor(diff / 1000) : 0, deadline: raw };
        };
        const w = UPDATE_SOURCES.find((x) => x.source === timerSource);
        if (w) {
            const d = await Store.local.getOne(w.key);
            if (d && d[w.field]) return mk(d[w.field]);
            return null;
        }
        if (timerSource && timerSource.startsWith('exp_')) {
            const expId = timerSource.substring(4);
            const exps = await Store.local.getOne(C.STORAGE_LOCAL.EXPEDITIONS, []);
            const exp = (exps || []).find((e) => e.id === expId);
            if (exp && exp.endTime) return mk(exp.endTime);
            return null;
        }
        return null;
    }

    function fire(mod, a, why) {
        mod.info(`alarm fire: ${a.timerSource} (${why})`);
        if (a.continuous) { startContinuous(a.volume); continuousOwner = a.id; }
        else playBeep(a.volume);
    }

    async function tick(mod) {
        for (const a of alarms) {
            if (!a.enabled) continue;
            const src = await readSource(a.timerSource);
            if (src === null) continue;
            const trig = a.trigger || 'threshold';

            if (trig === 'threshold') {
                if (a.thresholdSeconds <= 0) continue;
                if (src.remaining <= a.thresholdSeconds && src.remaining > 0 && !triggered[a.id]) {
                    triggered[a.id] = true;
                    fire(mod, a, `≤ ${a.thresholdSeconds}s`);
                } else if (src.remaining > a.thresholdSeconds) {
                    triggered[a.id] = false;
                    // A fresh deadline re-armed this alarm — silence the
                    // continuous beep IT started. This was the endless-beep
                    // bug: nothing ever stopped the loop after the market
                    // reset. There is ONE beep channel: a later continuous
                    // alarm steals it (fire() reassigns the owner), so on
                    // re-arm hand the channel to any other continuous alarm
                    // whose latch is still armed instead of going silent
                    // while its condition still holds.
                    if (continuousOwner === a.id) {
                        stopContinuous();
                        const other = alarms.find((b) => b.id !== a.id && b.enabled && b.continuous && triggered[b.id]);
                        if (other) { startContinuous(other.volume); continuousOwner = other.id; }
                    }
                }
                continue;
            }

            if (trig === 'update') {
                // (a) zero-cross: the reset moment just passed per the stored
                // deadline. Fires once per deadline value — the envelope-change
                // listener below shares firedForKey so a following fresh
                // envelope doesn't beep again for the same reset.
                const prev = prevRemaining[a.id];
                if (src.remaining === 0 && typeof prev === 'number' && prev > 0
                    && firedForKey[a.id] !== src.deadline) {
                    firedForKey[a.id] = src.deadline;
                    fire(mod, a, 'update: reset reached');
                }
                prevRemaining[a.id] = src.remaining;
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
                const ch = changes[C.STORAGE_SYNC.ALARMS];
                if (!ch) return;
                const prevList = ch.oldValue || alarms || [];
                alarms = ch.newValue || [];
                // PRUNE per-alarm state instead of wiping it wholesale: a
                // blanket reset made ANY unrelated alarm edit forget
                // firedForKey, so an 'update' alarm that already beeped at
                // zero-cross beeped AGAIN when the post-reset envelope
                // arrived. State survives for an alarm whose identity
                // (timerSource + trigger) is unchanged; edited/removed
                // alarms lose their state and re-arm.
                const prevById = new Map(prevList.map((x) => [x.id, x]));
                const keep = new Set();
                for (const a of alarms) {
                    const p = prevById.get(a.id);
                    if (p && p.timerSource === a.timerSource
                        && (p.trigger || 'threshold') === (a.trigger || 'threshold')) keep.add(a.id);
                }
                for (const bag of [triggered, prevRemaining, firedForKey]) {
                    for (const k of Object.keys(bag)) if (!keep.has(k)) delete bag[k];
                }
                // Silence the beep, then hand it straight back if its owner
                // survived the edit unchanged and still wants it (a deleted /
                // disabled / re-targeted owner stays silent — its pruned
                // state lets tick() re-fire a still-due alarm within 1s).
                const owner = continuousOwner;
                stopContinuous();
                if (owner && keep.has(owner)) {
                    const oa = alarms.find((x) => x.id === owner);
                    if (oa && oa.enabled && oa.continuous) { startContinuous(oa.volume); continuousOwner = owner; }
                }
                this.debug(`alarms updated: ${alarms.length}`);
            }));

            // (b) envelope change — a market/daily envelope landed with a NEW
            // deadline value: the data updated (reset happened + refresh
            // delivered it). Value comparison, not write detection — the Auto
            // Jobs orchestrator rewrites envelopes each cycle with the same
            // deadline and must not beep. The first-ever write (no oldValue)
            // is boot hydration, not an update.
            this.track(Store.local.onChanged((changes) => {
                for (const w of UPDATE_SOURCES) {
                    const ch = changes[w.key];
                    if (!ch) continue;
                    const oldV = ch.oldValue && ch.oldValue[w.field];
                    const newV = ch.newValue && ch.newValue[w.field];
                    if (!oldV || !newV || oldV === newV) continue;
                    for (const a of alarms) {
                        if (!a.enabled || a.timerSource !== w.source) continue;
                        if ((a.trigger || 'threshold') !== 'update') continue;
                        // The zero-cross may already have fired for the reset
                        // this envelope closes out — same key, one beep.
                        if (firedForKey[a.id] === oldV) continue;
                        firedForKey[a.id] = oldV;
                        fire(this, a, `update: ${w.field} ${oldV} → ${newV}`);
                    }
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
