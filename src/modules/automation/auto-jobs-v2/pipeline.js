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
            // [{ slot, reachable, refreshed, jobCount, takenCount, marketId, reason }]
            markets: null,
            // raw market jobs tagged with origin + source-derived status:
            // [{ job, slot, marketId, status:'AVAILABLE'|'TAKEN' }]
            rawJobs: null,

            // ── filled by JOB_QUEUE ──
            // [{ id, name, type, serverName, marketSlot, marketId,
            //    rewardCredits, raw, eligible:null, skipReason:null }]
            queue: null,

            // ── filled by BUGGED_JOBS ──
            buggedJobs: null,         // { [jobId]: { reason, since } }

            // ── filled by CHECK_JOBS_CONDITION ──
            serverOverrides: null,    // AJV2_SERVER_OVERRIDES snapshot used this cycle
            masterSwitches: null,     // AJV2_MASTER_SWITCHES snapshot used this cycle
            evaluations: null,        // { [jobId]: { eligible, skipReason } }
            eligible: null,           // [jobId, …] (the final do-able list)

            // ── filled by JOB_ACCEPTION ──
            accepted: null,           // [jobId, …] (ACCEPT_JOB posted this cycle)
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

    // Job types whose MAIN-world flow-v2 module is wired. Only these are
    // accepted off the board: accepting a type with no flow — including a
    // null/unrecognised type — would consume a market slot that then sits
    // TAKEN forever (the orchestrator can neither complete nor recover it).
    // file_upload is DELIBERATELY excluded: its file.upload wire is a best-guess
    // never captured live (tmp_research/sai-wire-capture.md), and a wrong wire
    // that the server silently no-ops would let the flow "complete" a job the
    // game never marks finishable → an unbounded re-dispatch loop. Keep
    // file_upload jobs unaccepted (visible on the board) until the wire is
    // verified live; the flow-v2-file-upload module stays registered, just not
    // dispatched. Re-add C.FLOW.FILE_UPLOAD here once verified.
    const WIRED_FLOW_TYPES = new Set([
        C.FLOW.FILE_DECRYPTION,
        C.FLOW.IP_INJECTION,
        C.FLOW.IP_CLEANUP,
        C.FLOW.FILE_ELIMINATION,
        C.FLOW.DATA_DOWNLOAD,
        C.FLOW.LOG_DOWNLOAD,
        C.FLOW.LOG_DELETION,
        C.FLOW.DECRYPT_EXTRACT,
    ]);

    function jobServer(job) {
        const rs = job && job.relatedServers;
        if (Array.isArray(rs) && rs[0]) return rs[0].serverName || rs[0].name || null;
        if (typeof rs === 'string') return rs;
        return null;
    }

    // Extract the File Decryption target (a file name or a bare extension) from
    // a raw market job's conditions. v2-owned parsing — NOT v1's resolveJobParams.
    // Returns the string the flow matches in Downloads, or null if absent.
    function fileConditionForDecrypt(rawJob) {
        const items = rawJob && rawJob.conditions && Array.isArray(rawJob.conditions.items)
            ? rawJob.conditions.items : [];
        for (const it of items) {
            const d = (it && it.details) || {};
            if (typeof d.fileName === 'string' && d.fileName) return d.fileName;
            if (Array.isArray(d.fileNames) && typeof d.fileNames[0] === 'string') return d.fileNames[0];
            if (Array.isArray(d.files) && d.files[0] && typeof d.files[0].name === 'string') return d.files[0].name;
            if (Array.isArray(d.extensions) && d.extensions[0]) {
                const e = d.extensions[0];
                const ext = typeof e === 'string' ? e : (e && e.ext);
                if (ext) return String(ext).startsWith('.') ? String(ext) : ('.' + ext);
            }
        }
        return null;
    }

    // ──────────────────────────────────────────────────────────────────────
    // SAI-flow target resolvers. The target (which IPs / files / logs) lives in
    // the PRIMARY condition item's `details`, which is null on AVAILABLE board
    // jobs and POPULATES only once the job is TAKEN (verified live — see
    // tmp_research/sai-wire-capture.md). Shapes (live ip_cleanup + v1
    // resolveJobParams): ip_* → details.ips[]; file_* → details.fileNames[] |
    // fileName | files[].name (by NAME — the flow maps name→fileId via get.files);
    // log_* → details.logSeqs[] (int) and/or logNames[] | logName.
    // v2-owned parsing, NOT a v1 port. Each returns a de-duped array (possibly
    // empty → the orchestrator bugs the job: no resolvable target).
    function conditionItems(rawJob) {
        return (rawJob && rawJob.conditions && Array.isArray(rawJob.conditions.items)) ? rawJob.conditions.items : [];
    }
    // Machine condition codes on a raw job (conditions.items[].type — e.g.
    // InjectIps / DeleteIps / DecryptFile …). Language-independent, unlike the
    // localised job name. Feeds the JOB_QUEUE type-capture debug line; this is
    // the field detectJobType will switch to (#9 — delocalise classification).
    function conditionTypes(rawJob) {
        return conditionItems(rawJob).map((it) => it && it.type).filter(Boolean);
    }
    // serverId for SAI ops == conditions.serverConfigId (== relatedServers[0].id, verified live).
    function serverConfigId(rawJob) {
        return (rawJob && rawJob.conditions && rawJob.conditions.serverConfigId) || null;
    }
    function ipsForJob(rawJob) {
        const out = [];
        for (const it of conditionItems(rawJob)) {
            const d = (it && it.details) || {};
            if (Array.isArray(d.ips)) for (const ip of d.ips) if (typeof ip === 'string' && ip) out.push(ip);
        }
        return [...new Set(out)];
    }
    function fileNamesForJob(rawJob) {
        const out = [];
        for (const it of conditionItems(rawJob)) {
            const d = (it && it.details) || {};
            if (Array.isArray(d.fileNames)) for (const n of d.fileNames) if (typeof n === 'string' && n) out.push(n);
            if (typeof d.fileName === 'string' && d.fileName) out.push(d.fileName);
            if (Array.isArray(d.files)) for (const f of d.files) if (f && typeof f.name === 'string' && f.name) out.push(f.name);
        }
        return [...new Set(out)];
    }
    function logSeqsForJob(rawJob) {
        const out = [];
        for (const it of conditionItems(rawJob)) {
            const d = (it && it.details) || {};
            if (Array.isArray(d.logSeqs)) for (const s of d.logSeqs) if (Number.isInteger(s)) out.push(s);
        }
        return [...new Set(out)];
    }
    function logNamesForJob(rawJob) {
        const out = [];
        for (const it of conditionItems(rawJob)) {
            const d = (it && it.details) || {};
            if (Array.isArray(d.logNames)) for (const n of d.logNames) if (typeof n === 'string' && n) out.push(n);
            if (typeof d.logName === 'string' && d.logName) out.push(d.logName);
        }
        return [...new Set(out)];
    }

    // Plain cancellable pause used to pace ACCEPT_JOB posts. Resolves early
    // (returning false) the moment the orchestrator's run is cancelled, so a
    // STOP mid-acceptance doesn't keep firing job.take RPCs.
    function pacedDelay(ms, alive) {
        return new Promise((resolve) => {
            const STEP = 150;
            let waited = 0;
            const tick = () => {
                if (!alive()) return resolve(false);
                if (waited >= ms) return resolve(true);
                const chunk = Math.min(STEP, ms - waited);
                waited += chunk;
                setTimeout(tick, chunk);
            };
            tick();
        });
    }

    // Subscribe to the at-timestamp key, fire `trigger` (the market refresh),
    // and resolve once the key advances past `prevAt` (a fresh frame landed) or
    // once `timeoutMs` elapses. The subscription is registered BEFORE trigger()
    // runs so a fast WS reply can never land in the gap between posting the
    // refresh and attaching the listener (which would drop the update and force
    // a false "refresh timed out"). Resolves true on a fresh frame, false on timeout.
    function awaitMarketUpdate(store, atKey, prevAt, timeoutMs, trigger) {
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
            try { trigger(); } catch (_) { finish(false); }
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
    //
    // The market envelope is { marketId, jobs, recentJobs, … }: `jobs` is the
    // AVAILABLE board (acceptance candidates — they carry no status, being on
    // the board IS the status), while accepted jobs leave the board and appear
    // in `recentJobs` tagged status:'TAKEN' (= in-progress). We pull BOTH and
    // stamp each rawJob with a source-derived status so JOB_QUEUE /
    // HAVE_TASKS_IN_PROGRESS / JOB_ACCEPTION can route on it. Other recentJobs
    // states (FAILED/EXPIRED/COMPLETED/ready-to-claim) are out of v2's current
    // scope and intentionally not collected.
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
                    markets.push({ slot: m.slot, reachable: false, refreshed: false, jobCount: 0, takenCount: 0, marketId: null, reason: 'market-not-reachable' });
                    ctx.log.debug(`UPDATE_MARKETS · ${m.label}: unreachable — not updated`);
                    continue;
                }

                const prevAt = await ctx.store.local.getOne(m.atKey, 0);
                // Subscribe-then-post (inside awaitMarketUpdate) closes the race
                // where a fast refresh reply landed before the listener attached.
                const refreshed = await awaitMarketUpdate(ctx.store, m.atKey, prevAt, timeout, () => ctx.bus.window.post(m.refresh, null));
                if (!refreshed) {
                    // Loud, not silent: the market was reachable but the
                    // refreshed frame never arrived in time.
                    ctx.log.warn(`UPDATE_MARKETS · ${m.label}: refresh timed out after ${timeout}ms — using last-known board`);
                }

                const envelope = await ctx.store.local.getOne(m.storageKey, null);
                const available = (envelope && Array.isArray(envelope.jobs)) ? envelope.jobs : [];
                const recent = (envelope && Array.isArray(envelope.recentJobs)) ? envelope.recentJobs : [];
                // marketId is required to accept any of this market's jobs. Read
                // it directly (no `|| null` masking) and fail loudly if a
                // reachable market's envelope lacks it — otherwise every job
                // here would be silently unacceptable down at JOB_ACCEPTION.
                const marketId = envelope ? envelope.marketId : null;
                if (marketId == null) {
                    ctx.log.error(`UPDATE_MARKETS · ${m.label}: reachable market has no marketId in its envelope — its jobs cannot be accepted this cycle`);
                }

                // De-dup by job id across the AVAILABLE board and the TAKEN
                // recentJobs: right after an accept the game can momentarily
                // list the same job in both. The TAKEN entry wins (newer,
                // in-progress state) so the queue never carries a duplicate
                // that JOB_ACCEPTION would re-accept.
                const byId = new Map();
                for (const job of available) {
                    if (job && job.id != null) byId.set(job.id, { job, slot: m.slot, marketId, status: 'AVAILABLE' });
                }
                let takenCount = 0;
                for (const job of recent) {
                    if (job && job.status === 'TAKEN' && job.id != null) {
                        byId.set(job.id, { job, slot: m.slot, marketId, status: 'TAKEN' });
                        takenCount++;
                    }
                }
                for (const entry of byId.values()) rawJobs.push(entry);

                markets.push({ slot: m.slot, reachable: true, refreshed, jobCount: available.length, takenCount, marketId, reason: null });
                ctx.log.debug(`UPDATE_MARKETS · ${m.label}: ${available.length} available, ${takenCount} in-progress${refreshed ? '' : ' (stale)'}`);
            }

            packet.markets = markets;
            packet.rawJobs = rawJobs;
            const avail = rawJobs.filter((r) => r.status === 'AVAILABLE').length;
            const taken = rawJobs.length - avail;
            ctx.log.info(`UPDATE_MARKETS → ${avail} available + ${taken} in-progress across ${markets.filter((x) => x.reachable).length} reachable market(s)`);
            return stamp(packet, this.id, { available: avail, inProgress: taken });
        },
    };

    // MODULE:JOB_QUEUE — the available-jobs board. Normalises the raw market
    // jobs into the queue entry shape and publishes it for the UI (eligibility
    // unknown at this point).
    const jobQueue = {
        id: AJV2.NODE.JOB_QUEUE,
        async run(packet, ctx) {
            if (!packet.rawJobs) throw new Error('JOB_QUEUE: packet.rawJobs missing (UPDATE_MARKETS must run first)');

            const queue = packet.rawJobs.map(({ job, slot, marketId, status }) => ({
                id: job.id,
                // Prefer name, else category — both real game fields. No
                // 'Unknown' fabrication (that hid jobs with no name behind a
                // fake label); the UI shows its own placeholder if absent.
                name: job.name || job.category,
                type: detectJobType(job),
                // Source-derived status stamped by UPDATE_MARKETS: 'AVAILABLE'
                // (from the board — an acceptance candidate) or 'TAKEN' (from
                // recentJobs — in-progress). The whole in-progress flow (the
                // HAVE_TASKS_IN_PROGRESS? diamond, the BUGGED_JOBS decision,
                // JOB_ACCEPTION's accept filter) reads off this field.
                status,
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

            // Type-capture debug — one compact line per job, fully visible in the
            // Activity Log (the capture lives in the MSG, not ctx, which the log
            // viewer truncates to 200 chars). Correlates the localised name with
            // the machine condition code(s) so the language-independent
            // detectJobType map (#9) can be built/verified from a single cycle.
            for (const j of queue) {
                const ct = conditionTypes(j.raw);
                const cat = (j.raw && j.raw.category) || '—';
                ctx.log.debug(`JOB_QUEUE · "${j.name || '?'}" [${j.status}] cat="${cat}" cond=[${ct.join(', ') || '—'}] name→${j.type || 'null'} @${j.marketSlot}`);
            }

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
    // Two classes of reason:
    //   DATA reasons (only the pipeline has the inputs) — stamped onto the job
    //   as `dataSkipReason` so the popup can't recompute them but can still
    //   show them:
    //     • bugged registry          → BUGGED_JOBS
    //     • server known to the map         (only when the job has a server)
    //     • server not on K/D cooldown      (only when the job has a server)
    //     • server accessible               (only when the job has a server)
    //   CONFIG reasons (pure user switches) — computed by the SHARED evaluator
    //   COR3.ajv2Eligibility.configSkipReason so the popup Job List can
    //   re-derive them live the instant a switch changes:
    //     • market disabled globally        → AJV2_MASTER_SWITCHES
    //     • job type disabled globally       → AJV2_MASTER_SWITCHES
    //     • user SKIP on the server          → AJV2_SERVER_OVERRIDES
    //     • job type disabled on the server  → AJV2_SERVER_OVERRIDES
    // A missing related server is NOT a skip reason — download/solve job types
    // legitimately have none (their file lands in the Downloads widget).
    const checkCondition = {
        id: AJV2.NODE.CHECK_CONDITION,
        async run(packet, ctx) {
            if (!packet.queue) throw new Error('CHECK_CONDITION: packet.queue missing (JOB_QUEUE must run first)');
            if (!packet.accessibility) throw new Error('CHECK_CONDITION: packet.accessibility missing (CHECK_ACCESS must run first)');
            // The BUGGED_JOBS decision only runs on the in-progress branch, so
            // CHECK_CONDITION loads the registry itself when reached via the
            // no-tasks-in-progress path — its own required input, from the real
            // source (no prior-stage coupling).
            if (!packet.buggedJobs) {
                packet.buggedJobs = await ctx.store.local.getOne(SL.AJV2_BUGGED_JOBS, {});
            }

            const overrides = await ctx.store.local.getOne(SL.AJV2_SERVER_OVERRIDES, {});
            const switches = await ctx.store.local.getOne(SL.AJV2_MASTER_SWITCHES, {});
            packet.serverOverrides = overrides;
            packet.masterSwitches = switches;

            const evalConfig = root.COR3.ajv2Eligibility.configSkipReason;

            const evaluations = {};
            const eligible = [];
            for (const job of packet.queue) {
                // Eligibility is an ACCEPTANCE verdict — it only applies to
                // AVAILABLE board jobs. TAKEN (in-progress) jobs are routed by
                // _runJobFlows purely on status+bugged+type, never on
                // eligible/skipReason, so evaluating them here would only stamp
                // misleading "eligible:false / market disabled" verdicts into
                // the shared queue snapshot. Leave them pending.
                if (job.status !== 'AVAILABLE') {
                    evaluations[job.id] = { eligible: null, skipReason: null };
                    continue;
                }
                // ── DATA reasons (pipeline-only inputs, baked onto the job) ──
                const dataReasons = [];
                if (job.serverName) {
                    const acc = packet.accessibility[job.serverName];
                    if (!acc) dataReasons.push(`server not in Network Map: ${job.serverName}`);
                    else {
                        if (acc.onCooldown) dataReasons.push('server on K/D cooldown');
                        if (!acc.accessible) dataReasons.push('server not accessible');
                    }
                }
                const dataSkipReason = dataReasons.length ? dataReasons.join('; ') : null;

                // ── CONFIG reason (shared with the popup) + bugged registry ──
                // Both are storage-backed, so the popup re-derives them live;
                // we still apply them here for the acceptance verdict.
                const configReason = evalConfig(job, switches, overrides);
                const bug = packet.buggedJobs[job.id];
                const bugReason = bug ? `bugged: ${bug.reason || 'unknown'}` : null;

                const ok = !dataSkipReason && !configReason && !bugReason;
                const skipReason = [bugReason, dataSkipReason, configReason].filter(Boolean).join('; ') || null;
                evaluations[job.id] = { eligible: ok, skipReason };
                job.eligible = ok;
                job.skipReason = skipReason;
                job.dataSkipReason = dataSkipReason;  // bugged + config re-derived live in the popup
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

    // MODULE:JOB_ACCEPTION — accept jobs off the board via the game's
    // market/job.take RPC (MAIN's __cor3AcceptJob, reached through the generic
    // MSG.GAME.ACCEPT_JOB window message — same shared game infrastructure
    // UPDATE_MARKETS uses for REFRESH_*; NOT a v1-auto-jobs message).
    //
    // Acceptance set = jobs that passed CHECK_CONDITION (eligible) AND are
    // still AVAILABLE on the board (status 'AVAILABLE' — never re-accept a
    // TAKEN/FAILED/EXPIRED entry). Decryption is prioritised exactly as the
    // flowchart draws it: if there are any file_decryption jobs, accept ALL of
    // them across ALL markets this cycle; only when there are none do we accept
    // the other-type jobs (no depth calc — we just accept them).
    //
    // Posts are paced ACCEPT_PACING_MS apart so the job.take bursts don't
    // outrun the server; after the batch we post REVERT_ENDPOINT_TO_HOME once
    // (the accept helper does set.endpoint per remote market but never reverts
    // on its own). Acceptance is confirmed asynchronously — the accepted jobs
    // flip to status 'TAKEN', which the next UPDATE_MARKETS cycle observes.
    const jobAcception = {
        id: AJV2.NODE.JOB_ACCEPTION,
        async run(packet, ctx) {
            if (!packet.eligible) throw new Error('JOB_ACCEPTION: packet.eligible missing (CHECK_CONDITION must run first)');

            const eligibleSet = new Set(packet.eligible);
            // Only accept jobs whose flow-v2 module is wired (WIRED_FLOW_TYPES);
            // a null/unwired type that slips through eligibility would be taken
            // and then sit TAKEN forever (no flow can complete it).
            const acceptable = packet.queue.filter((j) =>
                eligibleSet.has(j.id) && j.status === 'AVAILABLE' && WIRED_FLOW_TYPES.has(j.type));

            const decryption = acceptable.filter((j) => j.type === C.FLOW.FILE_DECRYPTION);
            // ABSOLUTE file_decryption priority: while ANY file_decryption is
            // still AVAILABLE on the board OR TAKEN (accepted but not yet
            // solved), we accept ONLY the AVAILABLE file_decryption and NOTHING
            // else. That set may be empty (all already TAKEN) — then we accept
            // nothing this cycle and wait for the in-progress decryptions to be
            // solved + completed. Only once no file_decryption remains anywhere
            // in the queue do we accept the other-type jobs.
            // A BUGGED file_decryption is excluded: a decrypt with no owned
            // covering software is accepted, bugged, and then sits TAKEN in the
            // market forever (v2 never dismisses). Without this exclusion it
            // would keep decryptionPending permanently true and STARVE every SAI
            // job type from acceptance for the rest of the session.
            const bugged = packet.buggedJobs || {};
            const decryptionPending = packet.queue.some((j) =>
                j.type === C.FLOW.FILE_DECRYPTION && !bugged[j.id]
                && (j.status === 'AVAILABLE' || j.status === 'TAKEN'));
            const toAccept = decryptionPending ? decryption : acceptable;
            const mode = decryptionPending ? 'file_decryption (all markets)' : 'other types';

            packet.accepted = [];
            if (toAccept.length === 0) {
                ctx.log.info('JOB_ACCEPTION → nothing to accept (no eligible AVAILABLE jobs)');
                return stamp(packet, this.id, { accepted: 0 });
            }

            ctx.log.info(`JOB_ACCEPTION → accepting ${toAccept.length} job(s) [${mode}]`);
            for (let i = 0; i < toAccept.length; i++) {
                if (!ctx.alive()) { ctx.log.warn('JOB_ACCEPTION cancelled mid-batch'); break; }
                const job = toAccept[i];
                if (!job.marketId) {
                    ctx.log.error(`JOB_ACCEPTION: job ${job.id} has no marketId — cannot accept`, { job: stripRaw(job) });
                    continue;
                }
                ctx.bus.window.post(C.MSG.GAME.ACCEPT_JOB, { jobId: job.id, marketId: job.marketId });
                packet.accepted.push(job.id);
                ctx.log.debug(`JOB_ACCEPTION · take ${job.id} (${job.type || 'unknown'}) @ ${job.marketSlot}`);
                if (i < toAccept.length - 1) await pacedDelay(AJV2.LOOP.ACCEPT_PACING_MS, ctx.alive);
            }

            // One revert after the whole batch — remote-market accepts may have
            // left the endpoint on DARK/SRM.
            ctx.bus.window.post(C.MSG.GAME.REVERT_ENDPOINT_TO_HOME, null);
            ctx.log.info(`JOB_ACCEPTION → ${packet.accepted.length} accept(s) sent, endpoint reverted to home`);
            return stamp(packet, this.id, { accepted: packet.accepted.length, mode });
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
        WIRED_FLOW_TYPES,
        detectJobType,
        jobServer,
        fileConditionForDecrypt,
        // SAI-flow target resolvers (read from the TAKEN job's condition details).
        serverConfigId,
        ipsForJob,
        fileNamesForJob,
        logSeqsForJob,
        logNamesForJob,
        stages: { getServers, checkAccess, updateMarkets, jobQueue, buggedJobs, checkCondition, jobAcception },
    };
})();
