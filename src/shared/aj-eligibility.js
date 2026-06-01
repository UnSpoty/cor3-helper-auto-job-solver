// Auto Jobs — shared eligibility evaluator.
//
// The CONFIG part of a job's eligibility (the part derivable purely from user
// switches, with no pipeline data): global market toggles, global job-type
// toggles, and per-server overrides. It is the single source of truth used by
// BOTH worlds so the displayed and the enforced verdicts can never drift:
//   • the isolated pipeline (CHECK_JOBS_CONDITION) — for actual acceptance,
//   • the popup Job List — to re-derive the SKIP flag live the instant a
//     switch/override changes, without waiting for the next pipeline cycle.
//
// Loaded into the isolated content world AND the popup (see manifest +
// popup.html). The DATA part of eligibility (bugged registry, K/D cooldown,
// server accessibility, server known to the map) stays in the pipeline — the
// popup can't recompute it, so the pipeline stamps it onto the job as
// `dataSkipReason`.
//
// Default semantics: a market/type is enabled unless its switch is explicitly
// `false` (absent === on). This is a defined default, not a fallback.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    root.COR3 = root.COR3 || {};
    if (root.COR3.ajEligibility) return;

    // Returns the first config-derived skip reason for `job`, or null if the
    // job passes every config gate. `switches` = AJ_MASTER_SWITCHES,
    // `overrides` = AJ_SERVER_OVERRIDES.
    function configSkipReason(job, switches, overrides) {
        const sw = switches || {};
        const markets = sw.markets || {};
        const jobTypes = sw.jobTypes || {};

        if (job.marketSlot && markets[job.marketSlot] === false) return 'market disabled';
        if (job.type && jobTypes[job.type] === false) return `job type "${job.type}" disabled`;

        const ov = (overrides && job.serverName) ? overrides[job.serverName] : null;
        if (ov && ov.skip) return 'server skipped by user';
        if (ov && job.type && ov.disabledTypes && ov.disabledTypes[job.type]) {
            return `job type "${job.type}" disabled on this server`;
        }
        return null;
    }

    root.COR3.ajEligibility = { configSkipReason };
})();
