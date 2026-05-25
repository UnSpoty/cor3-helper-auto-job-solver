// Shared infrastructure for all 9 job flow modules.
//   • single-flow guard (only one flow runs at a time)
//   • startFlow helper — wraps a flow body with abort/lock plumbing
//   • COR3_ABORT_JOB_FLOW listener
//   • sendDone / sendTimeout — emit Bus signals back to auto-jobs orchestrator
// Exposes COR3.game.flows for flow modules.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Registry, constants: C } = root.COR3;
    const MSG = C.MSG;

    // Single in-flight flow guard. Each flow's start handler bails out fast
    // if this is true.
    let watchingJob = false;

    function isWatching() { return watchingJob; }
    function setWatching(v) { watchingJob = !!v; }

    /**
     * Unified flow result.
     *
     *   { success: true,  didWork: true  }                → orchestrator sends COR3_COMPLETE_JOB
     *   { success: true,  didWork: false, reason: 'X' }   → PERMANENT reject. There was nothing to do
     *                                                        (log not in list, no Logs section on D4RK,
     *                                                        file not on server). No completion sent.
     *                                                        Job stays rejected until it disappears
     *                                                        from markets, or user clicks "Clear".
     *   { success: false, reason: 'crash|timeout|…' }     → RUNTIME failure. Orchestrator retries the
     *                                                        job once after a short delay; the second
     *                                                        failure becomes a permanent reject with
     *                                                        the runtime details exposed in UI.
     *
     * sendResult is the SINGLE message a flow ever posts back; the orchestrator
     * consumes MINIGAME_RESULT exclusively.
     */
    function sendResult(jobId, marketId, result = {}) {
        const env = { jobId, marketId };
        if (result.success != null) env.success = result.success === true;
        if (result.didWork != null) env.didWork = result.didWork === true;
        if (result.reason)          env.reason  = String(result.reason);
        Bus.window.post(MSG.JOB.MINIGAME_RESULT, env);
    }

    function sendDone(jobId, marketId) {
        sendResult(jobId, marketId, { success: true, didWork: true });
    }

    /**
     * Runtime failure shortcut. The orchestrator routes !success to
     * retry-once semantics, so `transient` is no longer a separate axis;
     * the reason string carries enough detail for the user-facing log.
     */
    function sendTimeout(jobId, marketId, opts = {}) {
        sendResult(jobId, marketId, {
            success: false,
            reason: opts && opts.transient ? 'flow-transient-timeout' : 'flow-timeout',
        });
    }
    function userLog(msg, level = 'info') {
        Bus.window.post(MSG.JOB.LOG, { msg, level });
    }

    /**
     * Wrap a flow body. Sets pipeline lock, runs the body, releases the lock.
     * Catches exceptions and reports a timeout so auto-jobs doesn't hang.
     * @param {string} name      flow display name
     * @param {object} params    flow params (jobId/marketId/...)
     * @param {function} body    async () => void
     * @param {object} mod       Module instance (for this.info / this.error)
     */
    function startFlow(name, params, body, mod) {
        root.__jobManagerAbort = false;
        root.__pipelineLocked = true;
        watchingJob = false;
        if (mod) mod.info(`flow START ${name}`, params);
        Promise.resolve().then(body).then(() => {
            if (mod) mod.info(`flow END ${name} jobId=${params.jobId}`);
        }).catch((err) => {
            if (mod) mod.error(`flow CRASH ${name}`, { error: String(err), stack: err && err.stack });
            sendTimeout(params.jobId, params.marketId);
        }).finally(() => {
            root.__pipelineLocked = false;
        });
    }

    // ─── Module ───────────────────────────────────────────────────────────
    class FlowsCoreModule extends Module {
        constructor() {
            super({
                id: 'flows-core',
                name: 'Flow Runner',
                category: C.CATEGORY.GAME,
                dependsOn: ['sai-navigator'],
                owns: { busTypes: [MSG.JOB.ABORT, MSG.JOB.MINIGAME_DONE, MSG.JOB.MINIGAME_TIMEOUT] },
            });
        }

        async start() {
            this.track(Bus.window.on(MSG.JOB.ABORT, () => {
                root.__jobManagerAbort = true;
                root.__pipelineLocked = false;
                watchingJob = false;
                this.warn('flow ABORTED');
            }));

            // Init runtime flags used by flows + UI lock
            root.__jobManagerAbort = root.__jobManagerAbort || false;
            root.__pipelineLocked = root.__pipelineLocked || false;
            root.__autoJobsActive = root.__autoJobsActive || false;
            root.__connectStartedAt = root.__connectStartedAt || 0;
            root.__serverPathFailed = root.__serverPathFailed || 0;

            this.track(Bus.window.on('COR3_LOCK_UI', () => {
                root.__pipelineLocked = true;
                this.debug('UI locked');
            }));
            this.track(Bus.window.on('COR3_UNLOCK_UI', () => {
                root.__pipelineLocked = false;
                this.debug('UI unlocked');
            }));

            this.info('flows-core ready');
            Bus.window.post('COR3_JOB_MANAGER_READY', null);
        }
    }

    Registry.register(new FlowsCoreModule());

    // Expose
    root.COR3.game = root.COR3.game || {};
    root.COR3.game.flows = { isWatching, setWatching, sendDone, sendTimeout, sendResult, userLog, startFlow };
})();
