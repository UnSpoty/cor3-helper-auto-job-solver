// Per-job verdict for STATE_CHECK_JOB_CONDITIONS. Verdicts are enforced —
// the orchestrator's CHECK_JOB_CONDITIONS state uses this output verbatim
// to decide what enters TAKE_ALL_VALID_JOBS.
//
// Verdict reasons (kebab-case, stable for log grepping):
//   accept
//   reject:no-server                — job names a server but extractor returned null
//   reject:server-skip              — user manually skipped this server (priorities='skip')
//   reject:server-kd                — server itself is in K/D (NM_GRAPH.isInMaintenance)
//   reject:path-kd                  — at least one transit node is in K/D
//   reject:no-logs-section          — log_* job targeting a server hardcoded in
//                                     C.NO_LOGS_SERVERS (D4RK ones without a
//                                     Logs tab in-game)
//   reject:already-rejected         — job already in AJ_REJECTED_JOBS map
//   reject:bugged                   — job in buggedJobs map and TTL still active
//   reject:unknown-type             — job type doesn't map to any flow
//   reject:no-access                — AJ_SERVER_READINESS marks server canAccess=false
//   reject:path-no-access           — at least one transit node has canAccess=false

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    if (!root.COR3 || !root.COR3.constants) return;
    const { Store, constants: C } = root.COR3;
    const SL = C.STORAGE_LOCAL;

    const KNOWN_JOB_TYPES = new Set([
        'file_decryption', 'ip_injection', 'ip_cleanup', 'data_upload',
        'log_deletion', 'log_download', 'file_elimination', 'data_download',
        'decrypt_extract',
    ]);

    const LOG_FLOW_TYPES = new Set(['log_deletion', 'log_download']);
    const NO_LOGS_SERVERS = new Set(C.NO_LOGS_SERVERS || []);

    function isFiniteBuggedActive(entry, now) {
        if (!entry) return false;
        const ttl = entry.ttl || (C.LIMITS && C.LIMITS.BUGGED_JOB_TTL_MS) || 0;
        if (!ttl) return false;
        const ts = entry.ts || entry;
        return (now - ts) < ttl;
    }

    /**
     * Per-job verdict.
     *
     * @param {object} job              - Candidate job object as built by findCandidates:
     *                                    { id, marketId, type, name?, … } and (when known)
     *                                    a `serverName` resolved by extractServerFromJob.
     * @param {object} ctx              - Pre-loaded context bundle (see filterCandidates).
     * @returns {object} { accept, reason, severity }
     */
    function evaluateJob(job, ctx) {
        if (!job || !job.id) return { accept: false, reason: 'reject:no-job', severity: 'warn' };

        const type = job.type;
        if (!type || !KNOWN_JOB_TYPES.has(type)) {
            return { accept: false, reason: 'reject:unknown-type', severity: 'warn' };
        }

        // Already permanently rejected this cycle.
        if (ctx && ctx.rejected && ctx.rejected[job.id]) {
            return { accept: false, reason: 'reject:already-rejected', severity: 'info' };
        }

        if (ctx && ctx.bugged && ctx.bugged[job.id]) {
            if (isFiniteBuggedActive(ctx.bugged[job.id], ctx.now)) {
                return { accept: false, reason: 'reject:bugged', severity: 'info' };
            }
        }

        const serverName = job.serverName || (ctx && ctx.extractServer && ctx.extractServer(job)) || null;
        const needsServer = type !== 'file_decryption';

        if (needsServer) {
            if (!serverName) return { accept: false, reason: 'reject:no-server', severity: 'warn' };

            if (ctx && ctx.serverPriorities && ctx.serverPriorities[serverName] === 'skip') {
                return { accept: false, reason: 'reject:server-skip', severity: 'info' };
            }

            if (ctx && ctx.kdSkipServers && ctx.kdSkipServers.has && ctx.kdSkipServers.has(serverName)) {
                const expiry = ctx.kdSkipServers.get(serverName);
                if (ctx.now < expiry) return { accept: false, reason: 'reject:server-kd', severity: 'info' };
            }

            if (ctx && ctx.graphByName) {
                const node = ctx.graphByName.get(serverName);
                if (node && node.isInMaintenance) {
                    return { accept: false, reason: 'reject:server-kd', severity: 'info' };
                }
                // Path K/D: the server itself is fine, but at least one
                // transit node on the way to it is in maintenance.
                if (ctx.pathHasKD && ctx.pathHasKD(serverName)) {
                    return { accept: false, reason: 'reject:path-kd', severity: 'info' };
                }
            }

            // Readiness gate. AJ_SERVER_READINESS is populated by
            // server-connect's preflight detection — when a server has
            // neither Active Access nor Hack Tools, we mark it
            // canAccess=false and stop trying jobs against it. Includes a
            // transitive path check so a server BEHIND an unreachable
            // node is rejected up front instead of failing at connect time.
            if (ctx && ctx.readinessFor) {
                const r = ctx.readinessFor(serverName);
                if (r && r.canAccess === false) {
                    return { accept: false, reason: 'reject:no-access', severity: 'info' };
                }
                if (ctx.pathHasNoAccess && ctx.pathHasNoAccess(serverName)) {
                    return { accept: false, reason: 'reject:path-no-access', severity: 'info' };
                }
            }

            // Hardcoded D4RK no-logs list: these servers don't expose a
            // Logs tab in-game, so log_* jobs are never satisfiable there.
            // Source-of-truth is C.NO_LOGS_SERVERS — bump it if the game
            // ships another D4RK server without Logs.
            if (LOG_FLOW_TYPES.has(type) && NO_LOGS_SERVERS.has(serverName)) {
                return { accept: false, reason: 'reject:no-logs-section', severity: 'info' };
            }
        }

        return { accept: true, reason: 'accept', severity: 'info' };
    }

    /**
     * Run the verdicts across a candidate list. Returns the same shape used
     * by auto-jobs.js findCandidates plus a `rejected` array; the caller
     * drops `rejected` from the accept-batch.
     */
    function filterCandidates(candidates, ctx) {
        const accepted = [];
        const rejected = [];
        for (const job of (candidates || [])) {
            const v = evaluateJob(job, ctx);
            if (v.accept) accepted.push(job);
            else rejected.push({ job, reason: v.reason, severity: v.severity });
        }
        return { accepted, rejected };
    }

    /**
     * Build the planner context for a single planning pass. Reads the
     * needed storage keys + builds in-memory derivatives (graph-by-name
     * map, path-K/D lookup) so per-job evaluation is fast.
     *
     * Caller is expected to pass live runtime maps that aren't stored:
     *   { kdSkipServers, serverPriorities, bugged }
     */
    async function buildContext(runtime) {
        const [graph, rejected, readiness] = await Promise.all([
            Store.local.getOne(SL.NM_GRAPH, null),
            Store.local.getOne(SL.AJ_REJECTED_JOBS, {}),
            Store.local.getOne(SL.AJ_SERVER_READINESS, {}),
        ]);
        const graphByName = new Map();
        if (graph && Array.isArray(graph.servers)) {
            for (const s of graph.servers) graphByName.set(s.name, s);
        }
        function pathHasKD(name) {
            const visited = new Set();
            let cur = graphByName.get(name);
            let safety = 64;
            while (cur && safety-- > 0) {
                if (visited.has(cur.name)) break;
                visited.add(cur.name);
                if (cur.name !== name && cur.isInMaintenance) return true;
                if (!cur.parentName) break;
                cur = graphByName.get(cur.parentName);
            }
            return false;
        }
        // Readiness lookup with TTL. Anything older than READINESS_TTL_MS
        // is treated as unknown — we'd rather try and fail than block on
        // stale data. canAccess: undefined → unknown (allow); === true → ok;
        // === false within TTL → block.
        const READINESS_TTL_MS = 15 * 60 * 1000;
        const now = Date.now();
        function readinessFor(name) {
            const r = (readiness && readiness[name]) || null;
            if (!r) return null;
            if (r.checkedAt && (now - r.checkedAt) > READINESS_TTL_MS) return null;
            return r;
        }
        // Same parentName walk as pathHasKD but checks readiness on
        // every transit node. A node we marked canAccess=false acts as a
        // hard chain blocker just like K/D — every server behind it is
        // implicitly unusable.
        function pathHasNoAccess(name) {
            const visited = new Set();
            let cur = graphByName.get(name);
            let safety = 64;
            while (cur && safety-- > 0) {
                if (visited.has(cur.name)) break;
                visited.add(cur.name);
                if (cur.name !== name) {
                    const r = readinessFor(cur.name);
                    if (r && r.canAccess === false) return true;
                }
                if (!cur.parentName) break;
                cur = graphByName.get(cur.parentName);
            }
            return false;
        }
        return {
            now,
            graph, graphByName, pathHasKD, pathHasNoAccess, readinessFor,
            readiness: readiness || {},
            rejected: rejected || {},
            kdSkipServers: (runtime && runtime.kdSkipServers) || null,
            serverPriorities: (runtime && runtime.serverPriorities) || {},
            bugged: (runtime && runtime.bugged) || {},
            extractServer: (runtime && runtime.extractServer) || null,
        };
    }

    /**
     * Format a rejected list for the activity log. Keeps lines short so a
     * batch of 10 candidates doesn't flood the popup.
     */
    function summarizeRejected(rejected) {
        if (!Array.isArray(rejected) || rejected.length === 0) return null;
        const byReason = {};
        for (const r of rejected) {
            byReason[r.reason] = (byReason[r.reason] || 0) + 1;
        }
        return Object.entries(byReason).map(([k, n]) => `${k}=${n}`).join(', ');
    }

    root.COR3.autoJobs = root.COR3.autoJobs || {};
    root.COR3.autoJobs.planner = {
        evaluateJob,
        filterCandidates,
        buildContext,
        summarizeRejected,
    };
})();
