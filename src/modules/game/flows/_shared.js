// src/modules/game/flows/_shared.js
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

    function sendDone(jobId, marketId) {
        Bus.window.post(MSG.JOB.MINIGAME_DONE, { jobId, marketId });
    }
    /**
     * Signal the orchestrator that this flow couldn't finish.
     * @param {string}  jobId
     * @param {string}  marketId
     * @param {object} [opts]
     * @param {boolean}[opts.transient=false] — flow gave up on a probably-
     *   recoverable condition (DOM not ready yet, list virtualised, server
     *   lag) rather than a definitive failure. Orchestrator buggs the job
     *   with a shorter TTL so the user doesn't have to wait 2h to retry
     *   something that may already work the next time the scan runs.
     */
    function sendTimeout(jobId, marketId, opts = {}) {
        const env = { jobId, marketId };
        if (opts.transient) env.transient = true;
        Bus.window.post(MSG.JOB.MINIGAME_TIMEOUT, env);
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

            // Legacy compat — content.js may still send the old lock messages.
            this.track(Bus.window.on('COR3_LOCK_UI', () => {
                root.__pipelineLocked = true;
                this.debug('UI locked (legacy)');
            }));
            this.track(Bus.window.on('COR3_UNLOCK_UI', () => {
                root.__pipelineLocked = false;
                this.debug('UI unlocked (legacy)');
            }));

            this.info('flows-core ready');
            // Tell isolated content.js the flow manager is alive (legacy parity)
            Bus.window.post('COR3_JOB_MANAGER_READY', null);
        }
    }

    Registry.register(new FlowsCoreModule());

    // Expose
    root.COR3.game = root.COR3.game || {};
    root.COR3.game.flows = { isWatching, setWatching, sendDone, sendTimeout, userLog, startFlow };
})();
