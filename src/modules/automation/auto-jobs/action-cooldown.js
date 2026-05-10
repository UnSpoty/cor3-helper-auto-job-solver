// src/modules/automation/auto-jobs/action-cooldown.js
// 3-second action pacing primitive for the auto-jobs orchestrator and flows.
//
// Phase 1: helper is published on root.COR3.autoJobs.cooldown but NOT yet
// integrated into auto-jobs.js or flows. Phase 2/3 will wire `gate(...)`
// into orchestrator state transitions and into key flow steps (open SAI,
// navigate section, submit) so the page has time to settle.
//
// Why a global gate (not per-flow): cor3.gg's WS frames sometimes arrive a
// beat after the DOM updates, and back-to-back actions inside the same
// 100-300ms window have been observed to lose follow-up clicks. A floor of
// 3s between *discrete actions* gives the renderer + WS room to catch up
// without rewriting every flow's intra-step `dom.sleep(N)` calls.
//
// API:
//   await cooldown.gate(label)                 — wait until 3s have elapsed
//                                                 since the last gated action.
//   await cooldown.gate(label, { override: 1500 }) — custom per-action floor.
//   cooldown.reset()                           — clear last-action timestamp
//                                                 (e.g. on module stop).
//   cooldown.lastAt()                          — last gated action timestamp
//                                                 (for debugging).

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    if (!root.COR3 || !root.COR3.constants) return;
    const { Bus, constants: C } = root.COR3;
    const MSG = C.MSG;

    let lastActionAt = 0;
    const DEFAULT = (C.LIMITS && C.LIMITS.ACTION_COOLDOWN_MS) || 3000;

    async function gate(actionLabel, opts) {
        const need = (opts && Number.isFinite(opts.override)) ? opts.override : DEFAULT;
        if (need <= 0) { lastActionAt = Date.now(); return; }
        const wait = Math.max(0, lastActionAt + need - Date.now());
        if (wait > 0) {
            // Use the JOB.LOG channel so this surfaces in the auto-jobs
            // activity log alongside flow steps. Debug level — most users
            // don't need to see every gate hit, but it's there if a step
            // appears stuck.
            try {
                Bus.window.post(MSG.JOB.LOG, {
                    msg: `[cooldown] +${wait}ms before "${actionLabel || '?'}"`,
                    level: 'debug',
                });
            } catch (_) { /* noop — Bus may not be ready in early init */ }
            await new Promise((r) => setTimeout(r, wait));
        }
        lastActionAt = Date.now();
    }

    function reset() { lastActionAt = 0; }
    function lastAt() { return lastActionAt; }

    root.COR3.autoJobs = root.COR3.autoJobs || {};
    root.COR3.autoJobs.cooldown = { gate, reset, lastAt, DEFAULT };
})();
