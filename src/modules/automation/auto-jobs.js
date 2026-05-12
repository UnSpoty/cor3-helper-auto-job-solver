// src/modules/automation/auto-jobs.js
// Auto-jobs orchestrator. State machine: idle → accepting → solving → completing.
// Persists state, queue, and bugged-job blacklist across reloads.
// Schedules market scans, dispatches START_*_FLOW commands to MAIN flows,
// runs watchdogs against stuck states.
//
// Owned storage:
//   • chrome.storage.local: autoJobsState, autoJobsQueue, autoJobsLog,
//                           buggedJobIds, autoJobsPendingConfirm, autoJobsConfirmResult,
//                           networkMapServers
//   • chrome.storage.sync:  autoJobsSettings, serverPriorities

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Store, Registry, constants: C } = root.COR3;
    const MSG = C.MSG;

    // ─── Constants ────────────────────────────────────────────────────────
    // Phase 3 deleted the magic-number bugged-job TTLs (2 h hard, 15 min soft,
    // 30 min complete-rejected). Replacements:
    //   • rejectedJobs map (no TTL — auto-cleared when the job vanishes from
    //     markets, or via UI "Clear" button) for structural rejects.
    //   • Per-job retry-once counter for runtime failures; the second
    //     failure becomes a permanent reject with the runtime details
    //     surfaced in UI.
    //   • K/D-skip for servers — uses the actual K/D timer + KD_BUFFER_MS,
    //     not an arbitrary fallback.
    const STATE_TTL_MS      = C.LIMITS.AUTOJOBS_STATE_TTL_MS;
    const SENT_ACCEPT_TTL_MS = 3 * 60 * 1000;
    const COMPLETED_JOB_TTL_MS = 2 * 60 * 1000;
    const MARKET_REFRESH_INTERVAL_MS = 30 * 1000;
    const TICK_INTERVAL_MS = 5000;
    const KD_BUFFER_MS = (C.LIMITS && C.LIMITS.KD_BUFFER_MS) || 5 * 60 * 1000;
    // Cap for runtime-failure retries before a job becomes permanently
    // rejected. 2 = "try once, retry once". Higher would just waste time
    // on jobs that are genuinely broken; lower would skip on the first
    // transient hiccup the way users complained about.
    const MAX_FLOW_ATTEMPTS = 2;
    // Delay before re-running a job after a runtime failure. Long enough
    // for cor3.gg to settle (re-render lists, recover WS), short enough
    // that the user sees the retry happen visibly.
    const FLOW_RETRY_DELAY_MS = 5 * 1000;
    // Connection-class failures (server-unreachable, transient SAI open
    // failures from findOrOpenSai returning null) usually mean the WS
    // endpoint hasn't fully settled after a remote-market preflight or
    // we hit a brief race with cor3.gg's session handler. A 5s gap isn't
    // long enough for those — bump connection retries to 12s so the
    // endpoint flip definitely lands before the second attempt.
    const SERVER_UNREACHABLE_RETRY_DELAY_MS = 12 * 1000;
    // Settle delay between accept-batch close and the first job's flow
    // dispatch. Used to be 1s — too short when the batch ended on a
    // remote-market accept (DARK/SRM): the endpoint REVERT_TO_HOME post
    // hadn't completed when we tried connect() to a HOME-network server,
    // leaving the first job to fail its connect step and burn a retry.
    // 3s gives the WS endpoint flip room to land.
    const POST_ACCEPT_BATCH_DELAY_MS = 3 * 1000;
    // Reasons that should be treated as "connection failure" for retry
    // pacing purposes. Any of these substrings matches case-insensitively.
    const CONNECTION_FAIL_PATTERN = /transient|unreachable|connect|no.path/i;
    function isConnectionFailure(reason) {
        return !!(reason && CONNECTION_FAIL_PATTERN.test(String(reason)));
    }
    // cor3.gg only pushes a network-map.get.map envelope when the user
    // opens the in-game NM panel. Without external prompting our NM_GRAPH
    // (and therefore the popup's Network Map UI + reachability planner)
    // staleness compounds — K/D server status, hack-tool gates, new edges
    // never arrive. Force a refresh ourselves on a long timer when we're
    // idle and there's no current flow that would object.
    const NM_GRAPH_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
    let lastNmGraphRequestAt = 0;

    const IDLE_STATE = Object.freeze({
        status: 'idle', jobId: null, marketId: null, jobName: null,
        jobType: null, serverName: null, ips: null, fileCondition: null,
        fileNames: null, logSeqs: null,
    });

    const JOB_TYPE_KEYWORDS = {
        file_decryption:  ['file decryption',   'file_decryption'],
        ip_cleanup:       ['ip cleanup',         'ip_cleanup'],
        ip_injection:     ['ip injection',       'ip_injection'],
        log_deletion:     ['log deletion',       'log_deletion'],
        log_download:     ['log download',       'log_download'],
        file_elimination: ['file elimination',   'file_elimination'],
        data_download:    ['data download',      'data_download'],
        data_upload:      ['data upload',        'data_upload'],
        decrypt_extract:  ['decrypt & extract',  'decrypt and extract', 'decrypt_extract'],
    };

    const FLOW_DISPATCH = {
        file_decryption:  (j) => ({ type: MSG.JOB.START_DECRYPTION,       jobId: j.jobId, marketId: j.marketId, fileCondition: j.fileCondition }),
        ip_injection:     (j) => ({ type: MSG.JOB.START_IP_INJECTION,     jobId: j.jobId, marketId: j.marketId, serverName: j.serverName, ips: j.ips || [] }),
        ip_cleanup:       (j) => ({ type: MSG.JOB.START_IP_CLEANUP,       jobId: j.jobId, marketId: j.marketId, serverName: j.serverName, ips: j.ips || [] }),
        data_upload:      (j) => ({ type: MSG.JOB.START_UPLOAD,           jobId: j.jobId, marketId: j.marketId, serverName: j.serverName, fileCondition: j.fileCondition }),
        log_deletion:     (j) => ({ type: MSG.JOB.START_LOG_DELETION,     jobId: j.jobId, marketId: j.marketId, serverName: j.serverName, fileCondition: j.fileCondition, logSeqs: j.logSeqs }),
        log_download:     (j) => ({ type: MSG.JOB.START_LOG_DOWNLOAD,     jobId: j.jobId, marketId: j.marketId, serverName: j.serverName, fileCondition: j.fileCondition, logSeqs: j.logSeqs }),
        file_elimination: (j) => ({ type: MSG.JOB.START_FILE_ELIMINATION, jobId: j.jobId, marketId: j.marketId, serverName: j.serverName, fileCondition: j.fileCondition }),
        data_download:    (j) => ({ type: MSG.JOB.START_DATA_DOWNLOAD,    jobId: j.jobId, marketId: j.marketId, serverName: j.serverName, fileNames: (Array.isArray(j.fileNames) && j.fileNames.length) ? j.fileNames : (j.fileCondition ? [j.fileCondition] : []) }),
        decrypt_extract:  (j) => ({ type: MSG.JOB.START_DECRYPT_EXTRACT,  jobId: j.jobId, marketId: j.marketId, serverName: j.serverName, fileCondition: j.fileCondition }),
    };

    // ─── State (in-memory) ───────────────────────────────────────────────
    // Settings shape lives entirely in chrome.storage.sync.autoJobsSettings.
    // markets.{home,dark,srm} — which markets to scan and accept from.
    // debugMode was removed in the May 2026 audit (manual gating belongs in
    // job-types whitelist, not a global pause/confirm — too easy to forget on).
    let settings = { enabled: false, markets: { home: true, dark: true, srm: true }, enabledJobTypes: {}, autoDismissFailed: true };
    let serverPriorities = {};
    // Map serverName → depth (BFS hops from HOME). Filled when WS network-map.
    // get.map response arrives via onNmGraph. Deeper = higher priority in
    // jobPriority — leaves first, hubs last, so K/D timers don't stack on
    // path-critical servers.
    const nmDepths = new Map();
    let state = { ...IDLE_STATE };
    let queue = [];
    let rejectedJobs = {};                // Phase 3: { [jobId]: { reason, since, descriptor } }
    const kdSkipServers = new Map();
    const sentAcceptIds = new Map();
    const completedJobIds = new Map();
    // Tracks FAILED jobs we've already dispatched a dismiss for, so a
    // market refresh that still shows the job (cor3.gg can take a beat to
    // remove it from recentJobs) doesn't trigger duplicate dismiss frames.
    // Cleared per-id when the entry ages out, and scrubbed when the job
    // disappears from every visible market list.
    const dismissedFailedIds = new Map();
    const DISMISSED_FAILED_TTL_MS = 5 * 60 * 1000;
    // Incremental persistence of completed jobs — survives reload/crash.
    // Loaded on start(); written on every successful complete. Bounded ring
    // (LIMITS.COMPLETED_LOG_RING) to keep storage size predictable.
    let completedJobsLog = [];

    let bulkPendingJobs = [];
    let bulkSentOrder = [];
    let bulkAcceptCount = 0;
    let bulkAcceptTotal = 0;
    let bulkAcceptStartedAt = 0;

    let monitorIntervalId = null;
    let cooldownUntil = 0;
    let solvingStartedAt = 0;
    let completingStartedAt = 0;
    let lastMarketRefreshAt = 0;
    let jobManagerReady = false;
    let modRef = null;             // back-ref so helpers can log
    let lastEnabledApplied = false; // edge-detection state for handleEnabledChange

    // ─── Phase 5 orchestrator state ──────────────────────────────────────
    // Recovery counter: number of consecutive orchestration-level failures
    // (watchdogs, server unreachable without K/D cause, complete-rejected
    // permanent rejects). Resets to 0 on a successful operation. When the
    // counter hits RECOVERY_LIMIT we stop the tick loop and go to HALTED.
    let recoveryCounter = 0;
    const RECOVERY_LIMIT = 3;
    const RECOVERY_PAUSE_MS = 3000;
    const STARTING_PREROLL_MS = 10000;
    const ALL_JOBS_DONE_DISPLAY_MS = 5000;
    const NM_GRAPH_WAIT_MS = 30000;
    // bootGen invalidates an in-flight bootSequence when the user toggles
    // the module off (or off-then-on quickly). Each call to bootSequence
    // captures the current generation and bails out the moment it sees a
    // newer one — avoids two parallel boot pipelines stomping on state.
    let bootGen = 0;
    function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

    // ─── Storage glue ────────────────────────────────────────────────────
    function saveQueue() { Store.local.setOne(C.STORAGE_LOCAL.AUTOJOBS_QUEUE, queue); }
    function saveRejected() { Store.local.setOne(C.STORAGE_LOCAL.AJ_REJECTED_JOBS, rejectedJobs); }
    function saveState() { Store.local.setOne(C.STORAGE_LOCAL.AUTOJOBS_STATE, { ...state, updatedAt: Date.now() }); }
    function saveCompletedLog() {
        Store.local.setOne(C.STORAGE_LOCAL.AJ_COMPLETED_JOBS_LOG, completedJobsLog);
    }
    function recordCompletedJob(entry) {
        if (!entry || !entry.jobId) return;
        completedJobsLog.unshift(entry);
        const ring = (C.LIMITS && C.LIMITS.COMPLETED_LOG_RING) || 50;
        if (completedJobsLog.length > ring) completedJobsLog.length = ring;
        saveCompletedLog();
    }

    // Phase 4: emit a state-transition event whenever the runtime status
    // changes. The orchestrator helper (root.COR3.autoJobs.states) owns the
    // canonical name mapping + the in-memory ring buffer + storage persistence
    // so the popup timeline gets it for free. Pass the legacy `state.status`
    // strings — orchestrator.mapLegacyToCanonical normalises them.
    let lastEmittedStatus = null;
    function emitTransition(toStatus, reason) {
        const states = root.COR3.autoJobs && root.COR3.autoJobs.states;
        if (!states || typeof states.recordTransition !== 'function') return;
        const from = lastEmittedStatus ? states.mapLegacyToCanonical(lastEmittedStatus) : null;
        const to   = states.mapLegacyToCanonical(toStatus) || toStatus;
        if (from === to) return;  // dedupe identical consecutive states
        states.recordTransition(from, to, reason || null);
        lastEmittedStatus = toStatus;
    }

    // User-facing log line. Goes through Logger so the popup's Auto-Jobs tab
    // can render it via uiComponents.logViewer (filtered to module='auto-jobs')
    // and the Logs tab picks it up alongside other modules' logs. The legacy
    // STORAGE_LOCAL.AUTOJOBS_LOG ring is gone — single source of truth.
    function pushUserLog(msg, level = 'info') {
        if (modRef) modRef.log(level, msg);
    }

    function resetState(reason) {
        if (state.status !== 'idle' && modRef) {
            modRef.debug(`state ${state.status}(${state.jobId || '—'}) → idle${reason ? ` [${reason}]` : ''}`);
        }
        state = { ...IDLE_STATE };
        saveState();
        emitTransition('idle', reason);
    }

    // ─── Permanent reject (no TTL) ───────────────────────────────────────
    //
    // Replaces the old bugged-jobs TTL scheme. A rejected job stays rejected
    // until the markets confirm it's gone (auto-cleanup in
    // clearRejectedFromMarkets, called on every WS market arrival) or the
    // user clicks "Clear" in the UI. Each entry carries a reason + a
    // descriptor so the user can read the activity log and know exactly
    // why their queue moved on.
    function rejectJob(jobId, descriptor, reason) {
        if (!jobId) return;
        rejectedJobs[jobId] = {
            reason: String(reason || 'unknown'),
            since: Date.now(),
            descriptor: String(descriptor || jobId),
        };
        saveRejected();
        // Drop from the active queue if present — there's no point keeping
        // a rejected job in the run order.
        const qi = queue.findIndex((j) => j.jobId === jobId);
        if (qi !== -1) { queue.splice(qi, 1); saveQueue(); }
        if (modRef) modRef.warn(`reject ${jobId} "${descriptor}" — ${reason}`);
    }

    function isJobRejected(jobId) {
        return !!(jobId && rejectedJobs[jobId]);
    }

    // Drop reject entries whose jobId no longer appears in any visible
    // market list. cor3.gg removes a job either when someone took it or
    // when its lifetime expired — in both cases there's no point holding
    // the reject. Called on every WS market arrival.
    function clearRejectedFromMarkets(marketsBundle) {
        if (Object.keys(rejectedJobs).length === 0) return;
        const visibleIds = new Set();
        for (const data of marketsBundle) {
            if (!data) continue;
            for (const j of (data.jobs || [])) if (j && j.id) visibleIds.add(j.id);
            for (const j of (data.recentJobs || [])) if (j && j.id) visibleIds.add(j.id);
        }
        let cleared = 0;
        for (const id of Object.keys(rejectedJobs)) {
            if (!visibleIds.has(id)) { delete rejectedJobs[id]; cleared++; }
        }
        if (cleared > 0) {
            saveRejected();
            if (modRef) modRef.debug(`reject auto-clear: dropped ${cleared} stale entr(y/ies)`);
        }
    }

    // Walk recentJobs across every market for status === 'FAILED' and
    // dispatch a job.dismiss for each one we haven't already handled. A
    // failed job is just clutter — the user can't do anything with it
    // and it lingers in the "Active Jobs" panel until manually dismissed.
    // The WS layer (ws-interceptor.__cor3DismissJob) handles the
    // set.endpoint dance for DARK/SRM, so this scan is endpoint-agnostic.
    function dismissFailedFromMarkets(marketsBundle) {
        if (!settings.autoDismissFailed) return;
        const now = Date.now();
        // Prune the dedup map first so a job that vanished and reappeared
        // (server-side glitch) gets re-dismissed instead of silently held.
        for (const [id, ts] of dismissedFailedIds) {
            if (now - ts > DISMISSED_FAILED_TTL_MS) dismissedFailedIds.delete(id);
        }
        // Collect first, dispatch with spacing. A user with a backlog of 50
        // accumulated FAILED jobs would otherwise burst 50 wsSend frames in
        // one tick — fine for the WS itself, but rude to cor3.gg. 600ms
        // pacing is comfortably above any plausible rate-limit while still
        // clearing a typical 5-job backlog inside one market refresh cycle.
        const pending = [];
        for (const data of marketsBundle) {
            if (!data || !data.marketId) continue;
            const recent = data.recentJobs;
            if (!Array.isArray(recent)) continue;
            for (const j of recent) {
                if (!j || !j.id) continue;
                if (String(j.status || '').toUpperCase() !== 'FAILED') continue;
                if (dismissedFailedIds.has(j.id)) continue;
                dismissedFailedIds.set(j.id, now);
                pending.push({ jobId: j.id, marketId: data.marketId, name: j.name || j.id });
            }
        }
        for (let i = 0; i < pending.length; i++) {
            const p = pending[i];
            setTimeout(() => {
                Bus.window.post('COR3_DISMISS_JOB', { jobId: p.jobId, marketId: p.marketId });
                pushUserLog(`Dismissed FAILED job "${p.name}"`, 'warn');
                if (modRef) modRef.info(`dismiss FAILED ${p.jobId} on ${p.marketId}`);
            }, i * 600);
        }
    }

    function parseKDTimerMs(timerText) {
        if (!timerText) return 6 * 3600 * 1000;
        const m = timerText.match(/(?:(\d+)H)?:?(?:(\d+)M)?/i);
        const h = parseInt((m && m[1]) || '0');
        const min = parseInt((m && m[2]) || '0');
        return (h * 60 + min) * 60 * 1000 + KD_BUFFER_MS;
    }

    // ─── Phase 5: state-machine helpers ──────────────────────────────────
    //
    // These are the canonical ways to mutate state.status going forward.
    // Direct `state.status = …` writes still work (and are still used in a
    // few hot paths inside acceptCandidatesBatch / executeNextFromQueue
    // for legacy continuity), but anything that's a *failure-mode*
    // transition should route through enterRecovering / enterHalted so
    // the recovery counter does its job.

    function clearJobFromState() {
        state.jobId = null; state.marketId = null; state.jobName = null;
        state.jobType = null; state.serverName = null; state.ips = null;
        state.fileCondition = null; state.fileNames = null; state.logSeqs = null;
    }

    // Plain status setter — saves + emits a transition. No recovery side
    // effects; use enterRecovering / enterHalted for failure paths.
    function setStatus(s, reason) {
        if (state.status === s) return;
        state.status = s;
        saveState();
        emitTransition(s, reason);
    }

    // ALL_JOBS_DONE — the cycle just finished; sit in this status long
    // enough for the user to see it in the UI pill, then drop to idle so
    // the regular tick can pick up new market data.
    function enterAllJobsDone(reason) {
        clearJobFromState();
        state.status = 'all_jobs_done';
        saveState();
        emitTransition('all_jobs_done', reason || 'queue empty');
        setTimeout(() => {
            if (state.status === 'all_jobs_done') {
                state.status = 'idle';
                saveState();
                emitTransition('idle', 'all-jobs-done expired');
            }
        }, ALL_JOBS_DONE_DISPLAY_MS);
    }

    // RECOVERING — orchestration-level failure. Bumps the counter and, if
    // we haven't hit the limit, schedules a return to idle so the next
    // queue item can be picked up. Hitting the limit transitions to HALTED.
    function enterRecovering(reason, opts) {
        recoveryCounter++;
        const cap = RECOVERY_LIMIT;
        if (modRef) modRef.warn(`recovery ${recoveryCounter}/${cap} — ${reason}`);
        pushUserLog(`Recovering: ${reason}`, 'warn');

        clearJobFromState();
        state.status = 'recovering';
        state.haltReason = null;
        saveState();
        emitTransition('recovering', reason);

        if (recoveryCounter >= cap) {
            // Defer briefly so the recovering pill is visible before it
            // flips to halted — gives the user a chance to see what
            // happened in the activity log.
            setTimeout(() => enterHalted(`recovery limit reached (${cap}× consecutive): ${reason}`), 500);
            return;
        }

        const delay = (opts && Number.isFinite(opts.delayMs)) ? opts.delayMs : RECOVERY_PAUSE_MS;
        setTimeout(() => {
            // User may have toggled off / reset / re-entered recovery
            // during the delay — only act if we're still in this state.
            if (state.status !== 'recovering') return;
            state.status = 'idle';
            saveState();
            emitTransition('idle', 'recovery complete');
            if (queue.length > 0 && settings.enabled) executeNextFromQueue();
        }, delay);
    }

    // HALTED — hard stop. Disables the tick loop. The user must click
    // Reset (or toggle the module off-then-on) to recover. The
    // haltReason surfaces in the UI banner so they know what happened.
    function enterHalted(reason) {
        clearJobFromState();
        state.status = 'halted';
        state.haltReason = String(reason || 'unknown');
        saveState();
        emitTransition('halted', reason);
        if (modRef) modRef.error(`HALTED: ${reason}`);
        pushUserLog(`HALTED: ${reason}`, 'error');
        if (monitorIntervalId) { clearInterval(monitorIntervalId); monitorIntervalId = null; }
    }

    // Reset the recovery counter on any successful operation.
    function resetRecoveryCounter() {
        if (recoveryCounter !== 0) {
            if (modRef) modRef.debug(`recovery counter reset (was ${recoveryCounter})`);
            recoveryCounter = 0;
        }
    }

    // bootSequence — the proper module startup. Replaces the old "flip a
    // flag and start ticking" flow. Visible to the user as a sequence of
    // pill transitions: STARTING → DRAWING_LOCAL_MAP (if needed) →
    // DLM_CHECK_SERVERS_ACCESSABILITY → idle, then the regular tick takes
    // over.
    async function bootSequence() {
        const myGen = ++bootGen;
        const cancelled = () => myGen !== bootGen || !settings.enabled;

        setStatus('starting', 'autojobs toggle on');
        Bus.window.post(C.MSG.JOB.AUTOJOBS_ACTIVE_CHANGED, { active: true });
        await sleep(STARTING_PREROLL_MS);
        if (cancelled()) return;

        // If we don't have a Network Map yet, ask for one and wait. Without
        // it the planner can't reason about reachability and the UI can't
        // render the local map — better to wait briefly than to start
        // making decisions blind.
        const initialGraph = await Store.local.getOne(C.STORAGE_LOCAL.NM_GRAPH, null);
        if (!initialGraph) {
            setStatus('drawing_local_map', 'no NM_GRAPH yet — requesting');
            Bus.window.post(C.MSG.GAME.REQUEST_NM_MAP, null);
            const startWait = Date.now();
            while (Date.now() - startWait < NM_GRAPH_WAIT_MS) {
                await sleep(500);
                if (cancelled()) return;
                const g = await Store.local.getOne(C.STORAGE_LOCAL.NM_GRAPH, null);
                if (g) break;
            }
        }
        if (cancelled()) return;

        // Pre-flight reachability snapshot. Drives the local Network Map
        // overlay and gives the planner cached data on its first call.
        setStatus('dlm_check_servers_accessability', 'pre-flight reachability');
        try {
            const r = root.COR3.autoJobs && root.COR3.autoJobs.reachability;
            if (r && typeof r.computeAndPersist === 'function') await r.computeAndPersist();
        } catch (err) {
            if (modRef) modRef.warn('pre-flight reachability failed', { error: String(err && err.message || err) });
        }
        if (cancelled()) return;

        setStatus('idle', 'boot complete');

        if (!monitorIntervalId) {
            monitorIntervalId = setInterval(tick, TICK_INTERVAL_MS);
            tryResumeInProgress();
        }
        setTimeout(() => requestMarketRefresh('autojobs-toggle-on'), 800);
    }

    // Apply retry-once-then-permanent-reject to whatever the orchestrator
    // is currently driving. Used for runtime failures (flow crash, watchdog,
    // server unreachable without K/D, complete-rejected). On the second
    // failure, the job becomes a permanent reject so the queue moves on
    // and the user sees the reason instead of the queue silently stalling.
    //
    // For connection-class reasons we additionally force a REVERT_ENDPOINT_TO_HOME
    // and lengthen the retry delay — those failures are usually about the
    // WS endpoint sitting on the wrong market when connect() ran, and a
    // longer gap + a forced revert clears it.
    function retryOrReject(jobId, descriptor, reason, opts) {
        if (!jobId) return;
        const qi = queue.findIndex((j) => j.jobId === jobId);
        const queued = qi !== -1 ? queue[qi] : null;
        const attempts = ((queued && queued.attempts) || 0) + 1;
        const isConn = isConnectionFailure(reason);
        const defaultDelay = isConn ? SERVER_UNREACHABLE_RETRY_DELAY_MS : FLOW_RETRY_DELAY_MS;
        const delayMs = (opts && Number.isFinite(opts.delayMs)) ? opts.delayMs : defaultDelay;
        if (queued && attempts < MAX_FLOW_ATTEMPTS) {
            queued.attempts = attempts;
            saveQueue();
            if (isConn) {
                // Force the WS back onto the HOME endpoint before the
                // retry. Cheap (no-op when already HOME) and prevents
                // the same failure from happening a second time when the
                // root cause was an endpoint mismatch.
                Bus.window.post(C.MSG.GAME.REVERT_ENDPOINT_TO_HOME, null);
            }
            pushUserLog(`Retrying "${descriptor}" (attempt ${attempts + 1}/${MAX_FLOW_ATTEMPTS}, +${Math.round(delayMs/1000)}s) — ${reason}`, 'warn');
            return { retried: true, delayMs };
        }
        rejectJob(jobId, descriptor, `${reason}${attempts > 1 ? ` (failed ${attempts}×)` : ''}`);
        return { retried: false };
    }

    function requestMarketRefresh(reason, opts) {
        const skipRemote = !!(opts && opts.skipRemote);
        lastMarketRefreshAt = Date.now();
        if (modRef) modRef.debug(`market refresh [${reason || 'manual'}]${skipRemote ? ' home-only' : ''}`);
        Bus.window.post(MSG.GAME.REFRESH_MARKET, null);
        // Remote markets (DARK / SRM) are unreachable from HOME, so each refresh
        // does a set.endpoint preflight to flip onto their market server. That's
        // fine for fresh-start / accept-batch-done / idle-poll moments, but
        // racy for post-job-completed: the preflights are still in flight when
        // the next SAI job's connect() runs, so cor3.gg sees endpoint mismatch
        // and rejects the login ("Connect btn reappeared" in server-connect).
        // skipRemote=true keeps the home refresh (so the popup counter updates)
        // without churning the WS endpoint.
        if (skipRemote) return;
        if (settings.markets && settings.markets.dark) Bus.window.post(MSG.GAME.REFRESH_DARK_MARKET, null);
        if (settings.markets && settings.markets.srm)  Bus.window.post(MSG.GAME.REFRESH_SRM_MARKET,  null);
    }

    // ─── API extractors (canonical — never falls back to DOM) ─────────────
    function extractServerFromJob(job) {
        if (!job) return null;
        const rs = job.relatedServers;
        if (!rs) return null;
        if (typeof rs === 'string') return rs || null;
        if (Array.isArray(rs) && rs.length > 0) {
            const first = rs[0];
            if (typeof first === 'string') return first || null;
            if (first && typeof first === 'object') return first.name || first.serverName || first.server || null;
        }
        return null;
    }

    function extractLogSeqsFromJob(job) {
        if (!job) return null;
        const items = job.conditions && job.conditions.items;
        if (!Array.isArray(items)) return null;
        for (const item of items) {
            const d = item.details;
            if (d && Array.isArray(d.logSeqs) && d.logSeqs.length > 0) return d.logSeqs.slice();
        }
        return null;
    }

    function extractIPsFromJob(job) {
        if (!job) return [];
        function collectFromObj(d, out) {
            if (!d) return;
            if (Array.isArray(d.ipAddresses))                          out.push(...d.ipAddresses);
            else if (Array.isArray(d.ips))                             out.push(...d.ips);
            else if (typeof d.ipAddress === 'string' && d.ipAddress)   out.push(d.ipAddress);
            else if (typeof d.ip        === 'string' && d.ip)          out.push(d.ip);
        }
        const ips = [];
        const items = job.conditions && job.conditions.items;
        if (Array.isArray(items)) for (const item of items) collectFromObj(item.details, ips);
        if (ips.length === 0) collectFromObj(job.conditions, ips);
        return ips.filter((ip) => /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip));
    }

    function resolveJobParams(type, apiJob) {
        if (!apiJob) return { ok: false, reason: 'no apiJob' };
        const items = (apiJob.conditions && apiJob.conditions.items) || [];
        function pickDetail(predicate) {
            for (const item of items) {
                const d = item && item.details;
                if (!d) continue;
                const v = predicate(d);
                if (v != null && v !== '') return v;
            }
            return null;
        }
        const server = extractServerFromJob(apiJob);

        switch (type) {
            case 'file_decryption': {
                const fileName = pickDetail((d) => d.fileNames?.[0] || d.fileName || d.files?.[0]?.name);
                if (!fileName) return { ok: false, reason: 'no fileName in conditions' };
                return { ok: true, params: { fileCondition: fileName } };
            }
            case 'data_upload':
            case 'file_elimination':
            case 'decrypt_extract': {
                if (!server) return { ok: false, reason: 'no server' };
                const fileName = pickDetail((d) => d.fileNames?.[0] || d.fileName || d.files?.[0]?.name);
                if (!fileName) return { ok: false, reason: 'no fileName' };
                return { ok: true, params: { serverName: server, fileCondition: fileName } };
            }
            case 'data_download': {
                if (!server) return { ok: false, reason: 'no server' };
                const names = [];
                for (const item of items) {
                    const d = item && item.details;
                    if (!d) continue;
                    if (Array.isArray(d.fileNames)) for (const n of d.fileNames) if (n) names.push(n);
                    if (typeof d.fileName === 'string' && d.fileName) names.push(d.fileName);
                    if (Array.isArray(d.files)) for (const f of d.files) if (f?.name) names.push(f.name);
                }
                const fileNames = [...new Set(names)];
                if (fileNames.length === 0) return { ok: false, reason: 'no fileName' };
                return { ok: true, params: { serverName: server, fileCondition: fileNames[0], fileNames } };
            }
            case 'ip_injection':
            case 'ip_cleanup': {
                if (!server) return { ok: false, reason: 'no server' };
                const ips = extractIPsFromJob(apiJob);
                if (!ips.length) return { ok: false, reason: 'no IPs' };
                return { ok: true, params: { serverName: server, ips } };
            }
            case 'log_deletion':
            case 'log_download': {
                if (!server) return { ok: false, reason: 'no server' };
                const logName = pickDetail((d) => d.logNames?.[0] || d.logName);
                const logSeqs = extractLogSeqsFromJob(apiJob);
                if (!logName && !(logSeqs && logSeqs.length)) return { ok: false, reason: 'no logName/logSeqs' };
                return { ok: true, params: { serverName: server, fileCondition: logName || null, logSeqs: logSeqs || null } };
            }
        }
        return { ok: false, reason: `unknown job type "${type}"` };
    }

    function detectJobType(job) {
        if (!job || job.isCompleted || job.isExpired) return null;
        const name = (job.name || job.category || '').toLowerCase();
        for (const [type, keywords] of Object.entries(JOB_TYPE_KEYWORDS)) {
            if (keywords.some((kw) => name.includes(kw))) return type;
        }
        return null;
    }

    function dispatchSolveFlow(job) {
        const builder = FLOW_DISPATCH[job.jobType];
        if (!builder) {
            if (modRef) modRef.error(`unknown jobType "${job.jobType}"`);
            return false;
        }
        const payload = builder(job);
        if (modRef) modRef.info(`dispatch ${payload.type}`, payload);
        Bus.window.post(payload.type, payload);
        return true;
    }

    // ─── Scan + accept ───────────────────────────────────────────────────
    // Each market entry: storage data key, availability flag (for remote
    // markets that can be unreachable), source label (for logs), and the
    // settings flag in settings.markets.<key>.
    const MARKETS_FOR_SCAN = [
        { key: 'home', dataKey: C.STORAGE_LOCAL.MARKET,      availKey: null,                                source: 'home' },
        { key: 'dark', dataKey: C.STORAGE_LOCAL.DARK_MARKET, availKey: C.STORAGE_LOCAL.DARK_MARKET_AVAILABLE, source: 'dark' },
        { key: 'srm',  dataKey: C.STORAGE_LOCAL.SRM_MARKET,  availKey: C.STORAGE_LOCAL.SRM_MARKET_AVAILABLE,  source: 'srm'  },
    ];

    async function findCandidates() {
        const allKeys = MARKETS_FOR_SCAN.flatMap((m) => m.availKey ? [m.dataKey, m.availKey] : [m.dataKey]);
        const result = await Store.local.get(allKeys);

        // Prune sentAcceptIds for jobs no longer visible on any market.
        if (sentAcceptIds.size > 0) {
            const allIds = new Set();
            for (const m of MARKETS_FOR_SCAN) {
                const jobs = result[m.dataKey]?.jobs;
                if (Array.isArray(jobs)) for (const j of jobs) allIds.add(j.id);
            }
            for (const id of sentAcceptIds.keys()) if (!allIds.has(id)) sentAcceptIds.delete(id);
        }

        const candidates = [];
        function scan(jobs, mid, source) {
            for (const job of jobs) {
                const type = detectJobType(job);
                if (!type) continue;
                if (settings.enabledJobTypes && settings.enabledJobTypes[type] === false) continue;
                const sentTs = sentAcceptIds.get(job.id);
                if (sentTs && Date.now() - sentTs < SENT_ACCEPT_TTL_MS) continue;
                if (isJobRejected(job.id)) continue;
                if (['ip_injection','ip_cleanup','data_upload','log_deletion','log_download','file_elimination','data_download','decrypt_extract'].includes(type)) {
                    const srvName = extractServerFromJob(job);
                    if (srvName) {
                        // User skip — persistent, set via popup. Used to keep
                        // hub servers off-limits so K/D timers don't accidentally
                        // sever the path to downstream servers.
                        if (serverPriorities[srvName] === 'skip') continue;
                        // Transient K/D skip — set by onKdDetected /
                        // onServerUnreachable, expires automatically.
                        const expiry = kdSkipServers.get(srvName);
                        if (expiry) {
                            if (Date.now() < expiry) continue;
                            kdSkipServers.delete(srvName);
                        }
                    }
                }
                candidates.push({ ...job, marketId: mid, source, type });
            }
        }

        for (const m of MARKETS_FOR_SCAN) {
            if (settings.markets[m.key] === false) continue;
            if (m.availKey && result[m.availKey] === false) continue;
            const data = result[m.dataKey];
            if (!data?.jobs || !data.marketId) continue;
            scan(data.jobs, data.marketId, m.source);
        }
        return candidates;
    }

    function acceptCandidatesBatch(candidates) {
        if (state.status !== 'idle') { modRef.warn('accept skipped — status not idle'); return; }
        if (!candidates.length) return;

        // Group accepts by marketId so MAIN's __cor3AcceptJob only does
        // ONE set.endpoint preflight per market (HOME jobs first, then DARK,
        // then SRM — or whatever the natural sort order is). Without
        // grouping, an interleaved [HOME, DARK, HOME, DARK] batch would
        // flip the endpoint 4 times.
        candidates.sort((a, b) => (a.marketId || '').localeCompare(b.marketId || ''));

        state = { ...IDLE_STATE, status: 'accepting', jobName: `Accepting ${candidates.length} job(s)` };
        saveState();
        emitTransition('accepting', `n=${candidates.length}`);
        modRef.info(`accept-batch n=${candidates.length}`);
        pushUserLog(`Accept: sending ${candidates.length} request(s)…`);

        bulkPendingJobs = candidates.map((c) => ({ id: c.id, marketId: c.marketId, type: c.type, name: c.name || c.id, apiJob: c }));
        bulkSentOrder = [];
        bulkAcceptCount = 0;
        bulkAcceptTotal = bulkPendingJobs.length;
        bulkAcceptStartedAt = Date.now();

        for (let i = 0; i < bulkPendingJobs.length; i++) {
            const pending = bulkPendingJobs[i];
            const delay = i * 1200 + 800 + Math.floor(Math.random() * 300);
            sentAcceptIds.set(pending.id, Date.now());
            setTimeout(() => {
                bulkSentOrder.push(pending);
                Bus.window.post(MSG.GAME.ACCEPT_JOB, { jobId: pending.id, marketId: pending.marketId });
            }, delay);
        }
    }

    // ─── Execute ─────────────────────────────────────────────────────────
    function jobPriority(job) {
        // file_decryption jobs (no server, just a file in Downloads) and any
        // jobs lacking a serverName always run first — nothing they do can
        // affect the network-map K/D state.
        if (!job.serverName || job.jobType === 'file_decryption') return Number.POSITIVE_INFINITY;
        // Manual numeric override wins. ('skip' is filtered upstream and
        // shouldn't reach here, but if it does, treat as far below default.)
        const p = serverPriorities[job.serverName];
        if (Number.isFinite(p)) return p;
        // Default: BFS depth from HOME. Deeper = higher priority so we drain
        // leaf servers before stacking K/D timers on the hubs they depend on.
        // Falls back to 0 for any server we don't have a depth for yet.
        const d = nmDepths.get(job.serverName);
        return Number.isFinite(d) ? d : 0;
    }
    // Within a server-priority tier, transit jobs (IP inject / IP cleanup) run
    // first. Rationale: they affect *who can route through this server next*,
    // so doing them early avoids losing access mid-cycle. Pattern lifted from
    // the Femtocel11 competitor's JOB_TYPE_PRIORITY scheme — but as a
    // tie-breaker rather than the dominant key, so depth-based draining still
    // wins on the primary axis.
    const TRANSIT_JOB_TYPES = new Set([C.FLOW.IP_INJECTION, C.FLOW.IP_CLEANUP]);
    function jobTypeBonus(job) {
        return TRANSIT_JOB_TYPES.has(job.jobType) ? 1 : 0;
    }
    function sortQueueByPriority() {
        queue.sort((a, b) => {
            const pa = jobPriority(a), pb = jobPriority(b);
            if (pa !== pb) return pb - pa;
            return jobTypeBonus(b) - jobTypeBonus(a);
        });
    }

    async function executeNextFromQueue() {
        if (queue.length === 0) {
            if (state.status !== 'idle') resetState('queue-empty');
            return;
        }
        if (state.status !== 'idle') return;

        sortQueueByPriority();
        const job = queue[0];
        if (!FLOW_DISPATCH[job.jobType]) {
            modRef.warn(`unknown jobType "${job.jobType}" — drop`);
            queue.shift(); saveQueue();
            setTimeout(executeNextFromQueue, 500);
            return;
        }

        pushUserLog(`Queue (${queue.length} left): "${job.jobName}" [${job.jobType}]`);

        state = { ...IDLE_STATE, status: 'solving', jobId: job.jobId, marketId: job.marketId, jobName: job.jobName,
                  jobType: job.jobType, serverName: job.serverName || null, ips: job.ips || null,
                  fileCondition: job.fileCondition || null, fileNames: job.fileNames || null, logSeqs: job.logSeqs || null };
        solvingStartedAt = Date.now();
        saveState();
        // Map jobType → specific FLOW_* state via orchestrator's helper so the
        // UI pill shows e.g. "Log Deletion" instead of generic "Open SAI".
        const states = root.COR3.autoJobs && root.COR3.autoJobs.states;
        const flowState = (states && states.FLOW_STATE_BY_TYPE && states.FLOW_STATE_BY_TYPE[job.jobType]) || 'solving';
        emitTransition(flowState, `${job.jobName || job.jobType}`);
        pushUserLog(`━━━ ${job.jobName || job.jobType} [${job.jobType}] ━━━`, 'separator');

        setTimeout(() => dispatchSolveFlow(job), 500);
    }

    // ─── Resume in-progress (TAKEN jobs after market refresh) ─────────────
    async function tryResumeInProgress() {
        if (state.status !== 'idle') return;
        const now = Date.now();
        for (const [id, ts] of completedJobIds) if (now - ts > COMPLETED_JOB_TTL_MS) completedJobIds.delete(id);

        // Read the same set of markets findCandidates reads — keeps SRM
        // resumes wired alongside Home/Dark for free.
        const allKeys = MARKETS_FOR_SCAN.flatMap((m) => m.availKey ? [m.dataKey, m.availKey] : [m.dataKey]);
        const result = await Store.local.get(allKeys);
        function collectTaken(data, mid, out) {
            if (!data || !mid) return;
            for (const job of (data.recentJobs || [])) {
                if (job.status !== 'TAKEN') continue;
                const type = detectJobType(job);
                if (!type) continue;
                if (settings.enabledJobTypes && settings.enabledJobTypes[type] === false) continue;
                if (isJobRejected(job.id)) continue;
                // Honour user skip list here too — if a TAKEN job lives on a
                // skipped server, don't auto-resume it. The user clicked Skip
                // for a reason; respect that even for in-flight jobs.
                const srvName = extractServerFromJob(job);
                if (srvName && serverPriorities[srvName] === 'skip') continue;
                out.push({ ...job, marketId: mid, type });
            }
        }
        const taken = [];
        for (const m of MARKETS_FOR_SCAN) {
            if (settings.markets[m.key] === false) continue;
            if (m.availKey && result[m.availKey] === false) continue;
            const data = result[m.dataKey];
            // Storage shape is flat now: { marketId, jobs, recentJobs, … }.
            // Old code read data.market.id (legacy single-payload shape) and
            // silently dropped every Resume — the bug stayed invisible
            // because findCandidates already had the new path.
            if (data?.marketId) collectTaken(data, data.marketId, taken);
        }

        let added = 0;
        for (const job of taken) {
            if (queue.find((q) => q.jobId === job.id)) continue;
            if (state.jobId === job.id) continue;
            if (completedJobIds.has(job.id)) continue;
            const r = resolveJobParams(job.type, job);
            if (!r.ok) continue;
            queue.push({
                jobId: job.id, marketId: job.marketId, jobType: job.type,
                jobName: job.name || job.category || job.id,
                serverName: r.params.serverName || null,
                fileCondition: r.params.fileCondition || null,
                fileNames: r.params.fileNames || null,
                ips: r.params.ips || null,
                logSeqs: r.params.logSeqs || null,
            });
            pushUserLog(`Resume: "${job.name || job.id}" [${job.type}]`, 'warn');
            added++;
        }
        if (added > 0) {
            saveQueue();
            if (jobManagerReady) setTimeout(executeNextFromQueue, 2000);
        }
    }

    // ─── Tick ────────────────────────────────────────────────────────────
    async function tick() {
        if (!settings.enabled) return;
        // Phase 5: skip work entirely when the orchestrator is in a busy
        // / boot / recovery / halted state. Each of these has its own
        // timing — we don't want the tick loop racing with them.
        if (state.status === 'halted' ||
            state.status === 'starting' ||
            state.status === 'recovering' ||
            state.status === 'paused' ||
            state.status === 'drawing_local_map' ||
            state.status === 'dlm_check_servers_accessability') return;

        // Watchdogs
        if (state.status === 'accepting' && bulkAcceptStartedAt > 0 && Date.now() - bulkAcceptStartedAt > 60000) {
            modRef.warn('accept watchdog 60s — recovery');
            pushUserLog('Accept watchdog — recovering', 'warn');
            saveQueue();
            bulkPendingJobs = []; bulkSentOrder = []; bulkAcceptCount = 0; bulkAcceptTotal = 0; bulkAcceptStartedAt = 0;
            enterRecovering('accept-batch watchdog 60s');
            return;
        }
        // 5 min ceiling — was 3 min, but server-connect's hack-tool fallback
        // can spend up to 4 min on the ice-wall puzzle (matches cor3.gg's
        // own in-game deadline). Connect + actual job work sit on top of
        // that; 5 min leaves a small buffer before we declare a real hang.
        if (state.status === 'solving' && solvingStartedAt > 0 && Date.now() - solvingStartedAt > 300000) {
            modRef.warn('solving watchdog 5min');
            Bus.window.post(MSG.JOB.ABORT, null);
            // Phase 5: a watchdog hit is a runtime failure. Route through
            // per-job retry-once first; if the job was already on its
            // second attempt and gets permanently rejected here, the
            // event also bumps the orchestration recovery counter.
            if (state.jobId) {
                const decision = retryOrReject(state.jobId, state.jobName || state.jobType || 'Unknown',
                                               'solving watchdog 5min');
                solvingStartedAt = 0;
                if (decision.retried) {
                    // First attempt — keep counter, requeue and continue.
                    setStatus('idle', 'flow watchdog -> retry');
                    setTimeout(executeNextFromQueue, decision.delayMs);
                } else {
                    // Second attempt failed — orchestration-level event.
                    enterRecovering('solving-watchdog (permanent reject)');
                }
                return;
            }
            solvingStartedAt = 0;
            enterRecovering('solving-watchdog (no jobId)');
            return;
        }
        if (state.status === 'completing' && completingStartedAt > 0 && Date.now() - completingStartedAt > 45000) {
            modRef.warn('completing watchdog 45s');
            pushUserLog('Completion watchdog — recovering', 'warn');
            completingStartedAt = 0;
            enterRecovering('completing-watchdog 45s');
            setTimeout(() => requestMarketRefresh('completing-watchdog'), 1000);
            return;
        }

        if (Date.now() < cooldownUntil) return;

        // ALL_JOBS_DONE behaves like idle for queue-take purposes — if new
        // work arrived during the 5-second display window, we should pick
        // it up immediately instead of waiting for the timer to expire.
        const isIdleLike = (state.status === 'idle' || state.status === 'all_jobs_done');

        if (queue.length > 0 && isIdleLike) {
            if (state.status === 'all_jobs_done') {
                setStatus('idle', 'new queue work arrived');
            }
            executeNextFromQueue();
            return;
        }
        if (!isIdleLike) return;
        if (Date.now() - lastMarketRefreshAt > MARKET_REFRESH_INTERVAL_MS) {
            // Phase 5: surface the refresh as a transient state transition
            // for the UI timeline. The pill itself stays idle — this is a
            // brief overlay event, not a busy state.
            const states = root.COR3.autoJobs && root.COR3.autoJobs.states;
            if (states && states.recordTransition) {
                states.recordTransition(state.status, 'timer_expired_time_to_upd', 'idle-poll refresh');
            }
            requestMarketRefresh('idle-poll');
        }
        // Periodic Network Map refresh — cor3.gg won't push graph updates
        // unless the user opens the NM panel in-game, so we ask for one
        // ourselves on a long timer. Scheduled only when idle so we don't
        // race a connect() on the WS.
        if (Date.now() - lastNmGraphRequestAt > NM_GRAPH_REFRESH_INTERVAL_MS) {
            lastNmGraphRequestAt = Date.now();
            Bus.window.post(C.MSG.GAME.REQUEST_NM_MAP, null);
            if (modRef) modRef.debug('periodic NM_GRAPH refresh requested');
        }
        const candidates = await findCandidates();

        // Phase 3: planner is now ENFORCED. findCandidates already skips
        // rejected/sent/buggedJobTypes, but the planner adds a stricter
        // pre-flight: server-cap (no Logs section), in-graph K/D, path-K/D.
        // What used to be a "log-only" verdict is now the gate for the
        // accept-batch. If the planner blows up, fall back to the legacy
        // candidate list so a planner bug doesn't stop the queue cold.
        let toAccept = candidates;
        try {
            const planner = root.COR3.autoJobs && root.COR3.autoJobs.planner;
            if (planner && candidates.length > 0) {
                // Phase 5: surface the planner pass in the timeline. Like
                // timer_expired_time_to_upd, this is a transient overlay
                // — the pill stays at whatever it was, but the user can
                // see we evaluated.
                const states = root.COR3.autoJobs && root.COR3.autoJobs.states;
                if (states && states.recordTransition) {
                    states.recordTransition(state.status, 'check_job_conditions', `${candidates.length} candidate(s)`);
                }
                const ctx = await planner.buildContext({
                    kdSkipServers, serverPriorities,
                    extractServer: extractServerFromJob,
                });
                const enriched = candidates.map((j) => ({ ...j, serverName: extractServerFromJob(j) }));
                const { accepted, rejected } = planner.filterCandidates(enriched, ctx);
                toAccept = accepted;
                if (rejected.length > 0) {
                    const summary = planner.summarizeRejected(rejected) || '?';
                    if (modRef) modRef.info(`planner: rejected ${rejected.length}/${candidates.length} — ${summary}`);
                }
            }
        } catch (err) {
            if (modRef) modRef.warn('planner failed — falling back to legacy candidates', { error: String(err && err.message || err) });
            toAccept = candidates;
        }

        if (toAccept.length > 0) acceptCandidatesBatch(toAccept);
    }

    // ─── Module ───────────────────────────────────────────────────────────
    class AutoJobsModule extends Module {
        constructor() {
            super({
                id: 'auto-jobs',
                name: 'Auto-Jobs',
                category: C.CATEGORY.AUTOMATION,
                dependsOn: ['market', 'dark-market'],
                owns: {
                    storageKeys: [
                        C.STORAGE_SYNC.AUTOJOBS_SETTINGS, C.STORAGE_SYNC.SERVER_PRIORITIES,
                        C.STORAGE_LOCAL.AUTOJOBS_STATE, C.STORAGE_LOCAL.AUTOJOBS_QUEUE,
                        C.STORAGE_LOCAL.BUGGED_JOBS,
                    ],
                },
            });
            modRef = this;
        }

        async init() {
            const sync = await Store.sync.get([C.STORAGE_SYNC.AUTOJOBS_SETTINGS, C.STORAGE_SYNC.SERVER_PRIORITIES]);
            if (sync[C.STORAGE_SYNC.AUTOJOBS_SETTINGS]) settings = sync[C.STORAGE_SYNC.AUTOJOBS_SETTINGS];
            if (sync[C.STORAGE_SYNC.SERVER_PRIORITIES] && typeof sync[C.STORAGE_SYNC.SERVER_PRIORITIES] === 'object') {
                serverPriorities = sync[C.STORAGE_SYNC.SERVER_PRIORITIES];
            }
            const local = await Store.local.get([
                C.STORAGE_LOCAL.AUTOJOBS_STATE,
                C.STORAGE_LOCAL.AUTOJOBS_QUEUE,
                C.STORAGE_LOCAL.AJ_REJECTED_JOBS,
                C.STORAGE_LOCAL.AJ_COMPLETED_JOBS_LOG,
                C.STORAGE_LOCAL.BUGGED_JOBS,           // legacy — read once to flush
            ]);
            if (Array.isArray(local[C.STORAGE_LOCAL.AJ_COMPLETED_JOBS_LOG])) {
                completedJobsLog = local[C.STORAGE_LOCAL.AJ_COMPLETED_JOBS_LOG];
            }
            if (local[C.STORAGE_LOCAL.AUTOJOBS_STATE] && local[C.STORAGE_LOCAL.AUTOJOBS_STATE].status !== 'idle') {
                const ls = local[C.STORAGE_LOCAL.AUTOJOBS_STATE];
                const age = Date.now() - (ls.updatedAt || 0);
                // Phase 5: ephemeral states (boot pipeline, recovery, halt,
                // success-display) shouldn't survive a reload — they only
                // make sense in the running session that put them there.
                // Drop back to idle on restore for any of these.
                const ephemeral = [
                    'accepting', 'starting', 'recovering', 'all_jobs_done',
                    'halted', 'paused', 'drawing_local_map',
                    'dlm_check_servers_accessability', 'dlm_fix_servers_accesability',
                ];
                if (ephemeral.includes(ls.status)) {
                    Store.local.setOne(C.STORAGE_LOCAL.AUTOJOBS_STATE, { status: 'idle', updatedAt: Date.now() });
                } else if (age < STATE_TTL_MS) {
                    state = ls;
                    this.info(`restored state ${state.status} ${state.jobId || ''}`);
                } else {
                    Store.local.setOne(C.STORAGE_LOCAL.AUTOJOBS_STATE, { status: 'idle', updatedAt: Date.now() });
                }
            }
            // Phase 3: load the new rejected-jobs map. The legacy
            // BUGGED_JOBS storage is no longer authoritative; if the user
            // is upgrading from a pre-Phase-3 build we wipe it so old TTL
            // entries don't keep ghost-skipping jobs after the upgrade.
            rejectedJobs = (local[C.STORAGE_LOCAL.AJ_REJECTED_JOBS] && typeof local[C.STORAGE_LOCAL.AJ_REJECTED_JOBS] === 'object')
                ? { ...local[C.STORAGE_LOCAL.AJ_REJECTED_JOBS] }
                : {};
            if (local[C.STORAGE_LOCAL.BUGGED_JOBS]) {
                Store.local.remove([C.STORAGE_LOCAL.BUGGED_JOBS]);
                this.info('cleared legacy bugged-jobs storage on upgrade to Phase 3');
            }
            if (Array.isArray(local[C.STORAGE_LOCAL.AUTOJOBS_QUEUE])) {
                queue = local[C.STORAGE_LOCAL.AUTOJOBS_QUEUE].filter((j) => !isJobRejected(j.jobId));
            }
            // Seed nmDepths from persisted graph so depth-priority sort works
            // before the first WS get.map response after reload.
            const persistedGraph = await Store.local.getOne(C.STORAGE_LOCAL.NM_GRAPH, null);
            if (persistedGraph && Array.isArray(persistedGraph.servers)) {
                for (const s of persistedGraph.servers) {
                    if (s.name && Number.isFinite(s.depth)) nmDepths.set(s.name, s.depth);
                }
            }
        }

        async start() {
            this.track(Store.sync.onChanged((changes) => {
                if (changes[C.STORAGE_SYNC.AUTOJOBS_SETTINGS]) {
                    settings = changes[C.STORAGE_SYNC.AUTOJOBS_SETTINGS].newValue || settings;
                    this.handleEnabledChange();
                }
                if (changes[C.STORAGE_SYNC.SERVER_PRIORITIES] && changes[C.STORAGE_SYNC.SERVER_PRIORITIES].newValue) {
                    serverPriorities = changes[C.STORAGE_SYNC.SERVER_PRIORITIES].newValue;
                }
            }));

            // Market arrivals → maybe scan / resume. One handler per channel —
            // any of them can carry a TAKEN job that needs resuming. Also
            // the trigger for auto-clearing rejectedJobs whose targets are
            // no longer in any visible market list.
            const onMarketArrival = async () => {
                if (!settings.enabled) return;
                // Phase 3: drop rejectedJobs entries whose jobIds aren't
                // visible anywhere — cor3.gg either let someone else take
                // the job, or its lifetime ran out. Either way, the reject
                // is no longer informative.
                // Single fetch of all three market storage entries serves
                // both rejected-job cleanup and FAILED-job auto-dismiss.
                try {
                    const bundle = await Store.local.get([
                        C.STORAGE_LOCAL.MARKET, C.STORAGE_LOCAL.DARK_MARKET, C.STORAGE_LOCAL.SRM_MARKET,
                    ]);
                    const arr = [
                        bundle[C.STORAGE_LOCAL.MARKET],
                        bundle[C.STORAGE_LOCAL.DARK_MARKET],
                        bundle[C.STORAGE_LOCAL.SRM_MARKET],
                    ];
                    if (Object.keys(rejectedJobs).length > 0) clearRejectedFromMarkets(arr);
                    dismissFailedFromMarkets(arr);
                } catch (_) { /* best-effort cleanup */ }
                setTimeout(() => tryResumeInProgress(), 500);
                if (state.status === 'idle') setTimeout(tick, 2000);
            };
            this.track(Bus.window.on(C.MSG.WS.MARKET,      onMarketArrival));
            this.track(Bus.window.on(C.MSG.WS.DARK_MARKET, onMarketArrival));
            this.track(Bus.window.on(C.MSG.WS.SRM_MARKET,  onMarketArrival));

            // WS_JOB_ACCEPTED handler
            this.track(Bus.window.on(C.MSG.WS.JOB_ACCEPTED, (env) => this.onJobAccepted(env)));
            this.track(Bus.window.on('COR3_ACCEPT_JOB_SEND_FAILED', (env) => this.onAcceptSendFailed(env)));
            this.track(Bus.window.on(C.MSG.WS.JOB_COMPLETED, (env) => this.onJobCompleted(env)));
            // Phase 3: MINIGAME_RESULT is the single envelope flows post.
            // Legacy MINIGAME_DONE / MINIGAME_TIMEOUT listeners are gone.
            this.track(Bus.window.on(C.MSG.JOB.MINIGAME_RESULT, (env) => this.onMinigameResult(env)));
            this.track(Bus.window.on(C.MSG.JOB.KD_DETECTED, (env) => this.onKdDetected(env)));
            this.track(Bus.window.on(C.MSG.JOB.SERVER_UNREACHABLE, (env) => this.onServerUnreachable(env)));
            this.track(Bus.window.on(C.MSG.GAME.NM_SERVERS, (env) => this.onNmServers(env)));
            this.track(Bus.window.on(C.MSG.GAME.NM_GRAPH,   (env) => this.onNmGraph(env)));
            this.track(Bus.window.on('COR3_JOB_MANAGER_READY', () => this.onJobManagerReady()));
            this.track(Bus.window.on(C.MSG.JOB.LOG, (env) => pushUserLog(env.msg, env.level || 'info')));

            // Popup-driven runtime actions
            this.track(Bus.runtime.on('toggleAutoJobs', async (payload) => {
                if (payload && payload.settings) {
                    settings = payload.settings;
                    await Store.sync.setOne(C.STORAGE_SYNC.AUTOJOBS_SETTINGS, settings);
                }
                this.handleEnabledChange();
                return { success: true };
            }));
            this.track(Bus.runtime.on('rescanNetworkMap', () => {
                // Prefer the WS data path: no UI side-effects (doesn't open NM
                // panel for the user, doesn't hijack focus). The legacy DOM
                // scrape (REQUEST_NM_SERVERS) still works as a fallback for
                // older builds, but we don't trigger it from the popup anymore.
                Bus.window.post(C.MSG.GAME.REQUEST_NM_MAP, null);
                return { success: true };
            }));
            // The legacy "Clear Failed" button in the popup was wired to
            // 'clearBuggedJobs'. Phase 3 keeps the same runtime channel name
            // (so the existing UI keeps working pre-Phase-4 redesign) but
            // routes it to the new rejectedJobs map. Phase 4 will rename
            // the channel to 'clearRejectedJobs' alongside the UI overhaul.
            this.track(Bus.runtime.on('clearBuggedJobs', () => {
                rejectedJobs = {}; saveRejected();
                return { success: true };
            }));
            // Phase 4/5: hard reset from the popup. Clears the queue, kills
            // the current flow, drops back to idle. If we were HALTED (3×
            // recovery counter exceeded → tick loop stopped), the reset
            // also restarts the tick interval so the user doesn't have to
            // toggle the module off-and-on to get going again.
            this.track(Bus.runtime.on('autoJobsReset', () => {
                Bus.window.post(C.MSG.JOB.ABORT, null);
                queue = [];
                bulkPendingJobs = []; bulkSentOrder = [];
                bulkAcceptCount = 0; bulkAcceptTotal = 0; bulkAcceptStartedAt = 0;
                solvingStartedAt = 0; completingStartedAt = 0;
                recoveryCounter = 0;
                saveQueue();
                state.haltReason = null;
                const wasHalted = (state.status === 'halted');
                resetState('user-reset');
                if (wasHalted && settings.enabled && !monitorIntervalId) {
                    // Re-arm the tick loop. Don't run the full bootSequence
                    // again — the user is asking for an immediate retry,
                    // not a fresh boot.
                    monitorIntervalId = setInterval(tick, TICK_INTERVAL_MS);
                    this.info('reset from HALTED — tick loop restarted');
                }
                this.warn('user-triggered reset — queue cleared, state forced to idle');
                return { success: true };
            }));
            // Optional: clear a single rejected entry. Phase 4 UI will use this.
            this.track(Bus.runtime.on('clearRejectedJob', (payload) => {
                const id = payload && payload.jobId;
                if (id && rejectedJobs[id]) {
                    delete rejectedJobs[id];
                    saveRejected();
                    return { success: true };
                }
                return { success: false };
            }));
            this.track(Bus.runtime.on('getAutoJobsState', () => ({ state })));

            this.handleEnabledChange();
            this.info('auto-jobs ready');
        }

        async stop() {
            if (monitorIntervalId) { clearInterval(monitorIntervalId); monitorIntervalId = null; }
            Bus.window.post(C.MSG.JOB.ABORT, null);
            Bus.window.post(C.MSG.JOB.AUTOJOBS_ACTIVE_CHANGED, { active: false });
        }

        handleEnabledChange() {
            // Edge-detect: this gets called multiple times for the same toggle
            // event (popup writes chrome.storage.sync AND posts a runtime
            // toggleAutoJobs message — both reach us via separate listeners),
            // and re-firing the side effects would double the market-refresh
            // call, race the network-map open, etc. Only act on actual
            // false → true / true → false transitions.
            if (settings.enabled === lastEnabledApplied) return;
            lastEnabledApplied = settings.enabled;

            if (settings.enabled) {
                // Phase 5: full boot pipeline — STARTING preroll →
                // DRAWING_LOCAL_MAP (if no graph yet) → DLM_CHECK_SERVERS_
                // ACCESSABILITY → idle. The tick interval is started
                // *inside* bootSequence after the pre-flight finishes.
                bootSequence().catch((err) => {
                    if (modRef) modRef.error('boot sequence crashed', { error: String(err && err.message || err) });
                });
            } else {
                if (monitorIntervalId) { clearInterval(monitorIntervalId); monitorIntervalId = null; }
                bootGen++;            // invalidate any in-flight bootSequence
                recoveryCounter = 0;  // counter is per-session — drop on disable
                queue = []; bulkPendingJobs = []; bulkSentOrder = []; bulkAcceptCount = 0; bulkAcceptTotal = 0;
                bulkAcceptStartedAt = 0;
                saveQueue();
                Bus.window.post(C.MSG.JOB.ABORT, null);
                Bus.window.post(C.MSG.JOB.AUTOJOBS_ACTIVE_CHANGED, { active: false });
                state.haltReason = null;
                resetState('disabled');
            }
        }

        // ─── Bus event handlers ────────────────────────────────────────
        async onJobAccepted(env) {
            if (state.status !== 'accepting') {
                this.warn(`WS_JOB_ACCEPTED ignored — state ${state.status}`);
                return;
            }
            bulkAcceptCount++;
            const sentJob = bulkSentOrder.shift() || null;
            const recentJobs = (env.data && env.data.recentJobs) || [];
            if (env.error) {
                const errMsg = typeof env.error === 'string' ? env.error : (env.error.message || JSON.stringify(env.error));
                this.error(`accept error for "${sentJob?.name || sentJob?.id || '?'}": ${errMsg}`);
                pushUserLog(`Accept: error for "${sentJob?.name || sentJob?.id || '?'}" — ${errMsg}`, 'error');
            } else if (sentJob && sentJob.apiJob) {
                if (queue.find((q) => q.jobId === sentJob.id)) {
                    this.debug(`already in queue: ${sentJob.id}`);
                } else {
                    const taken = recentJobs.find((r) => r.status === 'TAKEN' && r.id === sentJob.id);
                    const source = taken || sentJob.apiJob;
                    const r = resolveJobParams(sentJob.type, source);
                    if (!r.ok) {
                        pushUserLog(`Accept: "${sentJob.name || sentJob.id}" awaiting full conditions from server`, 'warn');
                    } else {
                        queue.push({
                            jobId: sentJob.id, marketId: sentJob.marketId, jobType: sentJob.type,
                            jobName: sentJob.name || sentJob.id,
                            serverName: r.params.serverName || null,
                            fileCondition: r.params.fileCondition || null,
                            fileNames: r.params.fileNames || null,
                            ips: r.params.ips || null,
                            logSeqs: r.params.logSeqs || null,
                        });
                        pushUserLog(`Accept: queued "${sentJob.name || sentJob.id}" [${sentJob.type}]`, 'ok');
                    }
                }
            }
            if (bulkAcceptCount >= bulkAcceptTotal) {
                saveQueue();
                bulkPendingJobs = []; bulkSentOrder = []; bulkAcceptCount = 0; bulkAcceptTotal = 0; bulkAcceptStartedAt = 0;
                pushUserLog(`Accept done — queue: ${queue.length} job(s)`, 'ok');
                // After a remote-market accept (DARK/SRM) the endpoint is
                // left on that market's server; revert to HOME so subsequent
                // server-connect calls (most flows target HOME-network
                // servers) don't hit the wrong endpoint.
                Bus.window.post(C.MSG.GAME.REVERT_ENDPOINT_TO_HOME, null);
                resetRecoveryCounter();   // accept-batch success — reset rolling failure count
                resetState('accept-batch-complete');
                // Home-only refresh here. Remote markets (DARK/SRM) each do
                // a set.endpoint→get.jobs→revert dance that takes ~2.6 s,
                // and the first flow's connect() runs ~3 s later — close
                // enough to overlap and get rejected by cor3.gg. Remote
                // markets refresh on idle-poll (every 30 s) and at toggle-on,
                // so skipping them here only delays a remote refresh by at
                // most one poll cycle. 2026-05-10 race fix.
                setTimeout(() => requestMarketRefresh('accept-batch-done', { skipRemote: true }), 500);
                // Phase 5+: 3s instead of 1s gives the REVERT_ENDPOINT_TO_HOME
                // post above time to actually flip the WS endpoint before
                // we kick off the first flow. Was the root cause of the
                // first-job-of-a-cycle failing connect() when the last
                // accept landed on DARK/SRM.
                setTimeout(executeNextFromQueue, POST_ACCEPT_BATCH_DELAY_MS);
            }
        }

        onAcceptSendFailed(env) {
            if (state.status !== 'accepting') return;
            const failedId = env.jobId;
            const orderIdx = bulkSentOrder.findIndex((p) => p.id === failedId);
            if (orderIdx !== -1) bulkSentOrder.splice(orderIdx, 1);
            sentAcceptIds.delete(failedId);
            if (bulkAcceptTotal > 0) bulkAcceptTotal--;
            this.warn(`accept SEND_FAILED ${failedId}`);
            if (bulkAcceptCount >= bulkAcceptTotal) {
                saveQueue();
                bulkPendingJobs = []; bulkSentOrder = []; bulkAcceptCount = 0; bulkAcceptTotal = 0; bulkAcceptStartedAt = 0;
                Bus.window.post(C.MSG.GAME.REVERT_ENDPOINT_TO_HOME, null);
                resetState('accept-batch-complete');
                // skipRemote=true here for the same race reason as the
                // success path above — remote refreshes overlap connect().
                setTimeout(() => requestMarketRefresh('accept-batch-done', { skipRemote: true }), 500);
                // Phase 5+: 3s settle delay (see acceptCandidatesBatch closure
                // above) — same reasoning, post-revert WS endpoint flip needs
                // to land before the first flow's connect() runs.
                setTimeout(executeNextFromQueue, POST_ACCEPT_BATCH_DELAY_MS);
            }
        }

        onJobCompleted(env) {
            if (state.status !== 'completing') return;
            const completedJobId = state.jobId;
            const descriptor = state.jobName || state.jobType || 'Unknown';
            // Debug (May 2026): dump the full server response so we can see
            // whether the server hints at *which* IPs are missing on
            // IP-Injection bugged jobs. Cheap, only fires per completion.
            try {
                pushUserLog(
                    'Complete WS response: ' + JSON.stringify({ data: env.data, error: env.error }),
                    'debug'
                );
            } catch (_) { /* JSON cycles unlikely on a WS frame, but be safe */ }
            if (env.error) {
                const errMsg = typeof env.error === 'string' ? env.error : (env.error?.message || JSON.stringify(env.error));
                pushUserLog('Complete failed: ' + errMsg, 'error');
                if (completedJobId) {
                    // Server rejected our complete. Route through retry-once.
                    // The first failure is often transient (logSeqs reshuffled,
                    // server tally lag); the second confirms a real problem.
                    const decision = retryOrReject(completedJobId, descriptor, `complete-rejected: ${errMsg}`,
                                                   { delayMs: FLOW_RETRY_DELAY_MS });
                    completingStartedAt = 0;
                    if (decision.retried) {
                        setStatus('idle', 'complete-rejected -> retry');
                        setTimeout(executeNextFromQueue, decision.delayMs);
                    } else {
                        // Permanent reject after retry-once — orchestration-level
                        // failure, contributes to the recovery counter.
                        enterRecovering(`complete-rejected-permanent: ${errMsg}`);
                    }
                    return;
                }
            } else {
                pushUserLog('Job completed!', 'ok');
            }
            if (completedJobId) {
                completedJobIds.set(completedJobId, Date.now());
                recordCompletedJob({
                    jobId: completedJobId,
                    completedAt: Date.now(),
                    descriptor: state.jobName || null,
                    jobType: state.jobType || null,
                    serverName: state.serverName || null,
                    marketId: state.marketId || null,
                });
            }
            const qi = queue.findIndex((j) => j.jobId === completedJobId);
            if (qi !== -1) { queue.splice(qi, 1); saveQueue(); }
            completingStartedAt = 0;
            // A clean completion resets the rolling failure counter.
            resetRecoveryCounter();
            // Phase 5: when the queue empties after a successful completion,
            // sit in ALL_JOBS_DONE for a few seconds so the user sees the
            // success state in the UI pill before we drop back to idle.
            if (queue.length === 0) {
                enterAllJobsDone('cycle complete');
            } else {
                setStatus('idle', 'job complete');
            }
            // Phase 5+: refresh ONLY home market here. Remote (DARK/SRM)
            // refreshes do a set.endpoint preflight that races the next
            // SAI job's connect() and gets the login rejected by cor3.gg.
            // Remote markets get fresh data via the regular idle-poll
            // (every 30s) and accept-batch-done — neither overlaps with
            // an active flow.
            setTimeout(() => requestMarketRefresh('job-completed', { skipRemote: true }), 2000);
            if (queue.length > 0) setTimeout(executeNextFromQueue, 3000);
        }

        // Phase 3: single entry-point for all flow results. Replaces the
        // legacy onMinigameDone / onMinigameTimeout pair. Branches:
        //   { success:true, didWork:true  } → flow did the work, we send COMPLETE_JOB.
        //   { success:true, didWork:false } → STRUCTURAL reject. UI shows the
        //                                     reason; queue moves on; no COMPLETE.
        //                                     Auto-cleared when markets confirm
        //                                     the job is gone.
        //   { success:false }               → RUNTIME failure. Retry once after
        //                                     FLOW_RETRY_DELAY_MS; second failure
        //                                     becomes a permanent reject.
        async onMinigameResult(env) {
            if (!env || !env.jobId || env.jobId !== state.jobId) return;
            const jobId = env.jobId;
            const descriptor = state.jobName || state.jobType || 'Unknown';
            const reason = env.reason || (env.success ? 'no-work' : 'flow-fail');

            // Cap learning: a flow told us a server has no Logs section.
            // Persist for the planner so the same job-server pair gets
            // refused before dispatch next cycle. Done outside the branches
            // because the cap is useful regardless of how the flow signals.
            if (env.reason === 'no-logs-section' && state.serverName) {
                try {
                    const caps = (await Store.local.getOne(C.STORAGE_LOCAL.AJ_SERVER_CAPS, {})) || {};
                    const prev = caps[state.serverName] || {};
                    if (prev.hasLogs !== false) {
                        caps[state.serverName] = { ...prev, hasLogs: false, learnedAt: Date.now() };
                        await Store.local.setOne(C.STORAGE_LOCAL.AJ_SERVER_CAPS, caps);
                        this.info(`server-cap learned: "${state.serverName}" has no Logs section`);
                    }
                } catch (err) {
                    this.warn('failed to persist server cap', { error: String(err && err.message || err) });
                }
            }

            // Branch 1: full success → completion.
            if (env.success === true && env.didWork === true) {
                if (state.status !== 'solving') return;
                pushUserLog('Task solved — sending complete', 'ok');
                state.status = 'completing';
                solvingStartedAt = 0;
                completingStartedAt = Date.now();
                saveState();
                emitTransition('completing', descriptor);
                setTimeout(() => Bus.window.post('COR3_COMPLETE_JOB', { jobId: state.jobId, marketId: state.marketId }),
                    2000 + Math.floor(Math.random() * 1000));
                return;
            }

            // Branch 2: structural reject → no completion, permanent skip.
            if (env.success === true && env.didWork === false) {
                pushUserLog(`Permanently skipped: "${descriptor}" — ${reason}`, 'warn');
                rejectJob(jobId, descriptor, reason);
                solvingStartedAt = 0;
                resetState('flow-no-work');
                if (queue.length > 0) setTimeout(executeNextFromQueue, 3000);
                return;
            }

            // Branch 3: runtime failure → retry-once-then-permanent-reject.
            // (A missing/false `success` field also lands here.)
            const decision = retryOrReject(jobId, descriptor, reason, { delayMs: FLOW_RETRY_DELAY_MS });
            Bus.window.post(C.MSG.JOB.ABORT, null);
            solvingStartedAt = 0;
            if (decision.retried) {
                // First attempt — short pause, requeue, no recovery bump.
                setStatus('idle', 'flow runtime-fail -> retry');
                setTimeout(executeNextFromQueue, decision.delayMs);
            } else {
                // Second attempt failed — orchestration-level event.
                enterRecovering(`flow-failed-permanent: ${reason}`);
            }
        }

        onKdDetected(env) {
            const { serverName, timerText } = env;
            if (!serverName) return;
            const expiry = Date.now() + parseKDTimerMs(timerText);
            kdSkipServers.set(serverName, expiry);
            pushUserLog(`Server "${serverName}" K/D (${timerText || '~6h'}) — skipped`, 'warn');
        }

        onServerUnreachable(env) {
            const { serverName, blockedByKD } = env;
            if (!serverName) return;

            // Path-blocking K/D servers come back from network-map with a
            // confirmed timer text — those legitimately can't be reached
            // until the timer expires, so block the *transit* server (not
            // the destination) for the timer duration.
            const hasKdCause = Array.isArray(blockedByKD) && blockedByKD.length > 0;
            if (hasKdCause) {
                for (const { serverName: kdName, timerText } of blockedByKD) {
                    const kdMs = parseKDTimerMs(timerText);
                    kdSkipServers.set(kdName, Date.now() + kdMs);
                    pushUserLog(`K/D "${kdName}" (${timerText || '?'}) blocking path to "${serverName}"`, 'warn');
                }
            }

            if (state.status !== 'solving' || !state.jobId) {
                pushUserLog(`Server "${serverName}" unreachable`, 'warn');
                return;
            }

            // Phase 3: branch on cause.
            //   K/D-caused: drop the job from queue (it'll come back via
            //   markets refresh once the K/D blacklist on the path expires).
            //   No permanent reject — the user shouldn't lose the job for
            //   a temporary downtime.
            //
            //   No identifiable K/D cause: route through retry-once. The
            //   first try might be a transient WS/endpoint hiccup; the
            //   second confirms the path is genuinely broken and we
            //   surface a permanent reject so the queue moves on.
            if (hasKdCause) {
                const qi = queue.findIndex((j) => j.jobId === state.jobId);
                if (qi !== -1) { queue.splice(qi, 1); saveQueue(); }
                pushUserLog(`Server "${serverName}" unreachable via K/D — dropping job, will retry after K/D clears`, 'warn');
                Bus.window.post(MSG.JOB.ABORT, null);
                solvingStartedAt = 0;
                resetState('server-unreachable-kd');
                if (queue.length > 0) setTimeout(executeNextFromQueue, 3000);
                return;
            }

            const decision = retryOrReject(state.jobId, state.jobName || state.jobType || 'Unknown',
                                           `server "${serverName}" unreachable`);
            Bus.window.post(MSG.JOB.ABORT, null);
            solvingStartedAt = 0;
            if (decision.retried) {
                setStatus('idle', 'server-unreachable -> retry');
                setTimeout(executeNextFromQueue, decision.delayMs);
            } else {
                enterRecovering(`server-unreachable-permanent "${serverName}"`);
            }
        }

        async onNmServers(env) {
            if (!Array.isArray(env.servers)) return;
            const prev = (await Store.local.getOne(C.STORAGE_LOCAL.NM_SERVERS, [])) || [];
            const merged = [...new Set([...prev, ...env.servers])].sort();
            const changed = merged.length !== prev.length || merged.some((s, i) => s !== prev[i]);
            if (changed) {
                await Store.local.setOne(C.STORAGE_LOCAL.NM_SERVERS, merged);
                this.debug(`nm servers updated: ${merged.length}`);
            }
        }

        // Canonical topology arriving from WS network-map.get.map.
        // Replaces nmDepths in memory + persists the full graph to storage
        // so the popup can render depth badges without re-querying. Also
        // mirrors server names into NM_SERVERS for legacy callers (timer
        // labels, places that still expect a flat name array).
        async onNmGraph(env) {
            if (!env || !Array.isArray(env.servers)) return;
            nmDepths.clear();
            for (const s of env.servers) {
                if (s.name && Number.isFinite(s.depth)) nmDepths.set(s.name, s.depth);
            }
            await Store.local.set({
                [C.STORAGE_LOCAL.NM_GRAPH]: env,
                [C.STORAGE_LOCAL.NM_SERVERS]: env.servers
                    .map((s) => s.name)
                    .filter((n) => n && n !== env.home)  // exclude HOME from the targetable list
                    .sort(),
            });
            this.debug(`nm graph updated: ${env.servers.length} servers, max depth ${Math.max(0, ...env.servers.map((s) => s.depth || 0))}`);

            // Phase 2 log-only reachability: refresh the per-market snapshot
            // every time the graph changes. Planner consumes this on next
            // candidates pass; the local Network Map UI (Phase 4) will
            // render off the same snapshot.
            try {
                const r = root.COR3.autoJobs && root.COR3.autoJobs.reachability;
                if (r && typeof r.computeAndPersist === 'function') {
                    const snap = await r.computeAndPersist();
                    if (snap && snap.markets) {
                        const summary = Object.entries(snap.markets)
                            .map(([k, m]) => `${k}=${m.reachable ? 'ok' : (m.reason || ('blocked:' + (m.blockers || []).map((b) => b.serverName).join('+')))}`)
                            .join(' ');
                        this.info(`reachability (log-only): ${summary}`);
                    }
                }
            } catch (err) {
                this.warn('reachability snapshot failed', { error: String(err && err.message || err) });
            }
        }

        onJobManagerReady() {
            jobManagerReady = true;
            this.info('job-manager ready');
            // Clean up legacy Debug-mode confirm slots if any older build wrote them
            Store.local.remove(['autoJobsPendingConfirm', 'autoJobsConfirmResult']);
            if (state.status === 'idle' && queue.length > 0) setTimeout(executeNextFromQueue, 1000);
            if (state.status === 'solving' && state.jobId) {
                setTimeout(() => {
                    if (!dispatchSolveFlow(state)) resetState();
                }, 1000);
            }
            if (state.status === 'completing' && state.jobId) {
                setTimeout(() => Bus.window.post('COR3_COMPLETE_JOB', { jobId: state.jobId, marketId: state.marketId }), 1000);
            }
        }
    }

    Registry.register(new AutoJobsModule());
})();
