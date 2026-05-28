// Auto-Jobs v2 — pipeline stages.
//
// Seven discrete "modules", one per flowchart box, each with the SAME
// contract:
//
//     async run(packet, ctx) -> packet
//
// A single "packet" envelope flows through them, getting enriched at each
// stage (see createPacket() for its shape). The orchestrator
// (auto-jobs-v2.js) owns the loop, decides the order, drives the Flow Map
// highlight, and persists pipeline progress; the stages here are pure data
// work — read the shared game state, compute, write the v2-owned outputs.
//
// ctx is supplied by the orchestrator:
//     { store, bus, C, log: { debug, info, warn, error } }
//   - store : COR3.Store
//   - bus   : COR3.Bus
//   - C     : COR3.constants
//   - log   : routes to the orchestrator's logger (module id 'auto-jobs-v2'),
//             so every stage's output lands in the v2 Activity Log.
//
// v2 rules honored here (see CLAUDE.md): no fallbacks, no silent skips. A
// missing precondition throws (GET_SERVERS without a Network Map) or is
// recorded with an explicit reason on the packet (an unreachable market, a
// job that fails a condition) and logged — never quietly dropped.
//
// Shared, read-only game inputs: NM_GRAPH + the three market envelopes.
// The only command this pipeline issues is a generic market refresh
// (MSG.GAME.REFRESH_*) — the same one the UI Refresh buttons and v1
// auto-refresh use; it is NOT a v1 auto-jobs message, and the resulting
// writes land in the data modules' keys, never v2's.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    if (!root.COR3 || !root.COR3.constants) return;
    const C = root.COR3.constants;
    const SL = C.STORAGE_LOCAL;
    const AJV2 = C.AJV2;

    // ──────────────────────────────────────────────────────────────────────
    // Packet envelope
    // ──────────────────────────────────────────────────────────────────────
    function createPacket(cycle) {
        return {
            type: AJV2.PACKET_TYPE,
            cycle,
            startedAt: Date.now(),
            // Append-only journey log — each stage stamps one entry. Lets the
            // download log / debugging reconstruct exactly what the packet
            // carried at every hop.
            trace: [],

            // ── filled by GET_SERVERS ──
            home: null,
            servers: null,            // NM_GRAPH.servers (read-only copy)

            // ── filled by CHECK_SERVERS_ACCESABILITY ──
            // { [serverName]: { accessible, hasSaiAccess, onCooldown } }
            accessibility: null,
            // { home:{reachable}, dark:{reachable}, srm:{reachable} }
            marketReachability: null,

            // ── filled by UPDATE_MARKETS ──
            // [{ slot, reachable, refreshed, jobCount, marketId, reason }]
            markets: null,
            // raw market jobs as the game returned them, tagged with origin:
            // [{ job, slot, marketId }]
            rawJobs: null,

            // ── filled by JOB_QUEUE ──
            // [{ id, name, type, serverName, marketSlot, marketId,
            //    rewardCredits, raw, eligible:null, skipReason:null }]
            queue: null,

            // ── filled by BUGGED_JOBS ──
            buggedJobs: null,         // { [jobId]: { reason, since } }

            // ── filled by CHECK_JOBS_CONDITION ──
            evaluations: null,        // { [jobId]: { eligible, skipReason } }
            eligible: null,           // [jobId, …] (the final do-able list)
        };
    }

    function stamp(packet, stageId, summary) {
        packet.trace.push({ stage: stageId, at: Date.now(), summary });
        return packet;
    }

    // ──────────────────────────────────────────────────────────────────────
    // Market slot table — the three markets v2 knows about. Each is a server;
    // home is always reachable, dark/srm reachability is the game-reported
    // availability flag (false === "no path / market-not-reachable").
    // ──────────────────────────────────────────────────────────────────────
    const MARKET_SLOTS = [
        {
            slot: 'home', label: 'Home',
            storageKey: SL.MARKET, atKey: SL.MARKET_AT,
            refresh: C.MSG.GAME.REFRESH_MARKET, availableKey: null,
        },
        {
            slot: 'dark', label: 'Dark',
            storageKey: SL.DARK_MARKET, atKey: SL.DARK_MARKET_AT,
            refresh: C.MSG.GAME.REFRESH_DARK_MARKET, availableKey: SL.DARK_MARKET_AVAILABLE,
        },
        {
            slot: 'srm', label: 'SRM7-M',
            storageKey: SL.SRM_MARKET, atKey: SL.SRM_MARKET_AT,
            refresh: C.MSG.GAME.REFRESH_SRM_MARKET, availableKey: SL.SRM_MARKET_AVAILABLE,
        },
    ];

    // ──────────────────────────────────────────────────────────────────────
    // Job-shape helpers (label/locate a raw market job). Minimal v2-owned
    // parsing of the game's job object — NOT ported from v1's planner.
    // ──────────────────────────────────────────────────────────────────────
    const JOB_TYPE_KEYWORDS = {
        [C.FLOW.FILE_DECRYPTION]:  ['file decryption'],
        [C.FLOW.IP_INJECTION]:     ['ip injection'],
        [C.FLOW.IP_CLEANUP]:       ['ip cleanup'],
        [C.FLOW.FILE_UPLOAD]:      ['file upload', 'data upload'],
        [C.FLOW.LOG_DELETION]:     ['log deletion'],
        [C.FLOW.LOG_DOWNLOAD]:     ['log download'],
        [C.FLOW.FILE_ELIMINATION]: ['file elimination'],
        [C.FLOW.DATA_DOWNLOAD]:    ['data download'],
        [C.FLOW.DECRYPT_EXTRACT]:  ['decrypt & extract', 'decrypt and extract'],
    };

    function detectJobType(job) {
        const name = String(job && (job.name || job.category) || '').toLowerCase();
        for (const type of Object.keys(JOB_TYPE_KEYWORDS)) {
            if (JOB_TYPE_KEYWORDS[type].some((kw) => name.includes(kw))) return type;
        }
        return null;
    }

    function jobServer(job) {
        const rs = job && job.relatedServers;
        if (Array.isArray(rs) && rs[0]) return rs[0].serverName || rs[0].name || null;
        if (typeof rs === 'string') return rs;
        return null;
    }

    // Resolve once the matching at-timestamp key advances past `prevAt`
    // (i.e. a fresh market frame landed), or once `timeoutMs` elapses.
    // Resolves true if a fresh frame arrived, false on timeout.
    function awaitMarketUpdate(store, atKey, prevAt, timeoutMs) {
        return new Promise((resolve) => {
            let settled = false;
            const finish = (updated) => {
                if (settled) return;
                settled = true;
                try { unsub(); } catch (_) { /* noop */ }
                clearTimeout(timer);
                resolve(updated);
            };
            const unsub = store.local.onChanged((changes) => {
                const ch = changes[atKey];
                if (ch && Number(ch.newValue || 0) > Number(prevAt || 0)) finish(true);
            });
            const timer = setTimeout(() => finish(false), timeoutMs);
        });
    }

    // ──────────────────────────────────────────────────────────────────────
    // STAGES
    // ──────────────────────────────────────────────────────────────────────

    // MODULE:GET_SERVERS — collect every server from the Network Map graph.
    const getServers = {
        id: AJV2.NODE.GET_SERVERS,
        async run(packet, ctx) {
            const graph = await ctx.store.local.getOne(SL.NM_GRAPH, null);
            if (!graph || !Array.isArray(graph.servers)) {
                // Hard requirement — the whole pipeline is meaningless without
                // the topology. Throw loudly; the orchestrator logs it and
                // retries next cycle.
                throw new Error('GET_SERVERS: NM_GRAPH not available (open the Network Map in-game once)');
            }
            packet.home = graph.home || null;
            packet.servers = graph.servers.slice();
            ctx.log.debug(`GET_SERVERS → ${packet.servers.length} servers`, {
                home: packet.home,
                servers: packet.servers.length,
            });
            return stamp(packet, this.id, { servers: packet.servers.length });
        },
    };

    // MODULE:CHECK_SERVERS_ACCESABILITY — for each server, do we have access,
    // SAI access, and is it on K/D cooldown. Also resolves which markets are
    // reachable (a market is a server too).
    const checkAccess = {
        id: AJV2.NODE.CHECK_ACCESS,
        async run(packet, ctx) {
            if (!packet.servers) throw new Error('CHECK_ACCESS: packet.servers missing (GET_SERVERS must run first)');

            const accessibility = {};
            let accessible = 0, onCooldown = 0;
            for (const s of packet.servers) {
                if (!s || !s.name) continue;
                const entry = {
                    accessible: !!s.isAccessible,
                    hasSaiAccess: !!s.hasAdminAccess,
                    onCooldown: !!s.isInMaintenance,
                };
                accessibility[s.name] = entry;
                if (entry.accessible) accessible++;
                if (entry.onCooldown) onCooldown++;
            }
            packet.accessibility = accessibility;

            // Market reachability — single source for UPDATE_MARKETS. home is
            // always reachable; dark/srm reachable unless the game flagged the
            // path as unavailable (false). undefined === "not yet probed" =>
            // still attempt (UPDATE_MARKETS' refresh will resolve it).
            const reach = {};
            for (const m of MARKET_SLOTS) {
                if (!m.availableKey) { reach[m.slot] = { reachable: true }; continue; }
                const avail = await ctx.store.local.getOne(m.availableKey, undefined);
                reach[m.slot] = { reachable: avail !== false };
            }
            packet.marketReachability = reach;

            ctx.log.debug(`CHECK_ACCESS → ${accessible}/${packet.servers.length} accessible, ${onCooldown} on K/D`, {
                accessible, onCooldown,
                markets: reach,
            });
            return stamp(packet, this.id, { accessible, onCooldown });
        },
    };

    // MODULE:UPDATE_MARKETS — refresh every reachable market, then collect the
    // jobs the game returned. Unreachable markets are recorded with a reason
    // and skipped (not refreshed) — that is the "don't update a market we
    // can't reach" rule, made explicit on the packet.
    const updateMarkets = {
        id: AJV2.NODE.UPDATE_MARKETS,
        async run(packet, ctx) {
            if (!packet.marketReachability) throw new Error('UPDATE_MARKETS: packet.marketReachability missing (CHECK_ACCESS must run first)');

            const timeout = AJV2.LOOP.MARKET_REFRESH_TIMEOUT_MS;
            const markets = [];
            const rawJobs = [];

            for (const m of MARKET_SLOTS) {
                const reachable = !!(packet.marketReachability[m.slot] && packet.marketReachability[m.slot].reachable);
                if (!reachable) {
                    markets.push({ slot: m.slot, reachable: false, refreshed: false, jobCount: 0, marketId: null, reason: 'market-not-reachable' });
                    ctx.log.debug(`UPDATE_MARKETS · ${m.label}: unreachable — not updated`);
                    continue;
                }

                const prevAt = await ctx.store.local.getOne(m.atKey, 0);
                ctx.bus.window.post(m.refresh, null);
                const refreshed = await awaitMarketUpdate(ctx.store, m.atKey, prevAt, timeout);
                if (!refreshed) {
                    // Loud, not silent: the market was reachable but the
                    // refreshed frame never arrived in time.
                    ctx.log.warn(`UPDATE_MARKETS · ${m.label}: refresh timed out after ${timeout}ms — using last-known board`);
                }

                const envelope = await ctx.store.local.getOne(m.storageKey, null);
                const jobs = (envelope && Array.isArray(envelope.jobs)) ? envelope.jobs : [];
                const marketId = (envelope && envelope.marketId) || null;
                for (const job of jobs) rawJobs.push({ job, slot: m.slot, marketId });
                markets.push({ slot: m.slot, reachable: true, refreshed, jobCount: jobs.length, marketId, reason: null });
                ctx.log.debug(`UPDATE_MARKETS · ${m.label}: ${jobs.length} jobs${refreshed ? '' : ' (stale)'}`);
            }

            packet.markets = markets;
            packet.rawJobs = rawJobs;
            ctx.log.info(`UPDATE_MARKETS → ${rawJobs.length} jobs across ${markets.filter((x) => x.reachable).length} reachable market(s)`);
            return stamp(packet, this.id, { jobs: rawJobs.length });
        },
    };

    // MODULE:JOB_QUEUE — the available-jobs board. Normalises the raw market
    // jobs into the queue entry shape and publishes it for the UI (eligibility
    // unknown at this point).
    const jobQueue = {
        id: AJV2.NODE.JOB_QUEUE,
        async run(packet, ctx) {
            if (!packet.rawJobs) throw new Error('JOB_QUEUE: packet.rawJobs missing (UPDATE_MARKETS must run first)');

            const queue = packet.rawJobs.map(({ job, slot, marketId }) => ({
                id: job.id,
                name: job.name || job.category || 'Unknown',
                type: detectJobType(job),
                serverName: jobServer(job),
                marketSlot: slot,
                marketId,
                rewardCredits: Number.isFinite(job.rewardCredits) ? job.rewardCredits : null,
                raw: job,
                eligible: null,
                skipReason: null,
            }));
            packet.queue = queue;

            await ctx.store.local.setOne(SL.AJV2_JOB_QUEUE, {
                cycle: packet.cycle,
                computedAt: Date.now(),
                markets: packet.markets,
                jobs: queue.map(stripRaw),
            });

            ctx.log.info(`JOB_QUEUE → ${queue.length} job(s) on the board`);
            return stamp(packet, this.id, { jobs: queue.length });
        },
    };

    // MODULE:BUGGED_JOBS — the registry of jobs the script has marked bugged
    // (with the error that put them there). Read into the packet so the
    // condition check can exclude them. The script writes to this store later;
    // for now it's read-only here.
    const buggedJobs = {
        id: AJV2.NODE.BUGGED_JOBS,
        async run(packet, ctx) {
            const bugged = await ctx.store.local.getOne(SL.AJV2_BUGGED_JOBS, {});
            packet.buggedJobs = (bugged && typeof bugged === 'object') ? bugged : {};
            const n = Object.keys(packet.buggedJobs).length;
            ctx.log.debug(`BUGGED_JOBS → ${n} bugged job(s) on record`);
            return stamp(packet, this.id, { bugged: n });
        },
    };

    // MODULE:CHECK_JOBS_CONDITION — filter the queue down to the jobs we can
    // actually do. Each non-eligible job carries an explicit skipReason that
    // the UI renders as a SKIP flag.
    //
    // Conditions wired now (real data sources exist):
    //   • bugged registry          → BUGGED_JOBS
    //   • related-server present
    //   • server known to the map
    //   • server not on K/D cooldown
    //   • server accessible
    // Conditions awaiting a config source (added later): job-type enabled,
    // market enabled, per-server skip/priority. There is intentionally NO
    // placeholder for these — we don't invent a condition without a source.
    const checkCondition = {
        id: AJV2.NODE.CHECK_CONDITION,
        async run(packet, ctx) {
            if (!packet.queue) throw new Error('CHECK_CONDITION: packet.queue missing (JOB_QUEUE must run first)');
            if (!packet.accessibility) throw new Error('CHECK_CONDITION: packet.accessibility missing (CHECK_ACCESS must run first)');
            if (!packet.buggedJobs) throw new Error('CHECK_CONDITION: packet.buggedJobs missing (BUGGED_JOBS must run first)');

            const evaluations = {};
            const eligible = [];
            for (const job of packet.queue) {
                const reasons = [];

                const bug = packet.buggedJobs[job.id];
                if (bug) reasons.push(`bugged: ${bug.reason || 'unknown'}`);

                if (!job.serverName) {
                    reasons.push('no related server');
                } else {
                    const acc = packet.accessibility[job.serverName];
                    if (!acc) reasons.push(`server not in Network Map: ${job.serverName}`);
                    else {
                        if (acc.onCooldown) reasons.push('server on K/D cooldown');
                        if (!acc.accessible) reasons.push('server not accessible');
                    }
                }

                const ok = reasons.length === 0;
                const skipReason = ok ? null : reasons.join('; ');
                evaluations[job.id] = { eligible: ok, skipReason };
                job.eligible = ok;
                job.skipReason = skipReason;
                if (ok) eligible.push(job.id);
            }
            packet.evaluations = evaluations;
            packet.eligible = eligible;

            await ctx.store.local.setOne(SL.AJV2_JOB_QUEUE, {
                cycle: packet.cycle,
                computedAt: Date.now(),
                markets: packet.markets,
                jobs: packet.queue.map(stripRaw),
            });

            ctx.log.info(`CHECK_CONDITION → ${eligible.length}/${packet.queue.length} job(s) eligible`);
            return stamp(packet, this.id, { eligible: eligible.length, total: packet.queue.length });
        },
    };

    // The raw game job object is heavy and circular-ish; strip it before
    // writing the queue to storage for the UI.
    function stripRaw(job) {
        const { raw, ...rest } = job;
        return rest;
    }

    root.COR3.autoJobsV2 = root.COR3.autoJobsV2 || {};
    root.COR3.autoJobsV2.pipeline = {
        createPacket,
        stamp,
        MARKET_SLOTS,
        detectJobType,
        jobServer,
        stages: { getServers, checkAccess, updateMarkets, jobQueue, buggedJobs, checkCondition },
    };
})();
