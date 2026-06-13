// Auto Jobs — shared Network-Map reachability + transit-gate model.
//
// Loaded into the isolated content world (before pipeline.js) AND the popup
// (after aj-eligibility.js) — the SAME cross-world sharing mechanism as
// aj-eligibility.js, because pipeline.js is not loaded in the popup. ONE copy
// of the reachability logic so the pipeline's enforced verdict and the popup's
// displayed verdict can never drift.
//
// REACHABILITY VERDICT — `reachableSet` is a transit-rule BFS from HOME, NOT the
// game's `canSetEndpoint` flag. We tried the flag (it matched a one-shot BFS
// 39/39 on a static snapshot) but it is STALE on transient state: when a transit
// node goes K/D, `isInMaintenance` flips live but `canSetEndpoint` does NOT
// recompute, so a server reachable only through that node keeps `canSetEndpoint:
// true` while the game's actual `set.endpoint` returns `no-path-to-server`
// (verified live 4/4: RM7-N2L2 / SRM7-M / RM7-W3NCP → no-path despite
// canSetEndpoint:true). The BFS, recomputed each cycle off the live
// `isInMaintenance`/`transitType`/`accessType`, matches `set.endpoint`. A server
// is reachable iff a path of TRANSITABLE relays leads to it (it may itself be a
// non-transitable endpoint — that is what lets us connect to a gate to hack it).
//
// TRANSIT-GATE MODEL — the game's routing rule (dev-confirmed, live-validated):
// you can route THROUGH a node N iff `transitType==='public'` OR you hold
// transit/SAI access to it (`accessType!=='none'`), AND it is not in
// maintenance. A non-public node you have no access to is a hard transit
// blocker — every server reachable only through it is unconnectable
// (canSetEndpoint:false). `gateOnPath` walks the topology to find the nearest
// such blocker on the route to an unreachable target: the node we could HACK to
// gain access and open the route. (Whether we actually CAN hack it — owned
// software clearing its defence on current hardware — is decided in MAIN by
// COR3.game.loadout.planHack; this module only finds WHICH node gates the
// route.)

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    root.COR3 = root.COR3 || {};
    root.COR3.autoJobs = root.COR3.autoJobs || {};
    if (root.COR3.autoJobs.reachability) return;

    // Set of server names we can set.endpoint to right now — a transit-rule BFS
    // from HOME: relay THROUGH a node only if it is transitable (canTransit), but
    // a non-transitable node is still added as an ENDPOINT (so a gate we'd hack is
    // "reachable"). noPath for a server === NOT in here. Uses the LIVE
    // isInMaintenance/transitType/accessType, so a freshly-K/D'd transit node cuts
    // off everything behind it the same cycle (which the stale canSetEndpoint flag
    // does not). connections/homeName are required — a caller without them is a
    // bug, not a degradable state.
    function reachableSet(servers, connections, homeName) {
        const byName = new Map();
        for (const s of servers) if (s && s.name) byName.set(s.name, s);
        const reached = new Set();
        if (!byName.has(homeName)) return reached;   // no HOME → nothing reachable (caller hard-requires home)
        const adj = buildAdj(connections);
        reached.add(homeName);
        const queue = [homeName];
        while (queue.length) {
            const curName = queue.shift();
            const cur = byName.get(curName);
            // Expand (relay) only THROUGH a transitable node; a non-transitable
            // node stays an endpoint-only leaf, so servers reachable ONLY past it
            // remain unreached.
            if (curName !== homeName && !canTransit(cur, homeName)) continue;
            for (const n of (adj.get(curName) || [])) {
                if (!reached.has(n)) { reached.add(n); queue.push(n); }
            }
        }
        return reached;
    }

    // Build an undirected adjacency map (name → [names]) from the NM_GRAPH
    // edge list ({ a, b }). Hidden gateways included — the game routes through
    // them too.
    function buildAdj(connections) {
        const adj = new Map();
        const link = (a, b) => { let l = adj.get(a); if (!l) adj.set(a, l = []); l.push(b); };
        for (const c of (connections || [])) {
            if (!c || !c.a || !c.b) continue;
            link(c.a, c.b);
            link(c.b, c.a);
        }
        return adj;
    }

    // Can the game relay THROUGH this node (it being an intermediate hop)?
    // HOME always; otherwise public OR we have access, and not in maintenance.
    function canTransit(s, homeName) {
        if (!s) return false;
        if (s.name === homeName) return true;
        if (s.isInMaintenance) return false;
        return s.transitType === 'public' || (typeof s.accessType === 'string' && s.accessType !== 'none');
    }

    // Is this node a transit blocker we could OPEN by hacking — i.e. non-public,
    // no access, and not in maintenance (a K/D node can't be hacked-to-transit)?
    function isOpenableGate(s, homeName) {
        if (!s || s.name === homeName) return false;
        if (s.isInMaintenance) return false;
        if (s.transitType === 'public') return false;
        return !(typeof s.accessType === 'string' && s.accessType !== 'none');
    }

    // For an UNREACHABLE target (canSetEndpoint:false), find the nearest node on
    // the HOME→target route that we could hack to open the path. Returns
    // { id, name, serverType, serverDefenceRate } or null when no openable gate
    // exists (e.g. the only blocker is a K/D node — then the route is genuinely
    // dead this cycle).
    //
    // Does its OWN transit-rule BFS — it must NOT rely on the shipped parentName
    // (that comes from a plain all-edges BFS with no transit rule and an
    // arbitrary parent for multi-parent nodes, so it can point through a
    // non-transitable node or miss the openable gate). The BFS may relay through
    // transitable nodes AND through openable gates (the ones we'd hack); the gate
    // to open is the FIRST openable-gate node on the reconstructed path — every
    // node before it is transitable, so that gate is itself reachable-as-endpoint
    // right now (we can connect to it to hack it). A multi-gate route resolves
    // one gate per cycle: open the nearest, next cycle finds the next.
    function gateOnPath(servers, connections, homeName, targetName) {
        const byName = new Map();
        for (const s of servers) if (s && s.name) byName.set(s.name, s);
        if (!byName.has(homeName) || !byName.has(targetName)) return null;
        const adj = buildAdj(connections);

        const parent = new Map([[homeName, null]]);
        const queue = [homeName];
        while (queue.length) {
            const curName = queue.shift();
            const cur = byName.get(curName);
            // Expand only from nodes the route can pass THROUGH: HOME, a
            // transitable node, or an openable gate (which we'd hack). A K/D /
            // unknown blocker is never expanded, so anything only behind it stays
            // unreachable (null gate → hard noPath).
            if (curName !== homeName && !canTransit(cur, homeName) && !isOpenableGate(cur, homeName)) continue;
            for (const n of (adj.get(curName) || [])) {
                if (!parent.has(n)) { parent.set(n, curName); queue.push(n); }
            }
        }
        if (!parent.has(targetName)) return null;

        // Reconstruct HOME → target and return the first openable gate on it.
        const path = [];
        let cur = targetName;
        while (cur != null) { path.unshift(cur); cur = parent.get(cur); }
        for (const name of path) {
            const s = byName.get(name);
            if (isOpenableGate(s, homeName)) {
                return {
                    id: s.id || null,
                    name: s.name,
                    serverType: s.serverTypeName || null,
                    serverDefenceRate: Number.isFinite(s.serverDefenceRate) ? s.serverDefenceRate : null,
                };
            }
        }
        return null;
    }

    root.COR3.autoJobs.reachability = { reachableSet, gateOnPath, canTransit, isOpenableGate };
})();
