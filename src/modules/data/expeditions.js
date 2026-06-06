// Owns: expeditionsData + expeditionsDataUpdatedAt.
//
// Also computes a corrected expedition end time to match the in-game countdown.
// The server sends startTime/endTime null even while RUNNING (only runDuration);
// verified live, the game derives them purely client-side:
//   • the `runDuration` countdown starts at DEPARTURE (PREPARING → RUNNING), NOT
//     at launch — PREPARING takes ~30–70s, which is why a launch-time base ran
//     ~90s fast.
//   • a pending decision (status EVENT) PAUSES the raid, pushing the end later by
//     the time spent paused.
// So: end = runStart + runDuration + Σ(EVENT-pause). This module runs alongside
// the game and sees the same get.active frames, so recording runStart at the
// first observed RUNNING (and accruing EVENT-pause) lands on the same value the
// game shows. We stamp three derived fields onto each stored expedition:
//   _timerPreparing — true while still PREPARING (no countdown yet).
//   _timerEndMs     — wall-clock end (ms); RUNNING/RETURNING counts down to this.
//   _timerFrozenMs  — static remaining ms while paused at a decision (else null).
// (Resets on page reload; a raid first seen mid-flight is estimated from the
// UUIDv7 launch time + a typical PREPARING offset — the game can't recover a
// reloaded raid's exact start either.)

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Store, Registry, constants: C } = root.COR3;

    // expId -> { started, sawPreparing, baseEndMs, lastAt, lastStatus, frozenMs }
    const timers = new Map();
    const STARTED = new Set(['RUNNING', 'EVENT', 'RETURNING', 'IN_PROGRESS']);
    const PREPARING_FALLBACK_MS = 60000; // est. PREPARING for raids first seen mid-flight

    function launchMs(id) {
        const n = parseInt(String(id || '').replace(/-/g, '').slice(0, 12), 16);
        return (isFinite(n) && n > 1e12) ? n : null;
    }

    function track(exp, now) {
        if (!exp || !exp.id || !exp.runDuration || !exp.status) return exp;
        if (exp.status === 'COMPLETED') return exp;

        let st = timers.get(exp.id);
        if (!st) st = { started: false, sawPreparing: false, baseEndMs: null, lastAt: now, lastStatus: exp.status, frozenMs: null };

        if (typeof exp._gameEndMs === 'number') {
            // Authoritative: the game's own endTimeMs (Expeditions widget is open).
            // Snap the tracker to it so it stays correct after the widget closes.
            st.started = true;
            st.baseEndMs = exp._gameEndMs;
        } else {
            // Accrue pause time spent at a decision since the last observation.
            if (st.started && st.lastStatus === 'EVENT') st.baseEndMs += (now - st.lastAt);
            // Start the run clock the first time we see a departed (non-PREPARING) status.
            if (!st.started && STARTED.has(exp.status)) {
                st.started = true;
                if (st.sawPreparing) {
                    st.baseEndMs = now + exp.runDuration;           // watched departure → matches game
                } else {
                    const l = launchMs(exp.id);                      // first seen mid-flight → estimate
                    st.baseEndMs = (l != null ? l : now) + exp.runDuration + PREPARING_FALLBACK_MS;
                }
            }
        }
        if (exp.status === 'PREPARING') st.sawPreparing = true;

        // Freeze the displayed remaining while a decision is pending (capture on entry).
        if (exp.status === 'EVENT' && st.lastStatus !== 'EVENT' && st.baseEndMs != null) {
            st.frozenMs = Math.max(0, st.baseEndMs - now);
        } else if (exp.status !== 'EVENT') {
            st.frozenMs = null;
        }

        st.lastAt = now;
        st.lastStatus = exp.status;
        timers.set(exp.id, st);

        return Object.assign({}, exp, {
            _timerPreparing: exp.status === 'PREPARING',
            _timerEndMs: st.baseEndMs,
            _timerFrozenMs: exp.status === 'EVENT' ? st.frozenMs : null,
        });
    }

    class ExpeditionsModule extends Module {
        constructor() {
            super({
                id: 'expeditions',
                name: 'Expeditions',
                category: C.CATEGORY.DATA,
                owns: {
                    storageKeys: [C.STORAGE_LOCAL.EXPEDITIONS, C.STORAGE_LOCAL.EXPEDITIONS_AT],
                    busTypes: [C.MSG.WS.EXPEDITIONS],
                },
            });
        }

        async start() {
            this.track(Bus.window.on(C.MSG.WS.EXPEDITIONS, (env) => {
                if (!Array.isArray(env.expeditions)) return;
                const now = Date.now();
                const present = new Set();
                const out = env.expeditions.map((exp) => {
                    if (exp && exp.id) present.add(exp.id);
                    return track(exp, now);
                });
                // forget timers for expeditions no longer active
                for (const id of [...timers.keys()]) if (!present.has(id)) timers.delete(id);
                Store.local.set({
                    [C.STORAGE_LOCAL.EXPEDITIONS]: out,
                    [C.STORAGE_LOCAL.EXPEDITIONS_AT]: now,
                });
                this.debug('expeditions', { count: out.length });
            }));
        }
    }

    Registry.register(new ExpeditionsModule());
})();
