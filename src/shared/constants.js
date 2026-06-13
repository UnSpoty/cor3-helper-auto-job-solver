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
            USOL_MARKET: 'COR3_WS_USOL_MARKET',
            USOL_MARKET_UNREACHABLE: 'COR3_WS_USOL_MARKET_UNREACHABLE',
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
            // the per-job-type pre-rejection in the Auto Jobs planner.
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
            // SAI (Server Admin Interface) subsystem replies. Posted by the WS
            // interceptor's `sai` inbound route in response to the __cor3Sai*
            // read helpers, so an Auto Jobs flow can awaitBus the reply
            // instead of scraping the SAI terminal DOM. Reply data shapes
            // (captured live, see tmp_research/sai-wire-capture.md):
            //   SAI_SUMMARY  ← get.summary
            //   SAI_TRANSIT  ← get.transit  { serverId, ips:[{ip,description,source}], … }
            //   SAI_FILES    ← get.files    { serverId, files:[{fileId,name,…}], … }
            //   SAI_LOGS     ← get.logs     { serverId, logs:[{seq,message,…}], … }
            //   SAI_ACTION   ← transit.add/remove · file.download/delete · log.download/delete
            //                  { action, data, error } — the mutation's verdict.
            SAI_SUMMARY: 'COR3_WS_SAI_SUMMARY',
            SAI_TRANSIT: 'COR3_WS_SAI_TRANSIT',
            SAI_FILES: 'COR3_WS_SAI_FILES',
            SAI_LOGS: 'COR3_WS_SAI_LOGS',
            SAI_ACTION: 'COR3_WS_SAI_ACTION',
            EXPEDITION_LAUNCHED: 'COR3_WS_EXPEDITION_LAUNCHED',
            EXPEDITION_LAUNCH_ERROR: 'COR3_WS_EXPEDITION_LAUNCH_ERROR',
            EXPEDITION_RETRY_LAUNCH: 'COR3_WS_EXPEDITION_RETRY_LAUNCH',
            INSUFFICIENT_CREDITS: 'COR3_WS_INSUFFICIENT_CREDITS',
            // Player profile signals from the `profile` room. Posted by the
            // interceptor for profile.get.credits / receive.credits (balance
            // deltas) / receive.progress (account RENOWN) AND seeded from
            // market.get.options.userCredits. Shape (partial, only what fired):
            //   { balance?, creditsDelta?, renownLevel?, renownProgress?,
            //     renownNext?, source }
            // Consumed by the `profile` data module → STORAGE_LOCAL.PROFILE,
            // which the Expeditions auto-send min/max logic reads.
            PROFILE: 'COR3_WS_PROFILE',
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
            REFRESH_USOL_MARKET: 'COR3_REFRESH_USOL_MARKET',
            LAUNCH_EXPEDITION: 'COR3_LAUNCH_EXPEDITION',
            OPEN_CONTAINER: 'COR3_OPEN_CONTAINER',
            COLLECT_ALL: 'COR3_COLLECT_ALL',
            // Request a player-profile snapshot (join `profile` room + send
            // profile.get.credits). Seeds STORAGE_LOCAL.PROFILE balance for the
            // Expeditions min/max auto-send; live deltas then arrive via
            // profile.receive.credits.
            REQUEST_PROFILE: 'COR3_REQUEST_PROFILE',
            // stash.delete.item { itemId, quantity } — "Throw Away" in the
            // in-game Stash item-info panel. Captured live; sell uses the
            // pre-existing literal 'COR3_SELL_ITEM'.
            DELETE_ITEM: 'COR3_DELETE_ITEM',
            ACCEPT_JOB: 'COR3_ACCEPT_JOB',
            // market.job.complete (endpoint-preflight handled in the interceptor,
            // like ACCEPT_JOB). Generic game RPC — used by the Auto Jobs flow
            // modules to claim a finished job.
            COMPLETE_JOB: 'COR3_COMPLETE_JOB',
            // market.job.dismiss (endpoint-preflight handled in the interceptor,
            // like COMPLETE_JOB). Clears a FAILED job from the market's
            // recentJobs / "Active Jobs" panel. Used by the Auto Jobs
            // orchestrator's auto-dismiss step + the popup's manual ✕ button.
            DISMISS_JOB: 'COR3_DISMISS_JOB',
            RESPOND_DECISION: 'COR3_RESPOND_DECISION',
            REQUEST_NM_MAP: 'COR3_REQUEST_NM_MAP',
            NM_GRAPH: 'COR3_NM_GRAPH',
            // Re-request current loadout snapshot. Trivial: join-room
            // {room:"loadout"} — server replies with loadout/get.options.
            REQUEST_LOADOUT: 'COR3_REQUEST_LOADOUT',
            // Tell MAIN to revert the network-map endpoint back to HOME
            // (posted by the orchestrator at the end of a bulk-accept batch
            // that may have left endpoint on DARK/SRM after a remote-market
            // accept).
            REVERT_ENDPOINT_TO_HOME: 'COR3_REVERT_ENDPOINT_TO_HOME',
            // chrome.runtime action (popup → content script) asking the page
            // to force a Network Map rescan. The Auto Jobs orchestrator listens
            // for it; the Network Map Refresh button fires it. Plain string
            // (not a COR3_* window type).
            RESCAN_NETWORK_MAP: 'rescanNetworkMap',
        },

        // Solver lifecycle (MAIN ↔ isolated)
        SOLVER: {
            START_DECRYPT: 'COR3_START_DECRYPT_SOLVER',
            STOP_DECRYPT: 'COR3_STOP_DECRYPT_SOLVER',
            // Daily Ops one-shot solver (Game Center module).
            START_DAILY_OPS: 'COR3_START_DAILY_OPS',
            DAILY_OPS_LOG: 'COR3_DAILY_OPS_LOG',
            // Terminal verdict of ONE solver run: { ok: bool }. Posted from the
            // START handler's finally — fires on EVERY outcome, including the
            // soft failures (Start button missing, puzzle never opened) that
            // emit no "solved:"/"Error:" log line. The isolated daily-ops
            // watcher releases its auto in-flight latch on this instead of
            // regex-matching log lines (which leaked the latch into the 4min
            // watchdog on every soft failure).
            DAILY_OPS_RESULT: 'COR3_DAILY_OPS_RESULT',
            // Ice Wall solver — SAI's Porter-lite r4 minigame. Toggle-driven
            // watcher (same pattern as solver-decrypt): MAIN watches for
            // [data-sentry-component="IceWallBreakApplication"], then matches
            // lit wall glyphs against the target-preview signatures.
            START_ICE_WALL: 'COR3_START_ICE_WALL',
            // ICE WALL lifecycle heartbeat. Posted when the solver detects
            // an IceWallBreakApplication and again when that window closes.
            // Shape: { busy: bool, ts }.
            ICE_WALL_BUSY: 'COR3_ICE_WALL_BUSY',
            STOP_ICE_WALL: 'COR3_STOP_ICE_WALL',
            // ICE WALL learned click-DB sync. The MAIN solver learns, per shape,
            // which cell to click (brute-forced once, then reused). MAIN can't
            // touch chrome.storage, so the isolated auto-ice-wall module persists
            // it: solver → ICE_WALL_DB_REQUEST → bridge replies ICE_WALL_DB; on a
            // new learn the solver → ICE_WALL_LEARN → bridge writes storage.
            ICE_WALL_DB_REQUEST: 'COR3_ICE_WALL_DB_REQUEST',
            ICE_WALL_DB: 'COR3_ICE_WALL_DB',
            ICE_WALL_LEARN: 'COR3_ICE_WALL_LEARN',
            // Simple Decrypt — one-click "Decrypt" minigame. MAIN watches
            // for [data-sentry-component="SimpleDecryptApplication"], clicks
            // the Decrypt button, then polls progress until the app
            // disappears or the percentage label reads 100%.
            START_SIMPLE_DECRYPT: 'COR3_START_SIMPLE_DECRYPT',
            STOP_SIMPLE_DECRYPT: 'COR3_STOP_SIMPLE_DECRYPT',
        },

        // Game-core log channel (MAIN interceptor → isolated). The interceptor
        // posts human-readable game-action notes (accept/complete RPCs, SAI
        // login verdicts) here; the Auto Jobs bridge mirrors them into the
        // Activity Log.
        JOB: {
            LOG: 'COR3_JOB_LOG',
        },

        // Site-embedded helper-UI control (isolated → MAIN).
        UI: {
            // Visibility verdict for the LOADOUT pill the MAIN-world
            // loadout-panel module injects. Bridged from
            // STORAGE_SYNC.SHOW_LOADOUT_WIDGET (MAIN has no chrome.storage)
            // by the isolated appearance-loadout-widget module: posted once on
            // boot and on every toggle change. Payload: { visible: bool }.
            // Hiding removes ONLY the pill/panel DOM — the headless
            // COR3.game.loadout API (Auto Jobs's ensureDecrypt/ensureHack)
            // stays live regardless.
            SHOW_LOADOUT_WIDGET: 'COR3_SHOW_LOADOUT_WIDGET',
        },

        // Auto Jobs control. Owns its own runtime actions and window messages.
        AUTOJOBS: {
            // chrome.tabs.sendMessage action the popup fires alongside the
            // AUTOJOBS_SETTINGS sync write, so the orchestrator starts/stops
            // its loop immediately even on Firefox (where sync.onChanged can
            // be flaky across contexts). Payload: { settings: { enabled } }.
            TOGGLE: 'toggleAutoJobs',

            // popup → isolated runtime actions (Network Map context menu).
            // Payload: { serverName }. The orchestrator forwards these to the
            // MAIN-world bridge — but refuses while the loop is running, so
            // a manual click can't flap the endpoint mid-cycle.
            OPEN_SAI_ACTION: 'ajOpenSai',
            OPEN_MARKET_ACTION: 'ajOpenMarket',

            // popup Jobs panel → orchestrator: rebuild the saved job board ONCE
            // from the current markets (the orchestrator runs the read-only
            // half of the pipeline and republishes AJ_JOB_QUEUE). Refused
            // while the loop runs (it already rebuilds the board each cycle).
            REFRESH_BOARD: 'ajRefreshBoard',

            // popup Activity-Log "Clear" → orchestrator (isolated world, where
            // the authoritative log ring lives). Wipes the Auto Jobs log entries
            // (module ids 'auto-jobs' + 'flow-*') from the Logger's buffer
            // AND storage in one place, so a popup-side storage wipe can't be
            // clobbered by the content world re-flushing its in-memory ring.
            CLEAR_LOG: 'ajClearLog',

            // popup Jobs list "✕" on a FAILED row → orchestrator: dismiss that
            // one failed job now (market.job.dismiss). Payload: { jobId, marketId }.
            // Refused while the loop runs (a manual endpoint flip would flap the
            // pipeline's SAI session mid-cycle) — the auto-dismiss step handles it
            // while running instead.
            DISMISS_FAILED: 'ajDismissFailed',

            // popup Jobs list "✓" on a READY-to-complete row → orchestrator:
            // claim that one finished job now (market.job.complete). Payload:
            // { jobId, marketId }. Refused while the loop runs (same endpoint-flip
            // hazard as DISMISS_FAILED) — the READY_TO_COMPLETE step claims it
            // while running instead.
            COMPLETE_JOB: 'ajCompleteJob',

            // isolated → MAIN window messages. Handled by the MAIN-world bridge.
            OPEN_SAI: 'COR3_AJ_OPEN_SAI',
            OPEN_MARKET: 'COR3_AJ_OPEN_MARKET',

            // JOB_FLOW dispatch (isolated orchestrator → MAIN flow module).
            // Payload: { jobId, marketId, jobType, fileCondition }.
            // (Field is `jobType`, NOT `type` — Bus.window builds the envelope as
            //  Object.assign({type}, payload), so a payload `type` would clobber
            //  the Bus message id and the message would never be delivered.)
            // The MAIN flow executes the job (loadout + minigame + complete) and
            // replies with FLOW_RESULT.
            FLOW_START: 'COR3_AJ_FLOW_START',
            // Orchestrator → MAIN flow: cancel the in-flight job (STOP pressed
            // or FLOW_TIMEOUT_MS elapsed). Payload: { jobId }. The flow flips
            // its abort flag, bails out of its wait loops WITHOUT sending
            // job.complete, and stops being "busy" so the next FLOW_START runs.
            FLOW_ABORT: 'COR3_AJ_FLOW_ABORT',
            // MAIN flow → isolated orchestrator: "I'm now on sub-step <node>".
            // Payload: { jobId, node } where node ∈ AJ.NODE.*. The orchestrator
            // relays it to AJ_PIPELINE_STATE so the pipeline status shows the
            // live sub-step inside JOB_FLOW.
            FLOW_STEP: 'COR3_AJ_FLOW_STEP',
            // MAIN flow → isolated orchestrator. Payload:
            //   { jobId, marketId, success, didWork, reason, retryable }
            //   success:true,didWork:true   → flow completed the job (job.complete sent)
            //   success:true,didWork:false  → genuinely undoable (e.g. no owned
            //                                  decrypt software) → MARK bugged
            //   success:false               → failure. `retryable:true` flags a
            //                                  TRANSIENT condition (env/timing/DOM
            //                                  not ready, flow-busy, abort) — the
            //                                  orchestrator SKIPs and retries it
            //                                  next cycle (NOT bugged). Absent or
            //                                  retryable:false → MARK bugged.
            FLOW_RESULT: 'COR3_AJ_FLOW_RESULT',

            // Route-opening: isolated orchestrator → MAIN bridge "hack this
            // transit GATE node to open the route to a server behind it" (the
            // hackTransitNodes feature). Payload: { gateServerId, gateServerType,
            // gateServerName }. The bridge connects + hacks the gate (no SAI login
            // after — only the access GRANT is needed to relay through it) and
            // replies HACK_RESULT: { gateServerName, success, retryable, reason }.
            // retryable:false === permanently un-openable (planHack none/underpower)
            // → the orchestrator records it in AJ_BUGGED_GATES so CHECK_ACCESS
            // stops offering it as openable.
            HACK_TRANSIT: 'COR3_AJ_HACK_TRANSIT',
            HACK_RESULT: 'COR3_AJ_HACK_RESULT',
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
        USOL_MARKET: 'usolMarketData',
        USOL_MARKET_AT: 'usolMarketDataUpdatedAt',
        USOL_MARKET_AVAILABLE: 'usolMarketAvailable',
        MERCENARIES: 'mercenariesData',
        MERCENARIES_AT: 'mercenariesUpdatedAt',
        // Per-market mercenary/elite/reputation map, keyed by marketId. Each
        // market is its own faction (distinct reputation + elite mercs); the
        // multi-market Expeditions UI reads this. MERCENARIES (above) still
        // mirrors the HOME market for auto-send + back-compat.
        MERC_MARKETS: 'mercMarketsData',
        MERC_MARKETS_AT: 'mercMarketsUpdatedAt',
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
        // Player profile snapshot (credits balance + account RENOWN). Written by
        // the `profile` data module from MSG.WS.PROFILE. Shape:
        //   { balance, renownLevel, renownProgress, renownNext, updatedAt }
        // The Expeditions min/max auto-send reads `balance`.
        PROFILE: 'profileData',
        PROFILE_AT: 'profileDataUpdatedAt',

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
        // Auto-send min/max engine runtime state (published for the UI). Shape:
        //   { armed: bool, balance: number|null, status: string, updatedAt }
        // `armed` is the hysteresis latch (true between balance≥Max and ≤Min);
        // `status` is a human-readable phase shown under the Money Min/Max card.
        EXP_AUTOSEND_STATE: 'expAutoSendState',

        // Network Map runtime
        NM_GRAPH:   'networkMapGraph',    // { home, currentEndpointId, servers:[{id,name,depth,faction,…}] }
                                          //   from network-map.get.map WS response (BFS-depth)

        // ── Auto Jobs runtime ────────────────────────────────────────────────
        // Pipeline progress, driven by the orchestrator and consumed by the
        // popup pipeline status readout. Shape:
        //   { running, cycle, node, startedAt, updatedAt, delayMs?, error? }
        // `node` is one of AJ.NODE.* — the flowchart node currently executing.
        AJ_PIPELINE_STATE: 'ajPipelineState',
        // The job board the pipeline produced this cycle. Shape:
        //   { cycle, computedAt,
        //     markets: [{ slot, reachable, refreshed, jobCount, takenCount, failedCount, reason }],
        //     jobs: [{ id, name, type, status, serverName, marketSlot, marketId,
        //              rewardCredits, eligible, skipReason }] }
        // `markets` lets the UI group jobs per market (incl. reachable-but-
        // empty / unreachable ones). `status` is 'AVAILABLE' | 'TAKEN'
        // (in-progress) | 'FAILED' (awaiting dismissal). `eligible` is null until
        // CHECK_CONDITION runs, then bool (stays null for TAKEN/FAILED);
        // `skipReason` is the human-readable reason a job was marked SKIP.
        AJ_JOB_QUEUE: 'ajJobQueue',
        // Bugged-job registry the pipeline reads and writes itself.
        // Shape: { [jobId]: { reason, since } }.
        AJ_BUGGED_JOBS: 'ajBuggedJobs',
        // Per-server user overrides set from the Network Map context menu.
        // Shape: { [serverName]: { skip: bool, disabledTypes: { [jobType]: true } } }
        // Read by CHECK_CONDITION: a skipped server rejects all its jobs;
        // a disabled type rejects that job type on that server only.
        AJ_SERVER_OVERRIDES: 'ajServerOverrides',
        // Global Master Switches set from the "Master Switches" panel.
        // Shape: { markets: { home, dark, srm, usol }, jobTypes: { [FLOW.*]: bool },
        //          behaviour: { autoDismissFailed } }.
        // For markets/jobTypes a value of `false` disables that market/type
        // globally (no jobs from a disabled market are accepted; a disabled type
        // is rejected everywhere); absent === enabled (default "everything on").
        // behaviour.autoDismissFailed defaults OFF (absent === off) — it gates
        // the orchestrator's auto-dismiss of FAILED jobs.
        AJ_MASTER_SWITCHES: 'ajMasterSwitches',
        // Transit gates the MAIN hack proved permanently un-openable (planHack
        // none/underpower) — keyed by gate server name. Read by CHECK_ACCESS to
        // demote a server behind such a gate back to a hard noPath (so it is not
        // accepted-then-postponed forever). Shape: { [gateName]: { reason, since } }.
        AJ_BUGGED_GATES: 'ajBuggedGates',
        // ICE WALL solver's learned shape→click-cell database (persisted by the
        // isolated auto-ice-wall bridge on behalf of the MAIN solver).
        // Shape: { [shapeKey]: { cells:[{dc,dr,mirror,revealed,g}], click:{dc,dr,mirror}, learnedAt, hits } }
        ICE_WALL_CLICK_DB: 'iceWallClickDb',

        // Solver runtime
        DAILY_HACK_LOG: 'dailyHackLog',
        DAILY_HACK_LOG_AT: 'dailyHackLogUpdatedAt',

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

        // Auto Jobs — isolated settings (START/STOP + future config). The
        // UI tab reads/writes this key; the orchestrator's loop is driven
        // by its `enabled` flag.
        AUTOJOBS_SETTINGS: 'autoJobsSettings',

        // Auto-send merc (LEGACY — pre-rework per-merc pin object. Kept for
        // one-time migration into EXPEDITIONS_SETTINGS; no longer the source
        // of truth.)
        AUTO_SEND_MERC: 'autoSendMerc',

        // Expeditions tab settings (the rework). Single object:
        //   { masterEnabled: bool,                  // #2 master switch — gates ALL
        //                                            //    expedition automation
        //                                            //    (auto-send + auto-choose
        //                                            //    decision + auto-collect)
        //     autoSend: { enabled, moneyMin, moneyMax },  // #3–5 min/max latch
        //     disabledReason: string|null }         // surfaced in the UI
        // moneyMin/moneyMax are CR-balance thresholds: arm sending at
        // balance ≥ moneyMax, keep sending the cheapest AVAILABLE merc until
        // balance ≤ moneyMin (hysteresis latch; never self-disables).
        EXPEDITIONS_SETTINGS: 'expeditionsSettings',

        // Expeditions tab — stash Items list view preferences. Single object:
        //   { by: 'default'|'name'|'price'|'tier'|'qty'|'category'|'flags'|'newest',
        //     dir: 'asc'|'desc',
        //     hideCraft: bool }   // hide items usable in crafting
        // 'default' keeps the server order ('dir' is ignored for it).
        EXP_STASH_SORT: 'expStashSort',

        // Auto-decrypt / Auto-ice-wall / Auto-simple-decrypt
        AUTO_DECRYPT_ENABLED: 'autoDecryptEnabled',
        AUTO_ICE_WALL_ENABLED: 'autoIceWallEnabled',
        AUTO_SIMPLE_DECRYPT_ENABLED: 'autoSimpleDecryptEnabled',

        // Auto Daily Ops — watcher auto-solves Daily Ops when the timer hits
        // 00:00 (a new task is available) or the current day is still unsolved.
        AUTO_DAILY_OPS_ENABLED: 'autoDailyOpsEnabled',

        // Auto-refresh
        AUTO_REFRESH: 'autoRefresh',

        // Auto-choose decision (replaces decisionModifiers; 0..10 risk threshold)
        RISK_THRESHOLD: 'riskThreshold',
        AUTO_CHOOSE_ENABLED: 'autoChooseEnabled',

        // Game appearance toggles
        DISABLE_SYSTEM_MESSAGES: 'disableSystemMessages',
        DISABLE_BACKGROUND: 'disableBackground',
        DISABLE_NETWORK_FOG: 'disableNetworkFog',

        // Site-embedded LOADOUT widget (the pill the MAIN-world loadout-panel
        // module injects next to cor3.gg's Notifications). OFF by default —
        // nothing is injected until the user enables it in Overview. Bridged
        // to MAIN by appearance-loadout-widget via MSG.UI.SHOW_LOADOUT_WIDGET.
        SHOW_LOADOUT_WIDGET: 'showLoadoutWidget',

        // Per-module enable/log state.
        // Shape: { [moduleId]: { enabled: boolean, logsEnabled: boolean } }
        MODULES: 'modules',
    };

    // ──────────────────────────────────────────────────────────────────────
    // Job/flow type identifiers (used by the Auto Jobs pipeline + flow modules)
    // ──────────────────────────────────────────────────────────────────────
    const FLOW = {
        FILE_DECRYPTION: 'file_decryption',
        IP_INJECTION: 'ip_injection',
        IP_CLEANUP: 'ip_cleanup',
        DATA_UPLOAD: 'data_upload',
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
    };

    // D4RK servers that don't have a Logs section at all. The log_download /
    // log_deletion flows reject these up-front. Keep in sync with what the
    // game actually exposes — there's no lazy-learning fallback (the old probe
    // was racy and permanently poisoned legitimate servers on a single timing
    // miss).
    const NO_LOGS_SERVERS = ['D4RK RM7CE', 'D4RK 2IV2', 'D4RK RM7MI'];

    // ──────────────────────────────────────────────────────────────────────
    // Auto Jobs pipeline contract
    // ──────────────────────────────────────────────────────────────────────
    // Single source of truth shared by the isolated-world orchestrator (which
    // executes the nodes) and the popup pipeline status readout (which labels
    // the live node). Both reference these ids; the orchestrator keeps the
    // execution sequence, the status readout maps each id to a label — neither
    // hard-codes the string ids.
    const AJ = {
        // Envelope `type` stamped on the packet that flows stage→stage.
        PACKET_TYPE: 'aj/packet',

        // Flowchart node ids. Modules + decision diamonds + delay nodes.
        NODE: {
            START: 'start',
            DELAY_INITIAL: 'delay-initial',
            GET_SERVERS: 'get-servers',
            CHECK_ACCESS: 'check-access',
            UPDATE_MARKETS: 'update-markets',
            JOB_QUEUE: 'job-queue',
            READY_TO_COMPLETE: 'ready-to-complete',  // complete TAKEN jobs the game reports canComplete=true (solved but not yet claimed)
            DISMISS_FAILED: 'dismiss-failed',  // auto-dismiss FAILED jobs (gated by Master-Switches behaviour.autoDismissFailed)
            QUEUE_EMPTY: 'queue-empty',     // decision: is the queue empty?
            HAVE_TASKS_IN_PROGRESS: 'have-tasks-in-progress', // decision: any TAKEN job?
            BUGGED_JOBS: 'bugged-jobs',    // decision: is the in-progress job bugged?
            JOB_SKIP: 'job-skip',          // in-progress job is bugged → skip the cycle
            CHECK_CONDITION: 'check-condition',
            JOB_ACCEPTION: 'job-acception',
            JOB_FLOW: 'job-flow',          // selector — dispatches each TAKEN job to its flow module
            // file_decryption sub-flow. The MAIN flow module reports its
            // current step via MSG.AUTOJOBS.FLOW_STEP; the orchestrator
            // relays it into AJ_PIPELINE_STATE so the pipeline status shows it.
            FD_READ_FORMAT: 'fd-read-format',
            FD_CHECK_LOADOUT: 'fd-check-loadout',  // decision: can we (get capability to) decrypt?
            FD_INSTALL_SW: 'fd-install-sw',
            FD_OPEN_DOWNLOADS: 'fd-open-downloads',
            FD_SOLVE: 'fd-solve',
            FD_COMPLETE: 'fd-complete',
            // ── SAI sub-flows. Each flow module posts its current step via
            // MSG.AUTOJOBS.FLOW_STEP; the orchestrator relays it into
            // AJ_PIPELINE_STATE so the pipeline status readout shows it. All SAI
            // flows share the shape: <P>_ACCESS (connect + grant/hack login, pure
            // WS) → <P>_<ACTION> (the get.* + mutate.* WS loop) → <P>_COMPLETE
            // (job.complete). decrypt_extract adds <P>_SOLVE (the minigame). With
            // NO Active Access grant the access step hacks the server first,
            // surfaced as the shared SAI_HACK step.
            SAI_HACK: 'sai-hack',        // no Active Access grant → hack the server (install HACK sw + solve hack minigame)
            // ip_injection
            II_ACCESS: 'ii-access', II_INJECT: 'ii-inject', II_COMPLETE: 'ii-complete',
            // ip_cleanup
            IC_ACCESS: 'ic-access', IC_CLEANUP: 'ic-cleanup', IC_COMPLETE: 'ic-complete',
            // file_elimination
            FE_ACCESS: 'fe-access', FE_DELETE: 'fe-delete', FE_COMPLETE: 'fe-complete',
            // data_download
            DD_ACCESS: 'dd-access', DD_DOWNLOAD: 'dd-download', DD_COMPLETE: 'dd-complete',
            // data_upload
            DU_ACCESS: 'du-access', DU_UPLOAD: 'du-upload', DU_COMPLETE: 'du-complete',
            // log_download
            LG_ACCESS: 'lg-access', LG_DOWNLOAD: 'lg-download', LG_COMPLETE: 'lg-complete',
            // log_deletion
            LD_ACCESS: 'ld-access', LD_DELETE: 'ld-delete', LD_COMPLETE: 'ld-complete',
            // decrypt_extract (SAI download + decrypt-SW install/swap + minigame solve)
            DE_ACCESS: 'de-access', DE_DOWNLOAD: 'de-download', DE_INSTALL_SW: 'de-install-sw', DE_SOLVE: 'de-solve', DE_COMPLETE: 'de-complete',
            OPEN_ROUTE: 'open-route',              // hacking a transit gate to open the route to a server behind it (hackTransitNodes)
            MARK_AS_BUGGED: 'mark-as-bugged',      // job can't be done → written to AJ_BUGGED_JOBS
            DELAY_CYCLE: 'delay-cycle',
        },

        // "UI Show" master switches — popup panel visibility keys (the `uiShow`
        // group in AJ_MASTER_SWITCHES). ONE list shared by the chip row
        // (master-switches.js, chip label = i18n `autojobs.<key>`) and the
        // host-visibility map (section.js) so the two can't drift apart.
        UI_PANELS: ['networkMap', 'jobs', 'flowMap', 'activityLog'],

        // Loop cadence (matches the START→DELAY:10s→…→DELAY:30s flowchart).
        LOOP: {
            INITIAL_DELAY_MS: 10 * 1000,
            // Idle inter-cycle delay (nothing to do — empty board, or only
            // bugged / K-D-postponed work). The full "breathing room" pause.
            CYCLE_DELAY_MS: 30 * 1000,
            // Active inter-cycle delay — used instead of CYCLE_DELAY_MS when a
            // cycle did real work (a flow batch ran, or jobs were accepted that
            // become in-progress next refresh). Lets a chain of in-progress jobs
            // (e.g. several file_decryptions, run one per cycle) proceed without
            // 30s of dead air between each, while still pacing the market refresh
            // bursts and giving the server a beat to reflect the new state.
            CYCLE_DELAY_ACTIVE_MS: 5 * 1000,
            // Max time UPDATE_MARKETS waits for a refreshed market envelope to
            // land in storage before it logs loudly and moves on.
            MARKET_REFRESH_TIMEOUT_MS: 6 * 1000,
            // Gap between successive ACCEPT_JOB posts in JOB_ACCEPTION. MAIN's
            // __cor3AcceptJob serialises the bursts and does set.endpoint
            // preflight per remote market; we pace the posts so the
            // job.take RPCs don't pile up faster than the server accepts them
            // (a steady ~1.2s cadence).
            ACCEPT_PACING_MS: 1200,
            // Max time the orchestrator parks on a single JOB_FLOW dispatch
            // awaiting FLOW_RESULT before giving up and marking the job bugged.
            // Long because a decrypt minigame can take minutes.
            FLOW_TIMEOUT_MS: 5 * 60 * 1000,
            // Total JOB_FLOW attempts allowed for a TAKEN job before it is marked
            // bugged. 2 = one initial try + one retry next cycle. A transient
            // (retryable) failure is retried until this many attempts have failed,
            // then the job is written to AJ_BUGGED_JOBS (no TTL — permanent until
            // the user clears it). flow-busy / cancelled do not count as attempts.
            // The counter is kept in memory by the orchestrator (reset on STOP /
            // reload), not persisted.
            MAX_FLOW_ATTEMPTS: 2,
        },
    };

    // ──────────────────────────────────────────────────────────────────────
    // Market registry — the SINGLE source of truth for the game's markets,
    // shared across every context (MAIN interceptor routing, isolated data
    // modules, popup UI). Previously each market id was hardcoded in 5+ files.
    //   id       — market id (market.get.jobs / get.mercenaries / get.config use it)
    //   serverId — the market's home server (endpoint preflight + revert-to-home)
    //   key      — short slug; the WS bus channel is MARKET (home) or <KEY>_MARKET
    //   label    — display name (the in-game server name; a proper noun, not i18n'd)
    // Order is the display order in the UI.
    // ──────────────────────────────────────────────────────────────────────
    const MARKETS = [
        { id: '019d3ea4-85bd-7389-904d-8f7c85841134', serverId: '019c0a5b-eeeb-7d3e-b9c9-fd5c2ba7d399', key: 'home', label: 'Home Server' },
        { id: '019d3ea4-85bd-7389-904d-908ba9194aa0', serverId: '019d29c5-4b37-79bf-b23e-304d8ea03c15', key: 'dark', label: 'D4RK RM7MI' },
        { id: '019da731-2db5-7d76-9447-1ea3b9b78001', serverId: '019da6f1-16f7-75a6-b6d3-0b1d5f92a108', key: 'srm',  label: 'SRM7-M' },
        { id: '019e4065-6ae8-760d-8724-58ab4f2cf7d7', serverId: '019e4052-c317-7388-9d71-883ffb1560cd', key: 'usol', label: 'URM7-M' },
    ];
    const HOME_MARKET_ID = MARKETS[0].id;
    const HOME_SERVER_ID = MARKETS[0].serverId;

    root.COR3.constants = { MSG, STORAGE_LOCAL, STORAGE_SYNC, FLOW, LOG_LEVEL, CATEGORY, LIMITS, NO_LOGS_SERVERS, AJ, MARKETS, HOME_MARKET_ID, HOME_SERVER_ID };
})();
