// src/modules/automation/auto-jobs/reachability.js
// Pre-flight reachability evaluation for the auto-jobs orchestrator.
//
// Phase 2 (log-only): publishes the snapshot to STORAGE_LOCAL.AJ_REACHABILITY
// so the UI map and planner can read it. No behavioural enforcement —
// auto-jobs.js still uses its existing findCandidates filter. The planner
// surfaces verdicts to the activity log only.
//
// Phase 3 will turn this snapshot into the gating signal for
// STATE_CHECK_JOB_CONDITIONS and STATE_DLM_FIX_*.
//
// Relies on:
//   - STORAGE_LOCAL.NM_GRAPH (carries depth + parentName + isInMaintenance
//     per server, enriched by ws-interceptor.js computeNmGraph).
//   - STORAGE_LOCAL.MARKET / DARK_MARKET / SRM_MARKET (each with marketId).
//   - STORAGE_LOCAL.AJ_SERVER_CAPS (lazy-learned; e.g. {hasLogs: false}).

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    if (!root.COR3 || !root.COR3.constants) return;
    const { Store, constants: C } = root.COR3;
    const SL = C.STORAGE_LOCAL;

    const MARKET_KEY_TO_DATA = {
        home: SL.MARKET,
        dark: SL.DARK_MARKET,
        srm:  SL.SRM_MARKET,
    };

    // Reconstruct the HOME → server hop list from NM_GRAPH.parentName.
    // Returns [] when the server isn't in the graph; a single-element [name]
    // when the server itself IS the root (no parent).
    function pathToServer(graph, serverName) {
        if (!graph || !Array.isArray(graph.servers)) return [];
        const byName = new Map(graph.servers.map((s) => [s.name, s]));
        const path = [];
        let cur = byName.get(serverName);
        let safety = 64; // worst-case ring guard
        while (cur && safety-- > 0) {
            path.unshift(cur.name);
            if (!cur.parentName) break;
            cur = byName.get(cur.parentName);
        }
        return path;
    }

    // Resolve which graph node serves as the destination for a market key.
    // Each market envelope (home/dark/srm) has a marketId; the matching
    // graph server has the same marketId.
    async function resolveMarketServer(graph, marketKey) {
        const dataKey = MARKET_KEY_TO_DATA[marketKey];
        if (!dataKey || !graph || !Array.isArray(graph.servers)) return null;
        const data = await Store.local.getOne(dataKey, null);
        if (!data || !data.marketId) return null;
        return graph.servers.find((s) => s.marketId === data.marketId) || null;
    }

    // Walk a path and collect blockers. Phase 2 uses NM_GRAPH's isInMaintenance
    // flag (sourced from the WS payload) — no timer text is available without
    // a DOM probe, but we *know* the server is in K/D. Phase 3 can extend
    // this with the timer-text parsing already living in network-map.js
    // (checkServerKD) by routing a request through Bus to MAIN.
    function collectBlockers(graph, path) {
        if (!Array.isArray(path) || path.length === 0) return [];
        const byName = new Map(graph.servers.map((s) => [s.name, s]));
        const blockers = [];
        for (const name of path) {
            const node = byName.get(name);
            if (!node) continue;
            if (node.isInMaintenance) {
                blockers.push({ serverName: name, kind: 'kd', isInMaintenance: true });
            }
        }
        return blockers;
    }

    async function evaluateMarket(marketKey) {
        const graph = await Store.local.getOne(SL.NM_GRAPH, null);
        if (!graph) {
            return { reachable: false, marketKey, marketServerName: null, blockers: [], path: [], reason: 'no-nm-graph' };
        }
        const target = await resolveMarketServer(graph, marketKey);
        if (!target) {
            return { reachable: false, marketKey, marketServerName: null, blockers: [], path: [], reason: 'market-server-not-in-graph' };
        }
        const path = pathToServer(graph, target.name);
        const blockers = collectBlockers(graph, path);
        return {
            reachable: blockers.length === 0,
            marketKey,
            marketServerName: target.name,
            blockers,
            path,
            // Phase 2 placeholder — no per-node hack-tool inference yet.
            hackToolNeeded: false,
        };
    }

    async function evaluateServer(serverName) {
        const graph = await Store.local.getOne(SL.NM_GRAPH, null);
        if (!graph || !serverName) {
            return { reachable: false, serverName, kdOnSelf: false, kdOnPath: [], hackToolNeeded: false, path: [], reason: 'no-nm-graph' };
        }
        const node = graph.servers.find((s) => s.name === serverName);
        if (!node) {
            return { reachable: false, serverName, kdOnSelf: false, kdOnPath: [], hackToolNeeded: false, path: [], reason: 'server-not-in-graph' };
        }
        const path = pathToServer(graph, serverName);
        const blockers = collectBlockers(graph, path);
        const kdOnSelf = !!node.isInMaintenance;
        const kdOnPath = blockers.filter((b) => b.serverName !== serverName);
        return {
            reachable: blockers.length === 0,
            serverName,
            kdOnSelf,
            kdOnPath,
            hackToolNeeded: false, // Phase 3
            path,
        };
    }

    async function computeAndPersist() {
        const [home, dark, srm] = await Promise.all([
            evaluateMarket('home'),
            evaluateMarket('dark'),
            evaluateMarket('srm'),
        ]);
        const snapshot = {
            computedAt: Date.now(),
            markets: { home, dark, srm },
        };
        try {
            await Store.local.setOne(SL.AJ_REACHABILITY, snapshot);
        } catch (_) { /* storage may be unavailable in some contexts */ }
        return snapshot;
    }

    root.COR3.autoJobs = root.COR3.autoJobs || {};
    root.COR3.autoJobs.reachability = {
        evaluateMarket,
        evaluateServer,
        computeAndPersist,
        pathToServer,
        resolveMarketServer,
    };
})();
