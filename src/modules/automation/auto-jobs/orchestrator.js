// src/modules/automation/auto-jobs/orchestrator.js
// Auto-jobs state machine orchestrator.
//
// Phase 1: this file owns the **canonical** STATES enum and STATE_LABELS
// metadata (title, description, what-state-comes-next). Both are consumed
// by the UI section right now (Phase 4 will wire them in fully) and by the
// orchestrator core when it lands in Phase 2/3. Keeping the constants here
// — instead of duplicating them in src/ui/sections/auto-jobs.js — gives a
// single source of truth.
//
// Phase 1 also provides `mapLegacyToCanonical(legacyStatus)` so the existing
// 4-state runtime in auto-jobs.js (idle/accepting/solving/completing) can
// be projected onto the canonical state names without behaviour change.
// This is what lets the UI render "DLM_CHECK_SERVERS_ACCESSABILITY" etc.
// even before the orchestrator core is wired.
//
// Phase 2 will introduce `enterState(name, ctx)`, transition table, watch-
// dogs per state, and a runtime that consumes planner/reachability/executor.
//
// API (current — Phase 1):
//   STATES                     — frozen enum, name → name (string).
//   STATE_LABELS               — { [name]: { title, description, nextHint? } }
//   ORDER                      — visual ordering for timeline rendering
//   mapLegacyToCanonical(s)    — 'idle'|'accepting'|'solving'|'completing'
//                                 → canonical state name
//   recordTransition(from, to, reason?) — appends to in-memory ring buffer
//                                          and posts MSG.JOB.STATE_TRANSITIONED
//   getHistory()               — last STATE_HISTORY_RING transitions
//
// API (planned — Phase 2/3):
//   start() / stop()
//   enterState(name, ctx)
//   getState() / getNext()
//   onResult(env)              — handles MINIGAME_RESULT (success/didWork/reason)

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    if (!root.COR3 || !root.COR3.constants) return;
    const { Bus, Store, constants: C } = root.COR3;
    const MSG = C.MSG;
    const SL = C.STORAGE_LOCAL;

    // ─── State catalogue ──────────────────────────────────────────────────
    // Strings are stable: they appear in storage, in logs, in the UI, and
    // in the debug-bundle export. Don't rename without a migration plan.
    const STATES = Object.freeze({
        // Boot / idle-side
        IDLE:                              'idle',
        STARTING:                          'starting',
        DRAWING_LOCAL_MAP:                 'drawing_local_map',
        DLM_CHECK_SERVERS_ACCESSABILITY:   'dlm_check_servers_accessability',
        DLM_FIX_SERVERS_ACCESABILITY:      'dlm_fix_servers_accesability',
        WAITING_JOBS:                      'waiting_jobs',
        TIMER_EXPIRED_TIME_TO_UPD:         'timer_expired_time_to_upd',
        CHECK_JOB_CONDITIONS:              'check_job_conditions',
        TAKE_ALL_VALID_JOBS:               'take_all_valid_jobs',
        OPEN_SAI:                          'open_sai',

        // One state per flow type. Names mirror FLOW_* constants so a job's
        // jobType maps trivially onto its state.
        FLOW_FILE_DECRYPTION:              'flow_file_decryption',
        FLOW_IP_INJECTION:                 'flow_ip_injection',
        FLOW_IP_CLEANUP:                   'flow_ip_cleanup',
        FLOW_FILE_UPLOAD:                  'flow_file_upload',
        FLOW_LOG_DELETION:                 'flow_log_deletion',
        FLOW_LOG_DOWNLOAD:                 'flow_log_download',
        FLOW_FILE_ELIMINATION:             'flow_file_elimination',
        FLOW_DATA_DOWNLOAD:                'flow_data_download',
        FLOW_DECRYPT_EXTRACT:              'flow_decrypt_extract',

        COMPLETING_JOB:                    'completing_job',
        ALL_JOBS_DONE:                     'all_jobs_done',
        RECOVERING:                        'recovering',
        PAUSED:                            'paused',
        HALTED:                            'halted',
    });

    // Maps `job.jobType` (snake_case identifiers used in FLOW_DISPATCH) to
    // the matching FLOW_<NAME> state. Phase 2/3 uses this in OPEN_SAI to
    // pick the next state. Kept here so flows / executor can stay decoupled.
    const FLOW_STATE_BY_TYPE = Object.freeze({
        file_decryption:  STATES.FLOW_FILE_DECRYPTION,
        ip_injection:     STATES.FLOW_IP_INJECTION,
        ip_cleanup:       STATES.FLOW_IP_CLEANUP,
        data_upload:      STATES.FLOW_FILE_UPLOAD,
        log_deletion:     STATES.FLOW_LOG_DELETION,
        log_download:     STATES.FLOW_LOG_DOWNLOAD,
        file_elimination: STATES.FLOW_FILE_ELIMINATION,
        data_download:    STATES.FLOW_DATA_DOWNLOAD,
        decrypt_extract:  STATES.FLOW_DECRYPT_EXTRACT,
    });

    // ─── Labels (UI copy) ─────────────────────────────────────────────────
    // `title` is short enough for the state pill (≤24 chars). `description`
    // is one sentence shown under the pill. `nextHint` is the most common
    // next-state name if the flow goes well — used to render the "→ next:"
    // hint in the UI without the orchestrator having to publish it every
    // time. The actual transition table in Phase 2 may diverge per context;
    // when it does the orchestrator can override nextHint via the
    // STATE_TRANSITIONED envelope.
    const STATE_LABELS = Object.freeze({
        [STATES.IDLE]: {
            title: 'Idle',
            description: 'Auto-jobs is off.',
            nextHint: STATES.STARTING,
        },
        [STATES.STARTING]: {
            title: 'Starting',
            description: '10-second pre-roll. Verifying solvers and runtime flags.',
            nextHint: STATES.DRAWING_LOCAL_MAP,
        },
        [STATES.DRAWING_LOCAL_MAP]: {
            title: 'Drawing local map',
            description: 'Rendering a copy of the Network Map inside the popup.',
            nextHint: STATES.DLM_CHECK_SERVERS_ACCESSABILITY,
        },
        [STATES.DLM_CHECK_SERVERS_ACCESSABILITY]: {
            title: 'Checking access',
            description: 'Walking each enabled market path: K/D, hack-tool gates, transit nodes.',
            nextHint: STATES.WAITING_JOBS,
        },
        [STATES.DLM_FIX_SERVERS_ACCESABILITY]: {
            title: 'Fixing access',
            description: 'Activating hack tools on transit nodes that block reachability.',
            nextHint: STATES.DLM_CHECK_SERVERS_ACCESSABILITY,
        },
        [STATES.WAITING_JOBS]: {
            title: 'Waiting for jobs',
            description: 'Listening for market timer events; idling until refresh tick.',
            nextHint: STATES.TIMER_EXPIRED_TIME_TO_UPD,
        },
        [STATES.TIMER_EXPIRED_TIME_TO_UPD]: {
            title: 'Refreshing markets',
            description: 'Market timer expired. Pulling fresh job lists.',
            nextHint: STATES.CHECK_JOB_CONDITIONS,
        },
        [STATES.CHECK_JOB_CONDITIONS]: {
            title: 'Checking conditions',
            description: 'Per-job verdict: server reachable, hack-tool present, section exists.',
            nextHint: STATES.TAKE_ALL_VALID_JOBS,
        },
        [STATES.TAKE_ALL_VALID_JOBS]: {
            title: 'Accepting jobs',
            description: 'Sending accept requests for jobs that passed the planner.',
            nextHint: STATES.OPEN_SAI,
        },
        [STATES.OPEN_SAI]: {
            title: 'Opening SAI',
            description: 'Opening the target server\'s SAI window for the next job.',
            nextHint: null, // depends on jobType — orchestrator overrides via envelope
        },
        [STATES.FLOW_FILE_DECRYPTION]:  { title: 'File Decryption',  description: 'Decrypting a config file in Downloads.', nextHint: STATES.COMPLETING_JOB },
        [STATES.FLOW_IP_INJECTION]:     { title: 'IP Injection',     description: 'Injecting IPs into the server\'s Transit list.', nextHint: STATES.COMPLETING_JOB },
        [STATES.FLOW_IP_CLEANUP]:       { title: 'IP Cleanup',       description: 'Removing IPs from the server\'s Transit list.', nextHint: STATES.COMPLETING_JOB },
        [STATES.FLOW_FILE_UPLOAD]:      { title: 'File Upload',      description: 'Uploading a file from Downloads to the server.', nextHint: STATES.COMPLETING_JOB },
        [STATES.FLOW_LOG_DELETION]:     { title: 'Log Deletion',     description: 'Deleting log entries from the server\'s Logs section.', nextHint: STATES.COMPLETING_JOB },
        [STATES.FLOW_LOG_DOWNLOAD]:     { title: 'Log Download',     description: 'Downloading log entries from the server\'s Logs section.', nextHint: STATES.COMPLETING_JOB },
        [STATES.FLOW_FILE_ELIMINATION]: { title: 'File Elimination', description: 'Deleting files from the server.', nextHint: STATES.COMPLETING_JOB },
        [STATES.FLOW_DATA_DOWNLOAD]:    { title: 'Data Download',    description: 'Downloading files from the server.', nextHint: STATES.COMPLETING_JOB },
        [STATES.FLOW_DECRYPT_EXTRACT]:  { title: 'Decrypt & Extract', description: 'Downloading + decrypting + extracting a file.', nextHint: STATES.COMPLETING_JOB },
        [STATES.COMPLETING_JOB]: {
            title: 'Completing',
            description: 'Sending the job-completion message and waiting for server confirmation.',
            nextHint: STATES.OPEN_SAI,
        },
        [STATES.ALL_JOBS_DONE]: {
            title: 'All jobs done',
            description: 'Cycle finished. Returning to wait for the next market refresh.',
            nextHint: STATES.WAITING_JOBS,
        },
        [STATES.RECOVERING]: {
            title: 'Recovering',
            description: 'Diagnosing a runtime fault and deciding whether to retry, skip, or escalate.',
            nextHint: null,
        },
        [STATES.PAUSED]: {
            title: 'Paused',
            description: 'User toggled auto-jobs off mid-flow. Letting the current step finish before halting.',
            nextHint: STATES.HALTED,
        },
        [STATES.HALTED]: {
            title: 'Halted',
            description: 'Hard stop. See the recovery banner for the reason. Use Reset to clear.',
            nextHint: null,
        },
    });

    // Visual ordering for the state-history timeline. Not a transition
    // graph — just the order states should appear in if you needed to
    // tile them all on screen.
    const ORDER = Object.freeze([
        STATES.IDLE,
        STATES.STARTING,
        STATES.DRAWING_LOCAL_MAP,
        STATES.DLM_CHECK_SERVERS_ACCESSABILITY,
        STATES.DLM_FIX_SERVERS_ACCESABILITY,
        STATES.WAITING_JOBS,
        STATES.TIMER_EXPIRED_TIME_TO_UPD,
        STATES.CHECK_JOB_CONDITIONS,
        STATES.TAKE_ALL_VALID_JOBS,
        STATES.OPEN_SAI,
        STATES.FLOW_FILE_DECRYPTION,
        STATES.FLOW_IP_INJECTION,
        STATES.FLOW_IP_CLEANUP,
        STATES.FLOW_FILE_UPLOAD,
        STATES.FLOW_LOG_DELETION,
        STATES.FLOW_LOG_DOWNLOAD,
        STATES.FLOW_FILE_ELIMINATION,
        STATES.FLOW_DATA_DOWNLOAD,
        STATES.FLOW_DECRYPT_EXTRACT,
        STATES.COMPLETING_JOB,
        STATES.ALL_JOBS_DONE,
        STATES.RECOVERING,
        STATES.PAUSED,
        STATES.HALTED,
    ]);

    // ─── Legacy bridge ────────────────────────────────────────────────────
    // Phase 1: project the existing 4-state runtime onto canonical names so
    // the UI can render them. Once Phase 2 lands, the legacy values stop
    // being written and this function only matters for state read from
    // older storage during the upgrade.
    function mapLegacyToCanonical(legacy, ctx) {
        switch (legacy) {
            case 'idle':       return STATES.IDLE;
            case 'accepting':  return STATES.TAKE_ALL_VALID_JOBS;
            case 'solving': {
                // If the caller passes the current jobType (ctx.jobType),
                // resolve to the specific FLOW_* state — that's the only
                // place we know which flow is actually running. Falls back
                // to OPEN_SAI for jobs whose type doesn't map (e.g. legacy
                // entries) or when no ctx is supplied.
                const jt = ctx && ctx.jobType;
                if (jt && FLOW_STATE_BY_TYPE[jt]) return FLOW_STATE_BY_TYPE[jt];
                return STATES.OPEN_SAI;
            }
            case 'completing': return STATES.COMPLETING_JOB;
            default:
                // Phase 5: orchestrator now writes canonical state names directly
                // (starting, drawing_local_map, recovering, halted, all_jobs_done,
                // paused). Identity-map them so the UI pill renders correctly.
                if (typeof legacy === 'string') {
                    for (const v of Object.values(STATES)) {
                        if (v === legacy) return legacy;
                    }
                }
                return null;
        }
    }

    // ─── Transition history (UI timeline) ─────────────────────────────────
    // Phase 4: also persists to STORAGE_LOCAL.AJ_STATE_HISTORY so the popup
    // (a separate context) can render the timeline without subscribing to
    // window-level Bus traffic. The in-memory ring stays primary and is
    // hydrated from storage on first read so cross-reload visibility works.
    const HISTORY_LIMIT = (C.LIMITS && C.LIMITS.STATE_HISTORY_RING) || 20;
    const history = [];
    let historyHydrated = false;

    async function hydrateHistory() {
        if (historyHydrated) return;
        historyHydrated = true;
        try {
            const persisted = await Store.local.getOne(SL.AJ_STATE_HISTORY, []);
            if (Array.isArray(persisted)) {
                history.push(...persisted.slice(-HISTORY_LIMIT));
            }
        } catch (_) { /* storage may be unavailable; fine, in-memory is enough */ }
    }

    function recordTransition(from, to, reason) {
        const entry = { ts: Date.now(), from: from || null, to: to || null, reason: reason || null };
        history.push(entry);
        while (history.length > HISTORY_LIMIT) history.shift();
        // Bus emit (cheap, observers can react instantly) + storage persist
        // (slow-path, the popup uses Store.local.onChanged to refresh).
        try { Bus.window.post(MSG.JOB.STATE_TRANSITIONED, entry); } catch (_) { /* Bus may be in early init */ }
        try { Store.local.setOne(SL.AJ_STATE_HISTORY, history.slice()); } catch (_) { /* not in chrome.storage context */ }
    }

    function getHistory() {
        return history.slice();
    }

    // ─── Phase 2/3 placeholders ──────────────────────────────────────────
    function enterState(_name, _ctx) {
        // TODO(Phase 2): implement transition table + watchdog scheduling.
    }

    function getState() {
        // TODO(Phase 2): return the current canonical state. Until then,
        // the legacy-state listener in auto-jobs.js owns the runtime state.
        return null;
    }

    function getNext() {
        // TODO(Phase 2): the orchestrator can publish a real next-state
        // hint based on its transition table. Until then, callers should
        // fall back to STATE_LABELS[current].nextHint.
        return null;
    }

    root.COR3.autoJobs = root.COR3.autoJobs || {};
    root.COR3.autoJobs.states = {
        STATES,
        STATE_LABELS,
        ORDER,
        FLOW_STATE_BY_TYPE,
        mapLegacyToCanonical,
        recordTransition,
        getHistory,
        hydrateHistory,
        // Phase 2/3 surface — currently no-op stubs so callers can be
        // written once and graduate without renames.
        enterState,
        getState,
        getNext,
    };
})();
