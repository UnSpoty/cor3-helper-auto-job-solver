// Auto Jobs — shared SAI-flow helper (MAIN world).
//
// The 7 SAI job flows (ip_injection, ip_cleanup, file_elimination,
// data_download, file_upload, log_download, log_deletion) — and the front half
// of decrypt_extract — all share the SAME shape, verified live over pure WS
// (no DOM window): connect → log in (Active Access grant, headless) → read a
// list / mutate over WS → job.complete. This module factors out that shared
// machinery so each flow module is thin:
//
//   • ensureAccess(serverId, serverType, serverName, say) — set.endpoint, then
//     log in with a task_access grant (HEADLESS, no SAI window). If the server
//     has no grant it HACKS — fully over WS: install HACK software
//     (COR3.game.loadout.ensureHack), (re)connect with set.endpoint, then fire
//     `sai.hack.start` (__cor3SaiHackStart). The server launches the minigame
//     (minigames.start.minigame), the React app mounts it, the standalone solver
//     wins, and we log in with the freshly-minted grant. No SAI terminal window
//     / Login button / tile click — same server-driven minigame start that
//     file_decryption uses with WS open.file. The minigame DOM is the only live
//     surface (the solver plays it).
//   • getTransit / getFiles / getLogs(serverId) — fire the __cor3SaiGet* WS
//     helper, resolve its reply data off MSG.WS.SAI_* (no DOM scrape).
//   • awaitAction(trigger) — fire a mutation (__cor3SaiTransitAdd/Remove,
//     FileDownload/Delete, LogDownload/Delete) and resolve its
//     MSG.WS.SAI_ACTION verdict { action, data, error }.
//   • defineFlow({ id, name, jobType, dependsOn, run }) — registers a
//     COR3.Module with the EXACT FLOW_START/FLOW_RESULT/FLOW_ABORT + busy-guard
//     boilerplate of file-decryption.js, and calls spec.run(job, helpers).
//
// Speaks MSG.AUTOJOBS directly (no shared flow infra),
// logs under each flow's own 'flow-*' id, no silent fallbacks (a missing
// precondition returns an explicit retryable/bug FLOW_RESULT body).

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    if (!root.COR3 || !root.COR3.constants || !root.COR3.Bus) return;
    const { Module, Bus, Registry, dom, constants: C } = root.COR3;
    const MSG = C.MSG;
    const AJ = MSG.AUTOJOBS;
    const NODE = C.AJ.NODE;
    const sleep = (ms) => dom.sleep(ms);

    // ONE cross-module busy guard shared by every Auto Jobs flow (this factory's SAI
    // flows + file-decryption.js, which defines the same global). At most one
    // flow runs at a time across the whole Auto Jobs flow subsystem — see the rationale
    // in file-decryption.js. `jobId` is the in-flight job (FLOW_ABORT matches it).
    const lock = (root.__cor3FlowLock = root.__cor3FlowLock || { busy: false, jobId: null });

    // Fire trigger(), resolve with the next Bus.window `type` envelope (or null
    // on timeout). Same primitive file-decryption.js uses for desktop replies.
    function awaitBus(type, timeoutMs, trigger) {
        return new Promise((resolve) => {
            let done = false;
            const finish = (v) => { if (done) return; done = true; try { unsub(); } catch (_) { /* noop */ } clearTimeout(timer); resolve(v); };
            const unsub = Bus.window.on(type, (env) => finish(env));
            const timer = setTimeout(() => finish(null), timeoutMs);
            try { trigger(); } catch (_) { finish(null); }
        });
    }

    // SAI reads — return the reply `data` ({serverId, ips|files|logs, …}) or null.
    async function getTransit(serverId, ms) { const r = await awaitBus(MSG.WS.SAI_TRANSIT, ms || 15000, () => root.__cor3SaiGetTransit(serverId)); return r ? r.data : null; }
    async function getFiles(serverId, ms) { const r = await awaitBus(MSG.WS.SAI_FILES, ms || 15000, () => root.__cor3SaiGetFiles(serverId)); return r ? r.data : null; }
    async function getLogs(serverId, ms) { const r = await awaitBus(MSG.WS.SAI_LOGS, ms || 15000, () => root.__cor3SaiGetLogs(serverId)); return r ? r.data : null; }
    // SAI mutation — fire trigger, resolve the next SAI_ACTION { action, data, error }.
    function awaitAction(timeoutMs, trigger) { return awaitBus(MSG.WS.SAI_ACTION, timeoutMs || 12000, trigger); }

    // Resolve a Downloads fileId by exact name (or by bare ".ext") purely over
    // WS (desktop.open.folder → match files[]), same recipe as file-decryption.
    // Used by file_upload (source file to push) and decrypt_extract (the
    // SAI-downloaded file to open). Returns the fileId or null.
    async function findDownloadsFileId(match, ms) {
        let folderId = root.__cor3DownloadFolderId;
        if (!folderId) {
            if (typeof root.__cor3DesktopGetOptions !== 'function') return null;
            await awaitBus(MSG.WS.DESKTOP_OPTIONS, 8000, () => root.__cor3DesktopGetOptions());
            folderId = root.__cor3DownloadFolderId;
        }
        if (!folderId || typeof root.__cor3DesktopOpenFolder !== 'function') return null;
        const resp = await awaitBus(MSG.WS.DESKTOP_FOLDER, ms || 60000, () => root.__cor3DesktopOpenFolder(folderId));
        const files = (resp && resp.data && Array.isArray(resp.data.files)) ? resp.data.files : [];
        const raw = String(match || '').trim().toLowerCase();
        const isExt = raw.startsWith('.');
        const f = files.find((x) => { const n = String((x && x.name) || '').toLowerCase(); return isExt ? n.endsWith(raw) : n === raw; });
        return f ? f.id : null;
    }

    // ── Server access ──────────────────────────────────────────────────────
    const pickGrant = (s) => ((s && s.activeAccesses) || []).find((g) => g.sourceType === 'task_access') || ((s && s.activeAccesses) || [])[0] || null;

    // Hack path (only when no grant). Mirrors auto-jobs-bridge.js saiAccess —
    // needs the SAI terminal window open to click the hack-tool row.
    const MINIGAME_SELS = [
        '[data-sentry-element="LogContentStyled"][data-sentry-source-file="config-hack-application.tsx"]',
        '[data-sentry-component="IceWallBreakApplication"]',
        '[data-sentry-component="SimpleDecryptApplication"]',
        '[data-component-name="SimpleDecryptApplication"]',
    ];
    const findMinigame = () => { for (const s of MINIGAME_SELS) if (document.querySelector(s)) return true; return false; };
    const SOLVER_START = [MSG.SOLVER.START_DECRYPT, MSG.SOLVER.START_ICE_WALL, MSG.SOLVER.START_SIMPLE_DECRYPT];
    // Driven under the 'flow' owner: all three solvers ref-count owners, so STOP
    // removes only 'flow' and leaves a user's standalone watcher (owner 'user')
    // running. We DO stop ICE WALL here so that, with Auto ICE WALL OFF (no
    // 'user' owner), the watcher this flow started does not survive the flow.
    const SOLVER_STOP = [MSG.SOLVER.STOP_DECRYPT, MSG.SOLVER.STOP_ICE_WALL, MSG.SOLVER.STOP_SIMPLE_DECRYPT];
    const startSolvers = () => { for (const m of SOLVER_START) Bus.window.post(m, { owner: 'flow' }); };
    const stopSolvers = () => { for (const m of SOLVER_STOP) Bus.window.post(m, { owner: 'flow' }); };
    // Poll a predicate until true or the deadline (no desktop dependency — the
    // WS hack path opens no window).
    async function waitForCond(pred, timeoutMs) {
        const dl = Date.now() + timeoutMs;
        while (Date.now() < dl && !root.__cor3Abort) { if (pred()) return true; await sleep(150); }
        return !!pred();
    }
    async function pollForGrant(serverId, timeoutMs) {
        const dl = Date.now() + timeoutMs;
        while (Date.now() < dl && !root.__cor3Abort) {
            const g = pickGrant(await root.__cor3SaiGetLoginStatus(serverId));
            if (g) return g;
            await sleep(2000);
        }
        return null;
    }
    // Hack the server for access. Returns { grant } on success, or
    // { retryable, reason } on failure. The retryable flag distinguishes a
    // PERMANENT block — no owned HACK software covers this server type
    // (ensureHack → 'none'/'install-failed') → bug the job, don't loop — from a
    // TRANSIENT miss (window/DOM/minigame timing, snapshot/WS race) → retry next
    // cycle. (ensureHack's 'unknown'/'no-helper' are timing races → retryable,
    // mirroring file_decryption's classification.)
    const RETRY = (reason) => ({ retryable: true, reason });
    const BUG = (reason) => ({ retryable: false, reason });
    async function hackForAccess(serverName, serverId, serverType, status, say) {
        if (!serverId) { say('warn', 'hack: no serverId'); return RETRY('no-serverId'); }
        if (typeof root.__cor3SaiHackStart !== 'function' || typeof root.__cor3SetEndpoint !== 'function') {
            say('error', 'hack: SAI hack WS helpers missing'); return RETRY('hack-ws-helpers-missing');
        }
        // 1. Ensure a covering HACK tool is equipped — install owned software
        //    (ensureHack swaps everything out to fit if needed) when none is.
        if (!(status.hackTools && status.hackTools.length)) {
            const LO = (root.COR3.game || {}).loadout;
            if (!LO || typeof LO.ensureHack !== 'function') { say('warn', 'hack: loadout API missing'); return RETRY('loadout-api-missing'); }
            if (!serverType) { say('warn', 'hack: no serverType — cannot pick HACK software'); return BUG('no-serverType'); }
            const cap = await LO.ensureHack(serverType, say);
            if (!cap.ok) {
                // 'none' (no owned HACK software covers this type) / 'install-failed'
                // → permanent, bug it. 'unknown' / 'no-helper' → timing/WS race → retry.
                const transient = cap.status === 'unknown' || cap.status === 'no-helper';
                say('warn', `hack: no HACK capability for "${serverType}" (${cap.status})`);
                return transient ? RETRY(`no-hack-capability:${cap.status}`) : BUG(`no-hack-software:${serverType}`);
            }
            status = await root.__cor3SaiGetLoginStatus(serverId);
            if (!status || !(status.hackTools && status.hackTools.length)) { say('warn', 'hack: tool still absent after install'); return RETRY('hacktool-absent-after-install'); }
        }
        // 2. CONNECT over WS (set.endpoint IS the Connect action). establishAccess
        //    set it earlier, but ensureHack's equip churn may have taken seconds —
        //    re-assert so hack.start lands while we're actually on the server.
        if (root.__cor3Abort) return RETRY('aborted');
        root.__cor3SetEndpoint(serverId);
        await sleep(1200);
        // 3. Launch the hack over WS — the server starts the minigame
        //    (minigames.start.minigame), the React app mounts it, the standalone
        //    solver wins. No SAI window / Login button / hack-tool click needed
        //    (mirrors file_decryption's WS open.file).
        startSolvers();
        try {
            const startAt = Date.now();
            if (!root.__cor3SaiHackStart(serverId)) { say('error', 'hack: hack.start send failed'); return RETRY('hack-start-send-failed'); }
            if (!(await waitForCond(() => findMinigame(), 30000))) { say('warn', 'hack: minigame did not appear after hack.start'); return RETRY('hack-minigame-no-show'); }
            // Size the grant-poll to THIS minigame's own timer — but only if the
            // interceptor captured it FRESH (after our hack.start). __cor3LastMinigame
            // is a shared global a prior minigame (e.g. the file_decryption that
            // _selectBatch runs first) may have left set, so an unguarded read
            // could use a stale, too-short timer.
            const mg = root.__cor3LastMinigame;
            const fresh = mg && mg.at >= startAt - 1500 && mg.timerDurationMs;
            if (!fresh) say('warn', 'hack: no fresh minigame timer — using 300s');
            // Cap below the orchestrator's FLOW_TIMEOUT_MS so it never aborts us
            // mid-poll (which would discard a still-winnable hack); a failed hack
            // just fails ~a minute sooner and retries next cycle.
            const cap = Math.max(60000, C.AJ.LOOP.FLOW_TIMEOUT_MS - 60000);
            const pollMs = Math.min((fresh ? mg.timerDurationMs : 300000) + 15000, cap);
            const grant = await pollForGrant(serverId, pollMs);
            return grant ? { grant } : RETRY('hack-no-grant-after-solve');
        } finally { stopSolvers(); }
    }

    // Connect to the server and log in. Grant present → pure-WS headless login.
    // No grant → hack (opens the SAI window). Returns { ok } or
    // { ok:false, retryable, reason }. This is the raw establish; callers go
    // through ensureAccess (below), which adds per-batch session reuse.
    async function establishAccess(serverId, serverType, serverName, say, step, accessNode) {
        if (typeof root.__cor3SetEndpoint !== 'function'
            || typeof root.__cor3SaiGetLoginStatus !== 'function'
            || typeof root.__cor3SaiLoginWithAccess !== 'function') {
            return { ok: false, retryable: true, reason: 'sai-ws-helpers-missing' };
        }
        root.__cor3SetEndpoint(serverId);
        await sleep(1500);
        if (root.__cor3Abort) return { ok: false, retryable: true, reason: 'aborted' };
        let status = await root.__cor3SaiGetLoginStatus(serverId);
        if (!status) return { ok: false, retryable: true, reason: 'no-login-status' };
        let grant = pickGrant(status);
        if (!grant) {
            say('info', `no Active Access on "${serverName || serverId}" — hacking for access`);
            // Surface the hack (+ its minigame) as the SAI_HACK step in the
            // pipeline status, then re-emit this flow's own *_ACCESS step so the
            // readout returns to the access stage before the action runs.
            const showHack = !!(step && accessNode);
            if (showHack) step(NODE.SAI_HACK);
            const hk = await hackForAccess(serverName, serverId, serverType, status, say);
            // hk.retryable === false → permanent (no owned HACK software) → propagate
            // so the flow returns a non-retryable result → the orchestrator BUGS
            // the job instead of retrying it every cycle forever.
            if (!hk.grant) return { ok: false, retryable: hk.retryable !== false, reason: hk.reason || 'no-access' };
            // Grant won → return the highlight to the ACCESS node before the action.
            if (showHack) step(accessNode);
            grant = hk.grant;
        }
        if (!root.__cor3SaiLoginWithAccess(serverId, grant.id)) return { ok: false, retryable: true, reason: 'login-send-failed' };
        await sleep(1200);
        say('info', `SAI access OK on "${serverName || serverId}" (headless WS)`);
        return { ok: true };
    }

    // Batch-aware access — the public entry the flows call. The orchestrator
    // runs every job that targets ONE server back-to-back in a single cycle and
    // tags each FLOW_START with the same `batchKey` (`${cycle}:${serverId}`). The
    // FIRST job of the batch establishes access (login-with-grant, or hack); every
    // later job reuses that ONE session instead of re-connecting + re-logging —
    // one login (and at most one hack) per server per cycle. The cached outcome
    // covers FAILURE too, so a server we couldn't get into is not re-hacked once
    // per job. A new cycle => new batchKey => fresh auth. Reuse is additionally
    // gated on the live endpoint still pointing at the server (a SAI session is
    // only valid while connected); if it drifted off we re-establish. Without a
    // batchKey (single-job dispatch) it falls straight through to establishAccess.
    async function ensureAccess(serverId, serverType, serverName, say, batchKey, step, accessNode) {
        if (!serverId) return { ok: false, reason: 'no-serverId' };
        const cached = root.__cor3SaiSession;
        if (batchKey && cached && cached.batchKey === batchKey && cached.serverId === serverId) {
            if (!cached.ok) return { ok: false, retryable: cached.retryable, reason: cached.reason };
            // Reuse the login ONLY if the endpoint is still on the server AND
            // nothing has flipped it since we logged in. The endpoint epoch is
            // the real guard: an auto-refresh remote-market fetch flips the
            // endpoint off the server and back, tearing down the SAI login while
            // leaving __cor3CurrentEndpoint reading the same id — without the
            // epoch check we'd reuse a DEAD session and the WS action would fail
            // (and the job get wrongly bugged). Any epoch change → re-establish.
            if (root.__cor3CurrentEndpoint === serverId && root.__cor3EndpointEpoch === cached.epoch) {
                say('info', `SAI session reused for "${serverName || serverId}" (batch — one login/server)`);
                return { ok: true };
            }
            // Endpoint drifted (or flipped-and-reverted) since login → re-establish.
        }
        const result = await establishAccess(serverId, serverType, serverName, say, step, accessNode);
        // Stamp the epoch AFTER establishAccess (its own set.endpoint bump is
        // included), so the next job reuses only while the endpoint stays put.
        if (batchKey) root.__cor3SaiSession = { batchKey, serverId, ok: result.ok, retryable: result.retryable, reason: result.reason, epoch: root.__cor3EndpointEpoch };
        return result;
    }

    // ── Flow module factory ──────────────────────────────────────────────────
    // Builds + registers a COR3.Module with the same FLOW_START/RESULT/ABORT +
    // busy-guard envelope as file-decryption.js. spec.run(job, helpers) returns
    // the FLOW_RESULT body (minus jobId/marketId).
    function defineFlow(spec) {
        class SaiFlow extends Module {
            constructor() {
                super({
                    id: spec.id,
                    name: spec.name,
                    category: C.CATEGORY.GAME,
                    dependsOn: spec.dependsOn || ['loadout-panel'],
                    owns: { busTypes: [AJ.FLOW_START, AJ.FLOW_RESULT, AJ.FLOW_ABORT] },
                });
            }
            async start() {
                this.track(Bus.window.on(AJ.FLOW_START, async (env) => {
                    if (!env || env.jobType !== spec.jobType) return;   // not this flow's type
                    if (lock.busy) {
                        this.warn(`FLOW_START ignored — a flow is already running (job ${env.jobId})`);
                        Bus.window.post(AJ.FLOW_RESULT, { jobId: env.jobId, marketId: env.marketId, success: false, retryable: true, reason: 'flow-busy' });
                        return;
                    }
                    lock.busy = true;
                    lock.jobId = env.jobId;
                    // private abort flag (not a shared global) so
                    // a concurrent flow cannot clear our abort, nor we theirs.
                    root.__cor3Abort = false;   // a prior aborted flow may have left it set
                    const say = (lvl, m, ctx) => { const f = this[lvl] || this.info; f.call(this, m, ctx); };
                    // Track the last emitted node so ensureAccess knows which
                    // *_ACCESS node it was called from (for the SAI_HACK detour).
                    let lastNode = null;
                    const step = (node) => { lastNode = node; Bus.window.post(AJ.FLOW_STEP, { jobId: env.jobId, node }); };
                    const helpers = {
                        root, dom, C, MSG, sleep, say, step,
                        abort: () => !!root.__cor3Abort,
                        // batchKey is captured from the FLOW_START envelope so a
                        // flow's run() keeps calling ensureAccess(sid, type, name)
                        // unchanged — the per-batch login reuse is transparent.
                        // lastNode (the *_ACCESS step the flow just emitted) lets
                        // ensureAccess light SAI_HACK then return to that ACCESS node.
                        ensureAccess: (sid, stype, sname) => ensureAccess(sid, stype, sname, say, env.batchKey, step, lastNode),
                        awaitBus, awaitAction, getTransit, getFiles, getLogs, findDownloadsFileId,
                        startSolvers, stopSolvers, findMinigame,
                        complete: () => {
                            // In a multi-job SAI batch the orchestrator defers every
                            // complete to the end (a complete-flip tears down the
                            // shared SAI session) — so here complete() is a no-op and
                            // the orchestrator sends job.complete once the batch's
                            // actions are all done. Single dispatch (no flag) → complete now.
                            if (env.deferComplete) { say('info', `complete deferred to orchestrator (SAI batch) — job ${env.jobId}`); return; }
                            if (typeof root.__cor3CompleteJob === 'function') root.__cor3CompleteJob(env.jobId, env.marketId);
                            else Bus.window.post(MSG.GAME.COMPLETE_JOB, { jobId: env.jobId, marketId: env.marketId });
                        },
                    };
                    this.info(`FLOW_START ${spec.jobType} job=${env.jobId} server="${env.serverName || ''}"`);
                    try {
                        const r = await spec.run(env, helpers);
                        Bus.window.post(AJ.FLOW_RESULT, Object.assign({ jobId: env.jobId, marketId: env.marketId }, r));
                        this.info(`FLOW_RESULT job=${env.jobId} → ${JSON.stringify(r)}`);
                    } catch (e) {
                        this.error(`flow crashed for job ${env.jobId}`, { error: String(e), stack: e && e.stack });
                        // retryable:true — an uncaught throw (e.g. desktop.openApp
                        // throwing when the dock isn't mounted yet) is treated as
                        // a TRANSIENT failure and retried, NOT a permanent bug; a
                        // genuinely-impossible job surfaces via an explicit
                        // retryable:false result, not a crash.
                        Bus.window.post(AJ.FLOW_RESULT, { jobId: env.jobId, marketId: env.marketId, success: false, retryable: true, reason: 'flow-crash' });
                    } finally {
                        lock.busy = false;
                        lock.jobId = null;
                    }
                }));

                this.track(Bus.window.on(AJ.FLOW_ABORT, (env) => {
                    if (env && env.jobId === lock.jobId) {
                        root.__cor3Abort = true;
                        this.warn(`FLOW_ABORT — aborting running job ${env.jobId}`);
                    }
                }));
            }
        }
        Registry.register(new SaiFlow());
    }

    root.COR3.autoJobs = root.COR3.autoJobs || {};
    root.COR3.autoJobs.saiFlow = {
        awaitBus, awaitAction, getTransit, getFiles, getLogs, findDownloadsFileId, ensureAccess, defineFlow,
        startSolvers, stopSolvers, findMinigame,
    };
})();
