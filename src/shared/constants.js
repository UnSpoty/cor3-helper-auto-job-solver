// src/shared/constants.js
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
            // Tell MAIN to revert the network-map endpoint back to HOME
            // (used by auto-jobs at end of a bulk-accept batch that may
            // have left endpoint on DARK/SRM after a remote-market accept).
            REVERT_ENDPOINT_TO_HOME: 'COR3_REVERT_ENDPOINT_TO_HOME',
        },

        // Solver lifecycle (MAIN ↔ isolated)
        SOLVER: {
            START_DECRYPT: 'COR3_START_DECRYPT_SOLVER',
            STOP_DECRYPT: 'COR3_STOP_DECRYPT_SOLVER',
            // Daily Ops one-shot solver (Game Center module). Replaces the
            // legacy daily-hack toggle, which solved the same puzzles when
            // they lived on a standalone page (deleted May 2026).
            START_DAILY_OPS: 'COR3_START_DAILY_OPS',
            DAILY_OPS_LOG: 'COR3_DAILY_OPS_LOG',
            // Ice Wall solver — SAI's Porter-lite r4 minigame. Toggle-driven
            // watcher (same pattern as solver-decrypt): MAIN watches for
            // [data-sentry-component="IceWallBreakApplication"], then matches
            // lit wall glyphs against the target-preview signatures.
            START_ICE_WALL: 'COR3_START_ICE_WALL',
            STOP_ICE_WALL: 'COR3_STOP_ICE_WALL',
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
            KD_DETECTED: 'COR3_JOB_KD_DETECTED',
            SERVER_UNREACHABLE: 'COR3_SERVER_UNREACHABLE',
            LOG: 'COR3_JOB_LOG',
            AUTOJOBS_ACTIVE_CHANGED: 'COR3_AUTOJOBS_ACTIVE_CHANGED',
        },
    };

    // ──────────────────────────────────────────────────────────────────────
    // chrome.storage.local keys (game-data cache + runtime state)
    // ──────────────────────────────────────────────────────────────────────
    const STORAGE_LOCAL = {
        // Game data
        EXPEDITIONS: 'expeditionsData',
        EXPEDITIONS_AT: 'expeditionsDataUpdatedAt',
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
        DAILY_OPS_ERROR: 'dailyOpsError',
        DAILY_OPS_ERROR_AT: 'dailyOpsErrorUpdatedAt',
        DAILY_REWARDS: 'dailyRewardsData',

        // Auth + version
        BEARER_TOKEN: 'bearerToken',
        WEB_VERSION: 'webVersion',
        SYSTEM_VERSION: 'systemVersion',

        // Expedition runtime
        LAST_LAUNCH: 'lastExpeditionLaunchData',
        LAUNCH_ERROR: 'expeditionLaunchError',

        // Network Map runtime
        NM_SERVERS: 'networkMapServers',  // legacy: name array (DOM-scraped)
        NM_GRAPH:   'networkMapGraph',    // canonical: { home, currentEndpointId, servers:[{id,name,depth,faction,…}] }
                                          //              from network-map.get.map WS response (BFS-depth)

        // Auto-jobs runtime
        AUTOJOBS_STATE: 'autoJobsState',
        AUTOJOBS_QUEUE: 'autoJobsQueue',
        BUGGED_JOBS: 'buggedJobIds',

        // Solver runtime
        DAILY_HACK_LOG: 'dailyHackLog',
        DAILY_HACK_LOG_AT: 'dailyHackLogUpdatedAt',

        // Centralized logger ring buffer (new, replaces cor3_ws_messages)
        // Shape: { [moduleId]: [{ ts, level, msg, ctx }, ...] }
        LOGS: 'cor3_logs',

        // Centralized error capture (kept for back-compat)
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

        // Auto-decrypt / Auto-ice-wall
        AUTO_DECRYPT_ENABLED: 'autoDecryptEnabled',
        AUTO_ICE_WALL_ENABLED: 'autoIceWallEnabled',

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

        // NEW: per-module enable/log state
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
        LOG_RING_PER_MODULE: 200,    // entries kept per module in cor3_logs
        ERRORS_RING: 200,             // entries in cor3_errors
        BUGGED_JOB_TTL_MS: 2 * 60 * 60 * 1000,  // 2h
        AUTOJOBS_STATE_TTL_MS: 5 * 60 * 1000,   // 5min
    };

    root.COR3.constants = { MSG, STORAGE_LOCAL, STORAGE_SYNC, FLOW, LOG_LEVEL, CATEGORY, LIMITS };
})();
