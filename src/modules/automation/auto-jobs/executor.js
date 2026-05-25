// Job execution wrapper — STATE_OPEN_SAI + STATE_FLOW_<TYPE> dispatch.
// Namespace stub: dispatchSolveFlow / executeNextFromQueue still live in
// auto-jobs.js. The intent is to move them here once the cooldown gate
// and result handling are factored out.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    if (!root.COR3 || !root.COR3.constants) return;

    async function dispatch(_job)  { return false; }
    function abortCurrent(_reason) {}
    function onResult(_env)        {}

    root.COR3.autoJobs = root.COR3.autoJobs || {};
    root.COR3.autoJobs.executor = { dispatch, abortCurrent, onResult };
})();
