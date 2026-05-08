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
    const FLOW = C.FLOW;

    // ─── Constants ────────────────────────────────────────────────────────
    const BUGGED_JOB_TTL_MS = C.LIMITS.BUGGED_JOB_TTL_MS;
    const STATE_TTL_MS      = C.LIMITS.AUTOJOBS_STATE_TTL_MS;
    const SENT_ACCEPT_TTL_MS = 3 * 60 * 1000;
    const COMPLETED_JOB_TTL_MS = 2 * 60 * 1000;
    const MARKET_REFRESH_INTERVAL_MS = 30 * 1000;
    const TICK_INTERVAL_MS = 5000;

    const IDLE_STATE = Object.freeze({
        status: 'idle', jobId: null, marketId: null, jobName: null,
        jobType: null, serverName: null, ips: null, fileCondition: null,
        fileNames: null, logSeqs: null,
    });

    const FILE_BASED_TYPES = new Set([
        FLOW.FILE_DECRYPTION, FLOW.FILE_UPLOAD || 'data_upload', FLOW.LOG_DELETION,
        FLOW.LOG_DOWNLOAD, FLOW.FILE_ELIMINATION, FLOW.DATA_DOWNLOAD, FLOW.DECRYPT_EXTRACT,
    ]);

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
    let settings = { enabled: false, debugMode: false, markets: { home: true, dark: true }, enabledJobTypes: {} };
    let serverPriorities = {};
    let state = { ...IDLE_STATE };
    let queue = [];
    let buggedJobs = {};
    const kdSkipServers = new Map();
    const sentAcceptIds = new Map();
    const completedJobIds = new Map();

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
    let modRef = null; // back-ref so helpers can log

    // ─── Storage glue ────────────────────────────────────────────────────
    function saveQueue() { Store.local.setOne(C.STORAGE_LOCAL.AUTOJOBS_QUEUE, queue); }
    function saveBugged() { Store.local.setOne(C.STORAGE_LOCAL.BUGGED_JOBS, buggedJobs); }
    function saveState() { Store.local.setOne(C.STORAGE_LOCAL.AUTOJOBS_STATE, { ...state, updatedAt: Date.now() }); }

    async function pushUserLog(msg, level = 'info') {
        const log = (await Store.local.getOne(C.STORAGE_LOCAL.AUTOJOBS_LOG, [])) || [];
        log.push({ ts: Date.now(), msg, level });
        if (log.length > C.LIMITS.AUTOJOBS_LOG_RING) log.splice(0, log.length - C.LIMITS.AUTOJOBS_LOG_RING);
        await Store.local.setOne(C.STORAGE_LOCAL.AUTOJOBS_LOG, log);
    }

    function resetState(reason) {
        if (state.status !== 'idle' && modRef) {
            modRef.debug(`state ${state.status}(${state.jobId || '—'}) → idle${reason ? ` [${reason}]` : ''}`);
        }
        state = { ...IDLE_STATE };
        saveState();
    }

    function bugJob(jobId, name, reason) {
        if (!jobId) return;
        buggedJobs[jobId] = { ts: Date.now(), name: name || 'Unknown' };
        saveBugged();
        if (modRef) modRef.warn(`bugged ${jobId} "${name || '?'}" — ${reason}`);
    }

    function parseKDTimerMs(timerText) {
        if (!timerText) return 6 * 3600 * 1000;
        const m = timerText.match(/(?:(\d+)H)?:?(?:(\d+)M)?/i);
        const h = parseInt((m && m[1]) || '0');
        const min = parseInt((m && m[2]) || '0');
        return (h * 60 + min + 5) * 60 * 1000;
    }

    function requestMarketRefresh(reason) {
        lastMarketRefreshAt = Date.now();
        if (modRef) modRef.debug(`market refresh [${reason || 'manual'}]`);
        Bus.window.post(MSG.GAME.REFRESH_MARKET, null);
        Bus.window.post(MSG.GAME.REFRESH_DARK_MARKET, null);
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
    async function findCandidates() {
        const result = await Store.local.get([
            C.STORAGE_LOCAL.MARKET, C.STORAGE_LOCAL.DARK_MARKET, C.STORAGE_LOCAL.DARK_MARKET_AVAILABLE,
        ]);
        const marketData = result[C.STORAGE_LOCAL.MARKET];
        const darkMarketData = result[C.STORAGE_LOCAL.DARK_MARKET];
        const darkMarketAvailable = result[C.STORAGE_LOCAL.DARK_MARKET_AVAILABLE];

        const homeJobsArr = marketData?.jobs;
        const darkJobsArr = darkMarketData?.jobs;
        if (sentAcceptIds.size > 0) {
            const cur = new Set([...(homeJobsArr?.map((j) => j.id) || []), ...(darkJobsArr?.map((j) => j.id) || [])]);
            for (const id of sentAcceptIds.keys()) if (!cur.has(id)) sentAcceptIds.delete(id);
        }

        const candidates = [];
        function scan(jobs, mid, source) {
            for (const job of jobs) {
                const type = detectJobType(job);
                if (!type) continue;
                if (settings.enabledJobTypes && settings.enabledJobTypes[type] === false) continue;
                const sentTs = sentAcceptIds.get(job.id);
                if (sentTs && Date.now() - sentTs < SENT_ACCEPT_TTL_MS) continue;
                if (buggedJobs[job.id]) {
                    const e = buggedJobs[job.id];
                    if (Date.now() - (e.ts || e) < BUGGED_JOB_TTL_MS) continue;
                    delete buggedJobs[job.id];
                }
                if (['ip_injection','ip_cleanup','data_upload','log_deletion','log_download','file_elimination','data_download','decrypt_extract'].includes(type)) {
                    const srvName = extractServerFromJob(job);
                    if (srvName) {
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
        if (settings.markets.home && marketData?.jobs) {
            const mid = marketData.market && marketData.market.id;
            if (mid) scan(marketData.jobs, mid, 'home');
        }
        if (settings.markets.dark && darkMarketAvailable !== false && darkMarketData?.jobs) {
            const mid = darkMarketData.market && darkMarketData.market.id;
            if (mid) scan(darkMarketData.jobs, mid, 'dark');
        }
        return candidates;
    }

    function acceptCandidatesBatch(candidates) {
        if (state.status !== 'idle') { modRef.warn('accept skipped — status not idle'); return; }
        if (!candidates.length) return;

        state = { ...IDLE_STATE, status: 'accepting', jobName: `Accepting ${candidates.length} job(s)` };
        saveState();
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
        if (!job.serverName || job.jobType === 'file_decryption') return Number.POSITIVE_INFINITY;
        const p = serverPriorities[job.serverName];
        return Number.isFinite(p) ? p : 0;
    }
    function sortQueueByPriority() { queue.sort((a, b) => jobPriority(b) - jobPriority(a)); }

    async function waitForUserConfirmation(confirmData, timeoutMs = 300000) {
        const ts = Date.now();
        await Store.local.set({
            [C.STORAGE_LOCAL.AUTOJOBS_PENDING_CONFIRM]: { ...confirmData, ts },
            [C.STORAGE_LOCAL.AUTOJOBS_CONFIRM_RESULT]: null,
        });
        return new Promise((resolve) => {
            const deadline = ts + timeoutMs;
            async function check() {
                const cfr = await Store.local.getOne(C.STORAGE_LOCAL.AUTOJOBS_CONFIRM_RESULT);
                if (cfr && cfr.requestTs === ts) {
                    await Store.local.remove([C.STORAGE_LOCAL.AUTOJOBS_PENDING_CONFIRM, C.STORAGE_LOCAL.AUTOJOBS_CONFIRM_RESULT]);
                    resolve(cfr.approved === true);
                } else if (Date.now() >= deadline) {
                    await Store.local.remove(C.STORAGE_LOCAL.AUTOJOBS_PENDING_CONFIRM);
                    resolve(false);
                } else {
                    setTimeout(check, 500);
                }
            }
            check();
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
        pushUserLog(`━━━ ${job.jobName || job.jobType} [${job.jobType}] ━━━`, 'separator');

        if (settings.debugMode && FILE_BASED_TYPES.has(job.jobType)) {
            pushUserLog('Debug: waiting for confirmation in popup (5 min)…', 'warn');
            const ok = await waitForUserConfirmation({
                jobType: job.jobType, jobName: job.jobName, serverName: job.serverName,
                fileCondition: job.fileCondition, logSeqs: job.logSeqs || null, ips: job.ips || null,
            });
            if (!ok) {
                pushUserLog('Debug: rejected/timeout — drop (60s cooldown)', 'warn');
                queue.shift(); saveQueue();
                cooldownUntil = Date.now() + 60000;
                resetState();
                return;
            }
            pushUserLog('Debug: confirmed — starting flow', 'ok');
        }

        setTimeout(() => dispatchSolveFlow(job), 500);
    }

    // ─── Resume in-progress (TAKEN jobs after market refresh) ─────────────
    async function tryResumeInProgress() {
        if (state.status !== 'idle') return;
        const now = Date.now();
        for (const [id, ts] of completedJobIds) if (now - ts > COMPLETED_JOB_TTL_MS) completedJobIds.delete(id);

        const result = await Store.local.get([
            C.STORAGE_LOCAL.MARKET, C.STORAGE_LOCAL.DARK_MARKET, C.STORAGE_LOCAL.DARK_MARKET_AVAILABLE,
        ]);
        function collectTaken(data, mid, out) {
            if (!data || !mid) return;
            for (const job of (data.recentJobs || [])) {
                if (job.status !== 'TAKEN') continue;
                const type = detectJobType(job);
                if (!type) continue;
                if (settings.enabledJobTypes && settings.enabledJobTypes[type] === false) continue;
                if (buggedJobs[job.id]) continue;
                out.push({ ...job, marketId: mid, type });
            }
        }
        const taken = [];
        const m = result[C.STORAGE_LOCAL.MARKET];
        const dm = result[C.STORAGE_LOCAL.DARK_MARKET];
        if (settings.markets.home && m?.market?.id) collectTaken(m, m.market.id, taken);
        if (settings.markets.dark && result[C.STORAGE_LOCAL.DARK_MARKET_AVAILABLE] !== false && dm?.market?.id) collectTaken(dm, dm.market.id, taken);

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
        // Watchdogs
        if (state.status === 'accepting' && bulkAcceptStartedAt > 0 && Date.now() - bulkAcceptStartedAt > 60000) {
            modRef.warn('accept watchdog 60s — reset');
            pushUserLog('Accept watchdog — reset to idle', 'warn');
            saveQueue();
            bulkPendingJobs = []; bulkSentOrder = []; bulkAcceptCount = 0; bulkAcceptTotal = 0; bulkAcceptStartedAt = 0;
            resetState();
            if (queue.length > 0) setTimeout(executeNextFromQueue, 1000);
            return;
        }
        if (state.status === 'solving' && solvingStartedAt > 0 && Date.now() - solvingStartedAt > 180000) {
            modRef.warn('solving watchdog 3min — bug & reset');
            if (state.jobId) {
                bugJob(state.jobId, state.jobName || state.jobType || 'Unknown', 'solving watchdog 3min');
                const qi = queue.findIndex((j) => j.jobId === state.jobId);
                if (qi !== -1) { queue.splice(qi, 1); saveQueue(); }
            }
            solvingStartedAt = 0;
            Bus.window.post(MSG.JOB.ABORT, null);
            resetState('solving-watchdog');
            if (queue.length > 0) setTimeout(executeNextFromQueue, 3000);
            return;
        }
        if (state.status === 'completing' && completingStartedAt > 0 && Date.now() - completingStartedAt > 45000) {
            modRef.warn('completing watchdog 45s — reset');
            pushUserLog('Completion watchdog — reset to idle', 'warn');
            completingStartedAt = 0;
            resetState();
            setTimeout(() => requestMarketRefresh('completing-watchdog'), 1000);
            return;
        }

        if (Date.now() < cooldownUntil) return;

        if (!settings.debugMode && queue.length > 0 && state.status === 'idle') {
            executeNextFromQueue();
            return;
        }
        if (settings.debugMode) return;
        if (state.status !== 'idle') return;
        if (Date.now() - lastMarketRefreshAt > MARKET_REFRESH_INTERVAL_MS) {
            requestMarketRefresh('idle-poll');
        }
        const candidates = await findCandidates();
        if (candidates.length > 0) acceptCandidatesBatch(candidates);
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
                        C.STORAGE_LOCAL.AUTOJOBS_LOG, C.STORAGE_LOCAL.BUGGED_JOBS,
                        C.STORAGE_LOCAL.AUTOJOBS_PENDING_CONFIRM, C.STORAGE_LOCAL.AUTOJOBS_CONFIRM_RESULT,
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
            const local = await Store.local.get([C.STORAGE_LOCAL.AUTOJOBS_STATE, C.STORAGE_LOCAL.BUGGED_JOBS, C.STORAGE_LOCAL.AUTOJOBS_QUEUE]);
            if (local[C.STORAGE_LOCAL.AUTOJOBS_STATE] && local[C.STORAGE_LOCAL.AUTOJOBS_STATE].status !== 'idle') {
                const ls = local[C.STORAGE_LOCAL.AUTOJOBS_STATE];
                const age = Date.now() - (ls.updatedAt || 0);
                if (ls.status === 'accepting') {
                    Store.local.setOne(C.STORAGE_LOCAL.AUTOJOBS_STATE, { status: 'idle', updatedAt: Date.now() });
                } else if (age < STATE_TTL_MS) {
                    state = ls;
                    this.info(`restored state ${state.status} ${state.jobId || ''}`);
                } else {
                    Store.local.setOne(C.STORAGE_LOCAL.AUTOJOBS_STATE, { status: 'idle', updatedAt: Date.now() });
                }
            }
            if (local[C.STORAGE_LOCAL.BUGGED_JOBS]) {
                const now = Date.now();
                buggedJobs = {};
                for (const [id, e] of Object.entries(local[C.STORAGE_LOCAL.BUGGED_JOBS])) {
                    if (now - (e.ts || e) < BUGGED_JOB_TTL_MS) buggedJobs[id] = e;
                }
            }
            if (Array.isArray(local[C.STORAGE_LOCAL.AUTOJOBS_QUEUE])) {
                queue = local[C.STORAGE_LOCAL.AUTOJOBS_QUEUE].filter((j) => !buggedJobs[j.jobId]);
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

            // Market arrivals → maybe scan / resume
            this.track(Bus.window.on(C.MSG.WS.MARKET, () => {
                if (settings.enabled && !settings.debugMode) {
                    setTimeout(() => tryResumeInProgress(), 500);
                    if (state.status === 'idle') setTimeout(tick, 2000);
                }
            }));
            this.track(Bus.window.on(C.MSG.WS.DARK_MARKET, () => {
                if (settings.enabled && !settings.debugMode) {
                    setTimeout(() => tryResumeInProgress(), 500);
                    if (state.status === 'idle') setTimeout(tick, 2000);
                }
            }));

            // WS_JOB_ACCEPTED handler
            this.track(Bus.window.on(C.MSG.WS.JOB_ACCEPTED, (env) => this.onJobAccepted(env)));
            this.track(Bus.window.on('COR3_ACCEPT_JOB_SEND_FAILED', (env) => this.onAcceptSendFailed(env)));
            this.track(Bus.window.on(C.MSG.WS.JOB_COMPLETED, (env) => this.onJobCompleted(env)));
            this.track(Bus.window.on(C.MSG.JOB.MINIGAME_DONE, (env) => this.onMinigameDone(env)));
            this.track(Bus.window.on(C.MSG.JOB.MINIGAME_TIMEOUT, (env) => this.onMinigameTimeout(env)));
            this.track(Bus.window.on(C.MSG.JOB.KD_DETECTED, (env) => this.onKdDetected(env)));
            this.track(Bus.window.on(C.MSG.JOB.SERVER_UNREACHABLE, (env) => this.onServerUnreachable(env)));
            this.track(Bus.window.on(C.MSG.GAME.NM_SERVERS, (env) => this.onNmServers(env)));
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
                Bus.window.post(C.MSG.GAME.REQUEST_NM_SERVERS, null);
                return { success: true };
            }));
            this.track(Bus.runtime.on('clearBuggedJobs', () => {
                buggedJobs = {}; saveBugged();
                return { success: true };
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
            if (settings.enabled) {
                if (!monitorIntervalId) {
                    monitorIntervalId = setInterval(tick, TICK_INTERVAL_MS);
                    tryResumeInProgress();
                }
                Bus.window.post(C.MSG.JOB.AUTOJOBS_ACTIVE_CHANGED, { active: true });
                setTimeout(() => {
                    Bus.window.post(C.MSG.GAME.OPEN_NETWORK_MAP, null);
                    Bus.window.post(C.MSG.GAME.OPEN_MARKET_JOBS, {
                        home: settings.markets.home !== false,
                        dark: settings.markets.dark !== false,
                    });
                    requestMarketRefresh('autojobs-toggle-on');
                }, 800);
            } else {
                if (monitorIntervalId) { clearInterval(monitorIntervalId); monitorIntervalId = null; }
                queue = []; bulkPendingJobs = []; bulkSentOrder = []; bulkAcceptCount = 0; bulkAcceptTotal = 0;
                bulkAcceptStartedAt = 0;
                saveQueue();
                Bus.window.post(C.MSG.JOB.ABORT, null);
                Bus.window.post(C.MSG.JOB.AUTOJOBS_ACTIVE_CHANGED, { active: false });
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
                resetState('accept-batch-complete');
                setTimeout(() => requestMarketRefresh('accept-batch-done'), 500);
                setTimeout(executeNextFromQueue, 1000);
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
                resetState('accept-batch-complete');
                setTimeout(() => requestMarketRefresh('accept-batch-done'), 500);
                setTimeout(executeNextFromQueue, 1000);
            }
        }

        onJobCompleted(env) {
            if (state.status !== 'completing') return;
            if (env.error) {
                const errMsg = typeof env.error === 'string' ? env.error : (env.error?.message || JSON.stringify(env.error));
                pushUserLog('Complete failed: ' + errMsg, 'error');
            } else {
                pushUserLog('Job completed!', 'ok');
            }
            const completedJobId = state.jobId;
            if (completedJobId) completedJobIds.set(completedJobId, Date.now());
            resetState();
            const qi = queue.findIndex((j) => j.jobId === completedJobId);
            if (qi !== -1) { queue.splice(qi, 1); saveQueue(); }
            setTimeout(() => requestMarketRefresh('job-completed'), 2000);
            if (queue.length > 0) setTimeout(executeNextFromQueue, 3000);
        }

        onMinigameDone(env) {
            if (state.status === 'solving' && env.jobId === state.jobId) {
                pushUserLog('Task solved — sending complete', 'ok');
                state.status = 'completing';
                solvingStartedAt = 0;
                completingStartedAt = Date.now();
                saveState();
                setTimeout(() => Bus.window.post('COR3_COMPLETE_JOB', { jobId: state.jobId, marketId: state.marketId }),
                    2000 + Math.floor(Math.random() * 1000));
            }
        }

        onMinigameTimeout(env) {
            if (state.status !== 'solving') return;
            const timedOut = state.jobId;
            if (timedOut) {
                bugJob(timedOut, state.jobName || state.jobType || 'Unknown', 'minigame timeout');
                pushUserLog(`Timeout: "${state.jobName || state.jobType}" — bugged, skipping`, 'warn');
                const qi = queue.findIndex((j) => j.jobId === timedOut);
                if (qi !== -1) { queue.splice(qi, 1); saveQueue(); }
            }
            cooldownUntil = Date.now() + 20000;
            solvingStartedAt = 0;
            resetState('minigame-timeout');
            setTimeout(() => requestMarketRefresh('minigame-timeout'), 2000);
            if (queue.length > 0) setTimeout(executeNextFromQueue, 22000);
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
            let skipMs = 30 * 60 * 1000;
            if (Array.isArray(blockedByKD) && blockedByKD.length > 0) {
                for (const { serverName: kdName, timerText } of blockedByKD) {
                    const kdMs = parseKDTimerMs(timerText);
                    kdSkipServers.set(kdName, Date.now() + kdMs);
                    pushUserLog(`K/D "${kdName}" (${timerText || '?'}) blocking path to "${serverName}"`, 'warn');
                    skipMs = Math.max(skipMs, kdMs);
                }
            }
            kdSkipServers.set(serverName, Date.now() + skipMs);
            pushUserLog(`Server "${serverName}" unreachable — skip ${Math.round(skipMs / 60000)} min`, 'warn');
            if (state.status === 'solving') {
                solvingStartedAt = 0;
                resetState();
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

        onJobManagerReady() {
            jobManagerReady = true;
            this.info('job-manager ready');
            Store.local.remove([C.STORAGE_LOCAL.AUTOJOBS_PENDING_CONFIRM, C.STORAGE_LOCAL.AUTOJOBS_CONFIRM_RESULT]);
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
