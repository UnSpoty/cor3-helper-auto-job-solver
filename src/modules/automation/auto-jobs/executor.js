// src/modules/automation/auto-jobs/executor.js
// Job execution wrapper — STATE_OPEN_SAI + STATE_FLOW_<TYPE> dispatch.
//
// Status: Phase 1 namespace stub. Phase 2 will extract the existing
// dispatchSolveFlow / executeNextFromQueue logic out of auto-jobs.js into
// this file and wrap it with the cooldown gate + smart-flow result handling.
//
// Planned API:
//   dispatch(job)             — post the START_*_FLOW envelope for `job`
//                                after `cooldown.gate('flow-start')`
//   abortCurrent(reason)      — post MSG.JOB.ABORT
//   onResult(envelope)        — handle MINIGAME_RESULT (Phase 3 retry-once)
//   buildPayload(job)         — return the FLOW_DISPATCH payload for tests

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    if (!root.COR3 || !root.COR3.constants) return;

    async function dispatch(_job) {
        // TODO(Phase 2): extract dispatchSolveFlow from auto-jobs.js
        return false;
    }

    function abortCurrent(_reason) {
        // TODO(Phase 2): wrap Bus.window.post(MSG.JOB.ABORT, null)
    }

    function onResult(_env) {
        // TODO(Phase 3): retry-once-then-permanent-reject logic
    }

    root.COR3.autoJobs = root.COR3.autoJobs || {};
    root.COR3.autoJobs.executor = { dispatch, abortCurrent, onResult };
})();
