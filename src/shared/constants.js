// Single source of truth for cross-context envelope types and storage keys.
// Loaded as a classic script in every context (MAIN, isolated, popup, SW).
// Registers into globalThis.COR3.constants.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    root.COR3 = root.COR3 || {};
    if (root.COR3.constants) return;

    // ──────────────────────────────────────────────────────────────────────
    // postMessage envelope types (window.postMessage between MAIN ↔ isolated)
    // ──────────────────────────────────────────────────────────────────────
    const MSG = {
        // Game data relayed from WS interceptor (MAIN → isolated)
        WS: {
            EXPEDITIONS: 'COR3_WS_EXPEDITIONS',
            ARCHIVED_EXPEDITIONS: 'COR3_WS_ARCHIVED_EXPEDITIONS',
            DECISIONS: 'COR3_WS_DECISIONS',
            MARKET: 'COR3_WS_MARKET',
            DARK_MARKET: 'COR3_WS_DARK_MARKET',
            DARK_MARKET_UNREACHABLE: 'COR3_WS_DARK_MARKET_UNREACHABLE',
            SRM_MARKET: 'COR3_WS_SRM_MARKET',
            SRM_MARKET_UNREACHABLE: 'COR3_WS_SRM_MARKET_UNREACHABLE',
            STASH: 'COR3_WS_STASH',
            MERCENARIES: 'COR3_WS_MERCENARIES',
            MERC_CONFIGURE: 'COR3_WS_MERC_CONFIGURE',
            EXPEDITION_CONFIG: 'COR3_WS_EXPEDITION_CONFIG',
            JOB_ACCEPTED: 'COR3_WS_JOB_ACCEPTED',
            JOB_COMPLETED: 'COR3_WS_JOB_COMPLETED',
            CONTAINER_OPENED: 'COR3_WS_CONTAINER_OPENED',
            COLLECTED_ALL: 'COR3_WS_COLLECTED_ALL',
            // Loadout: full snapshot pushed by the server in response to
            // join-room {room:"loadout"}. Payload shape:
            //   { ownedHardware:[], ownedSoftware:[], equippedHardware:{cpu,gpu,ram,psu},
            //     equippedSoftware:[], resources:{supply,demand,canBoot,softwarePower} }
            // Each software has specs:[{type:"DECRYPT|HACK|SEARCH", fileTypes?, power, remote}]
            // which is what drives the dynamic minigame file allow-list and
            // the per-job-type pre-rejection in the Auto-Jobs planner.
            LOADOUT: 'COR3_WS_LOADOUT',
            // Desktop OS-shell events. Emitted by the WS interceptor when
            // cor3.gg's server pushes desktop:get.options / open.folder /
            // open.file / update.file frames. Consumers:
            //   • file-decryption flow listens to DESKTOP_FILE so it can
            //     follow the latest fileId if the server regenerates it
            //     after job.take (encrypted file is re-issued per user).
            //   • file-decryption flow uses DESKTOP_FOLDER as the response
            //     channel for its WS open.folder call (instead of having
            //     to scrape the FolderApplication DOM).
            //   • get.options is also used to cache the Downloads folder
            //     id on window.__cor3DownloadFolderId so subsequent
            //     open.folder calls don't need to re-resolve it.
            DESKTOP_FOLDER: 'COR3_WS_DESKTOP_FOLDER',
            DESKTOP_FILE: 'COR3_WS_DESKTOP_FILE',
            DESKTOP_OPTIONS: 'COR3_WS_DESKTOP_OPTIONS',
            EXPEDITION_LAUNCHED: 'COR3_WS_EXPEDITION_LAUNCHED',
            EXPEDITION_LAUNCH_ERROR: 'COR3_WS_EXPEDITION_LAUNCH_ERROR',
            EXPEDITION_RETRY_LAUNCH: 'COR3_WS_EXPEDITION_RETRY_LAUNCH',
            INSUFFICIENT_CREDITS: 'COR3_WS_INSUFFICIENT_CREDITS',
            LOG: 'COR3_WS_LOG',
        },

        // HTTP-captured auth + version metadata (MAIN → isolated)
        AUTH: {
            BEARER_TOKEN: 'COR3_BEARER_TOKEN',
            WEB_VERSION: 'COR3_WEB_VERSION',
            SYSTEM_VERSION: 'COR3_SYSTEM_VERSION',
            DAILY_REWARDS: 'COR3_DAILY_REWARDS',
            TOKEN_EXPIRED: 'COR3_TOKEN_EXPIRED',
        },

        // Game-control commands (isolated → MAIN, executed by interceptor)
        GAME: {
            REQUEST_EXPEDITIONS: 'COR3_REQUEST_EXPEDITIONS',
            REQUEST_ARCHIVED_EXPEDITIONS: 'COR3_REQUEST_ARCHIVED_EXPEDITIONS',
            REFRESH_MARKET: 'COR3_REFRESH_MARKET',
            REFRESH_DARK_MARKET: 'COR3_REFRESH_DARK_MARKET',
            REFRESH_SRM_MARKET: 'COR3_REFRESH_SRM_MARKET',
            LAUNCH_EXPEDITION: 'COR3_LAUNCH_EXPEDITION',
            OPEN_CONTAINER: 'COR3_OPEN_CONTAINER',
            COLLECT_ALL: 'COR3_COLLECT_ALL',
            ACCEPT_JOB: 'COR3_ACCEPT_JOB',
            RESPOND_DECISION: 'COR3_RESPOND_DECISION',
            OPEN_NETWORK_MAP: 'COR3_OPEN_NETWORK_MAP',
            OPEN_MARKET_JOBS: 'COR3_OPEN_MARKET_JOBS',
            REQUEST_NM_SERVERS: 'COR3_REQUEST_NM_SERVERS',
            NM_SERVERS: 'COR3_NM_SERVERS',
            REQUEST_NM_MAP: 'COR3_REQUEST_NM_MAP',
            NM_GRAPH: 'COR3_NM_GRAPH',
            // Re-request current loadout snapshot. Trivial: join-room
            // {room:"loadout"} — server replies with loadout/get.options.
            REQUEST_LOADOUT: 'COR3_REQUEST_LOADOUT',
            // Tell MAIN to revert the network-map endpoint back to HOME
            // (used by auto-jobs at end of a bulk-accept batch that may
            // have left endpoint on DARK/SRM after a remote-market accept).
            REVERT_ENDPOINT_TO_HOME: 'COR3_REVERT_ENDPOINT_TO_HOME',
        },

        // Solver lifecycle (MAIN ↔ isolated)
        SOLVER: {
            START_DECRYPT: 'COR3_START_DECRYPT_SOLVER',
            STOP_DECRYPT: 'COR3_STOP_DECRYPT_SOLVER',
            // Daily Ops one-shot solver (Game Center module).
            START_DAILY_OPS: 'COR3_START_DAILY_OPS',
            DAILY_OPS_LOG: 'COR3_DAILY_OPS_LOG',
            // Ice Wall solver — SAI's Porter-lite r4 minigame. Toggle-driven
            // watcher (same pattern as solver-decrypt): MAIN watches for
            // [data-sentry-component="IceWallBreakApplication"], then matches
            // lit wall glyphs against the target-preview signatures.
            START_ICE_WALL: 'COR3_START_ICE_WALL',
            // ICE WALL lifecycle heartbeat. Posted when the solver detects
            // an IceWallBreakApplication and again when that window closes.
            // Shape: { busy: bool, ts }. Auto-jobs uses it to suppress its
            // solving-watchdog while the puzzle is being worked — otherwise
            // a long ice-wall (cor3.gg allows up to 240s per round, and
            // multi-round puzzles compound) can trip the 5min state TTL
            // before the flow even gets to run.
            ICE_WALL_BUSY: 'COR3_ICE_WALL_BUSY',
            STOP_ICE_WALL: 'COR3_STOP_ICE_WALL',
            // Simple Decrypt — one-click "Decrypt" minigame. MAIN watches
            // for [data-sentry-component="SimpleDecryptApplication"], clicks
            // the Decrypt button, then polls progress until the app
            // disappears or the percentage label reads 100%.
            START_SIMPLE_DECRYPT: 'COR3_START_SIMPLE_DECRYPT',
            STOP_SIMPLE_DECRYPT: 'COR3_STOP_SIMPLE_DECRYPT',
        },

        // Job-flow dispatch (isolated → MAIN job-manager)
        JOB: {
            START_DECRYPTION: 'COR3_START_JOB_FLOW',
            START_IP_INJECTION: 'COR3_START_IP_JOB_FLOW',
            START_IP_CLEANUP: 'COR3_START_IP_CLEANUP_FLOW',
            START_UPLOAD: 'COR3_START_UPLOAD_JOB_FLOW',
            START_LOG_DELETION: 'COR3_START_LOG_DELETION_FLOW',
            START_LOG_DOWNLOAD: 'COR3_START_LOG_DOWNLOAD_FLOW',
            START_FILE_ELIMINATION: 'COR3_START_FILE_ELIMINATION_FLOW',
            START_DATA_DOWNLOAD: 'COR3_START_DATA_DOWNLOAD_FLOW',
            START_DECRYPT_EXTRACT: 'COR3_START_DECRYPT_EXTRACT_FLOW',
            ABORT: 'COR3_ABORT_JOB_FLOW',

            // Job-flow signals (MAIN → isolated)
            MINIGAME_DONE: 'COR3_JOB_MINIGAME_DONE',
            MINIGAME_TIMEOUT: 'COR3_JOB_MINIGAME_TIMEOUT',
            // Unified flow result. Carries { success, didWork, reason }.
            // success=true,didWork=true   → orchestrator sends COR3_COMPLETE_JOB.
            // success=true,didWork=false  → permanent reject (structurally
            //   nothing to do — log not in list, no section on server, etc).
            //   No completion sent. UI shows the reason next to the job.
            // success=false               → runtime crash/timeout — retry once,
            //   then permanent reject with runtime details.
            MINIGAME_RESULT: 'COR3_JOB_MINIGAME_RESULT',
            KD_DETECTED: 'COR3_JOB_KD_DETECTED',
            SERVER_UNREACHABLE: 'COR3_SERVER_UNREACHABLE',
            // Readiness probe result. Posted by server-connect when it
            // observes access state on a server.
            // Shape: { serverName, canAccess: bool, hasHackTools: bool, reason }
            // Consumed by auto-jobs to persist AJ_SERVER_READINESS so the
            // planner can pre-reject the server (and everything behind it)
            // without re-running the failing pipeline.
            SERVER_ACCESS_PROBED: 'COR3_SERVER_ACCESS_PROBED',
            LOG: 'COR3_JOB_LOG',
            AUTOJOBS_ACTIVE_CHANGED: 'COR3_AUTOJOBS_ACTIVE_CHANGED',
            // Orchestrator → UI: a state transition just occurred. Carries
            // { from, to, reason?, ts }. Used by the popup to render the
            // state pill, "next state" hint, and the state-history timeline.
            STATE_TRANSITIONED: 'COR3_AUTOJOBS_STATE_TRANSITIONED',
        },
    };

    // ──────────────────────────────────────────────────────────────────────
    // chrome.storage.local keys (game-data cache + runtime state)
    // ──────────────────────────────────────────────────────────────────────
    const STORAGE_LOCAL = {
        // Game data
        EXPEDITIONS: 'expeditionsData',
        EXPEDITIONS_AT: 'expeditionsDataUpdatedAt',
        // Archived expeditions: paginated history pulled via expeditions:get.archived.
        ARCHIVED_EXPEDITIONS: 'archivedExpeditionsData',
        ARCHIVED_EXPEDITIONS_AT: 'archivedExpeditionsUpdatedAt',
        DECISIONS: 'expeditionDecisions',
        STASH: 'stashData',
        MARKET: 'marketData',
        MARKET_AT: 'marketDataUpdatedAt',
        DARK_MARKET: 'darkMarketData',
        DARK_MARKET_AT: 'darkMarketDataUpdatedAt',
        DARK_MARKET_AVAILABLE: 'darkMarketAvailable',
        SRM_MARKET: 'srmMarketData',
        SRM_MARKET_AT: 'srmMarketDataUpdatedAt',
        SRM_MARKET_AVAILABLE: 'srmMarketAvailable',
        MERCENARIES: 'mercenariesData',
        MERCENARIES_AT: 'mercenariesUpdatedAt',
        EXPEDITION_CONFIG: 'expeditionConfigData',
        EXPEDITION_CONFIG_AT: 'expeditionConfigUpdatedAt',
        MERC_CONFIG: 'mercConfigData',
        MERC_CONFIG_AT: 'mercConfigUpdatedAt',
        DAILY_OPS: 'dailyOpsData',
        DAILY_OPS_AT: 'dailyOpsUpdatedAt',
        LOADOUT: 'loadoutData',
        LOADOUT_AT: 'loadoutDataUpdatedAt',
        DAILY_OPS_ERROR: 'dailyOpsError',
        DAILY_OPS_ERROR_AT: 'dailyOpsErrorUpdatedAt',
        DAILY_REWARDS: 'dailyRewardsData',

        // Auth + version
        BEARER_TOKEN: 'bearerToken',
        WEB_VERSION: 'webVersion',
        SYSTEM_VERSION: 'systemVersion',
        // Upstream extension-version probe. Written by background.js after
        // fetching release.json from the main branch. Shape:
        //   { localVersion, latestVersion, isOutdated, changes:[...], checkedAt }
        // Consumed by the popup's version-mismatch banner.
        EXT_UPDATE_INFO: 'extUpdateInfo',

        // Expedition runtime
        LAST_LAUNCH: 'lastExpeditionLaunchData',
        LAUNCH_ERROR: 'expeditionLaunchError',

        // Network Map runtime
        NM_SERVERS: 'networkMapServers',  // name array (DOM-scraped)
        NM_GRAPH:   'networkMapGraph',    // { home, currentEndpointId, servers:[{id,name,depth,faction,…}] }
                                          //   from network-map.get.map WS response (BFS-depth)

        // Auto-jobs runtime
        AUTOJOBS_STATE: 'autoJobsState',
        AUTOJOBS_QUEUE: 'autoJobsQueue',
        BUGGED_JOBS: 'buggedJobIds',  // superseded by AJ_REJECTED_JOBS
        // Per-cycle reachability snapshot.
        // Shape: { computedAt, markets: { home: {reachable, blockers, path}, dark, srm }, servers: {...} }
        AJ_REACHABILITY: 'ajReachability',
        // Per-server readiness probe. Shape:
        //   { [serverName]: { canAccess, hasHackTools, checkedAt, reason? } }
        // canAccess===false means the server is unusable until a fresh probe
        // contradicts it (e.g. no Active Access AND no Hack Tools, or a
        // hack-tool path that failed every retry). Planner consults this and
        // treats canAccess===false on the path as a hard reject — transitive
        // blocking. TTL handled in-code (default 15 min — long enough to
        // avoid re-probing every cycle, short enough to recover if the user
        // manually fixed access in-game).
        AJ_SERVER_READINESS: 'ajServerReadiness',
        // Permanent rejects for *this cycle*. No TTL — auto-cleared when the
        // job vanishes from markets, or via UI "Clear" button.
        // Shape: { [jobId]: { reason, since, descriptor } }
        AJ_REJECTED_JOBS: 'ajRejectedJobs',
        // Ring buffer of the last N state transitions (LIMITS.STATE_HISTORY_RING).
        // Shape: [{ ts, from, to, reason? }, …]. Persisted so the popup can render the
        // timeline without an open subscription to MSG.JOB.STATE_TRANSITIONED (popup is
        // a separate context from the orchestrator).
        AJ_STATE_HISTORY: 'ajStateHistory',
        // Most-recent completed jobs ring (LIMITS.COMPLETED_LOG_RING). Persisted
        // incrementally so a crash mid-cycle doesn't lose history. Shape:
        // [{ jobId, jobType, serverName, marketId, descriptor, completedAt }, …]
        // newest-first.
        AJ_COMPLETED_JOBS_LOG: 'ajCompletedJobsLog',

        // Solver runtime
        DAILY_HACK_LOG: 'dailyHackLog',
        DAILY_HACK_LOG_AT: 'dailyHackLogUpdatedAt',

        // Popup UI: persistent collapsed/expanded state for collapsible
        // sections. Shape: { [sectionKey]: boolean } where true=open. Keys
        // are short stable strings (e.g. 'aj.sources', 'aj.jobTypes',
        // 'aj.timeline'). Anything not present falls back to the section's
        // hard-coded default in the renderer.
        UI_COLLAPSE: 'uiCollapse',

        // Centralized logger ring buffer.
        // Shape: { [moduleId]: [{ ts, level, msg, ctx }, ...] }
        LOGS: 'cor3_logs',

        // Centralized error capture.
        ERRORS: 'cor3_errors',
    };

    // ──────────────────────────────────────────────────────────────────────
    // chrome.storage.sync keys (user preferences + module state)
    // ──────────────────────────────────────────────────────────────────────
    const STORAGE_SYNC = {
        // Theme
        SELECTED_THEME: 'selectedTheme',

        // Multi-alarm
        ALARMS: 'alarms',

        // Auto-jobs
        AUTOJOBS_SETTINGS: 'autoJobsSettings',
        SERVER_PRIORITIES: 'serverPriorities',

        // Auto-send merc
        AUTO_SEND_MERC: 'autoSendMerc',

        // Auto-decrypt / Auto-ice-wall / Auto-simple-decrypt
        AUTO_DECRYPT_ENABLED: 'autoDecryptEnabled',
        AUTO_ICE_WALL_ENABLED: 'autoIceWallEnabled',
        AUTO_SIMPLE_DECRYPT_ENABLED: 'autoSimpleDecryptEnabled',

        // Auto-refresh
        AUTO_REFRESH: 'autoRefresh',

        // Auto-choose decision (replaces decisionModifiers; 0..10 risk threshold)
        RISK_THRESHOLD: 'riskThreshold',
        AUTO_CHOOSE_ENABLED: 'autoChooseEnabled',

        // Game appearance toggles
        DISABLE_SYSTEM_MESSAGES: 'disableSystemMessages',
        DISABLE_BACKGROUND: 'disableBackground',
        DISABLE_NETWORK_FOG: 'disableNetworkFog',

        // Pinned timers
        PINNED_TIMERS: 'pinnedTimers',

        // Per-module enable/log state.
        // Shape: { [moduleId]: { enabled: boolean, logsEnabled: boolean } }
        MODULES: 'modules',
    };

    // ──────────────────────────────────────────────────────────────────────
    // Job/flow type identifiers (used by FLOW_DISPATCH in auto-jobs)
    // ──────────────────────────────────────────────────────────────────────
    const FLOW = {
        FILE_DECRYPTION: 'file_decryption',
        IP_INJECTION: 'ip_injection',
        IP_CLEANUP: 'ip_cleanup',
        FILE_UPLOAD: 'file_upload',
        LOG_DELETION: 'log_deletion',
        LOG_DOWNLOAD: 'log_download',
        FILE_ELIMINATION: 'file_elimination',
        DATA_DOWNLOAD: 'data_download',
        DECRYPT_EXTRACT: 'decrypt_extract',
    };

    // ──────────────────────────────────────────────────────────────────────
    // Log levels
    // ──────────────────────────────────────────────────────────────────────
    const LOG_LEVEL = {
        DEBUG: 'debug',
        INFO: 'info',
        WARN: 'warn',
        ERROR: 'error',
    };

    // ──────────────────────────────────────────────────────────────────────
    // Module categories (for Module Manager UI grouping)
    // ──────────────────────────────────────────────────────────────────────
    const CATEGORY = {
        CORE: 'core',
        DATA: 'data',
        AUTOMATION: 'automation',
        GAME: 'game',
        SOLVER: 'solver',
        APPEARANCE: 'appearance',
        UI: 'ui',
    };

    // ──────────────────────────────────────────────────────────────────────
    // Tunables
    // ──────────────────────────────────────────────────────────────────────
    const LIMITS = {
        LOG_RING_PER_MODULE: 200,
        ERRORS_RING: 200,
        BUGGED_JOB_TTL_MS: 2 * 60 * 60 * 1000,
        AUTOJOBS_STATE_TTL_MS: 5 * 60 * 1000,
        // Buffer added to a server's K/D MaintenanceTimer before we attempt to
        // reach it again. Covers timer-text rounding + WS staleness.
        KD_BUFFER_MS: 5 * 60 * 1000,
        // Default cooldown between distinct auto-jobs actions (state
        // transitions, flow start, heavy SAI clicks). Per-call override
        // available via cooldown.gate(label, { override: ms }).
        ACTION_COOLDOWN_MS: 3000,
        STATE_HISTORY_RING: 50,
        COMPLETED_LOG_RING: 50,
    };

    // D4RK servers that don't have a Logs section at all. Planner rejects
    // log_download / log_deletion against these up-front. Keep in sync with
    // what the game actually exposes — there's no lazy-learning fallback
    // (the old probe was racy and permanently poisoned legitimate servers
    // on a single timing miss).
    const NO_LOGS_SERVERS = ['D4RK RM7CE', 'D4RK 2IV2', 'D4RK RM7MI'];

    root.COR3.constants = { MSG, STORAGE_LOCAL, STORAGE_SYNC, FLOW, LOG_LEVEL, CATEGORY, LIMITS, NO_LOGS_SERVERS };
})();
