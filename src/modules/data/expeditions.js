// Owns: expeditionsData + expeditionsDataUpdatedAt.
//
// Also computes a corrected expedition end time. The server sends startTime/
// endTime as null even while RUNNING (only `runDuration` is given), and a raid
// PAUSES while a decision is pending (status === 'EVENT'), so the real end =
// launch + runDuration + Σ(time spent paused). The game tracks this client-side;
// we mirror it here, since this module runs continuously alongside the game and
// sees every status transition.
//
// Per active expedition we keep an in-memory timer and stamp two derived fields
// onto the stored object for the UI:
//   _timerEndMs    — wall-clock end (ms epoch); RUNNING counts down to this.
//   _timerFrozenMs — static remaining ms while paused at a decision (else null).
// Base end is seeded from the UUIDv7 id (first 48 bits = launch unix-ms) +
// runDuration; pause time is accrued from observed EVENT intervals. (Resets on
// page reload — pauses before the script started watching aren't recoverable,
// same as the game.)

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Store, Registry, constants: C } = root.COR3;

    // expId -> { endMs, lastAt, lastStatus, frozenMs }
    const timers = new Map();

    function launchMs(id) {
        const n = parseInt(String(id || '').replace(/-/g, '').slice(0, 12), 16);
        return (isFinite(n) && n > 1e12) ? n : null;
    }

    function track(exp, now) {
        if (!exp || !exp.id || !exp.runDuration || !exp.status || exp.status === 'COMPLETED') return exp;
        let st = timers.get(exp.id);
        if (!st) {
            const base = launchMs(exp.id);
            st = {
                endMs: (base != null ? base : now) + exp.runDuration,
                lastAt: now,
                lastStatus: exp.status,
                // first seen already paused → freeze at full duration (best guess)
                frozenMs: exp.status === 'EVENT' ? exp.runDuration : null,
            };
        } else {
            // Time spent paused since the last observation pushes the end later.
            if (st.lastStatus === 'EVENT') st.endMs += (now - st.lastAt);
            // Entering EVENT freezes the displayed remaining; leaving clears it.
            if (exp.status === 'EVENT' && st.lastStatus !== 'EVENT') st.frozenMs = Math.max(0, st.endMs - now);
            else if (exp.status !== 'EVENT') st.frozenMs = null;
            st.lastAt = now;
            st.lastStatus = exp.status;
        }
        timers.set(exp.id, st);
        return Object.assign({}, exp, {
            _timerEndMs: st.endMs,
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
