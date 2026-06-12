// Auto Jobs — File Decryption flow (MAIN world).
//
// Per the design rules: no fallbacks, log under its own id. It is the
// MAIN-world executor for the JOB_FLOW node when the job type is
// file_decryption — the most unique flow because it manages the loadout
// before it can solve.
//
// Protocol (see constants.AJ / MSG.AUTOJOBS):
//   isolated orchestrator → FLOW_START { jobId, marketId, type, fileCondition }
//   this module            → FLOW_RESULT { jobId, marketId, success, didWork, reason }
//
// Steps (the file_decryption sub-flowchart):
//   1. Read the file format (extension) from the job's fileCondition.
//   2. Ask the loadout whether we can decrypt it (COR3.game.loadout):
//        ready   → proceed
//        install → install an owned, capable, resource-fitting software
//        swap    → unequip everything, then install the capable software
//        none    → MARK_AS_BUGGED (report didWork:false) — we can't do this job
//   3. Open the file from the on-screen Downloads folder; the file's minigame
//      mounts (config-hack / ICE WALL / Simple Decrypt).
//   4. Run the standalone solvers (START_* — generic MSG.SOLVER infra) and
//      wait for the minigame to close. The orchestrator is parked on
//      FLOW_RESULT the whole time, so the loop is effectively paused for
//      the duration of the minigame (the "JOB-FLOW must stop during Decrypt"
//      requirement).
//   5. Send job.complete and report success.
//
// Reuses shared infra only: the desktop WS helpers (__cor3DesktopGetOptions /
// OpenFolder / OpenFile — find + open the file, no DOM scrape), COR3.game.loadout
// (capability API from loadout-panel), the MSG.SOLVER.* watchers, and the
// __cor3CompleteJob WS helper.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    if (!root.COR3 || !root.COR3.constants || !root.COR3.Bus) return;
    const { Module, Bus, Registry, dom, constants: C } = root.COR3;
    const MSG = C.MSG;
    const AJ = MSG.AUTOJOBS;
    const NODE = C.AJ.NODE;

    function game() { return root.COR3.game || {}; }

    // The three minigames a decrypt file can open. We only care that ONE is
    // present and, later, that NONE is — the matching solver does the solving.
    const MINIGAME_SELS = [
        '[data-sentry-element="LogContentStyled"][data-sentry-source-file="config-hack-application.tsx"]',
        '[data-sentry-component="IceWallBreakApplication"]',
        '[data-sentry-component="SimpleDecryptApplication"]',
        '[data-component-name="SimpleDecryptApplication"]',
    ];

    function findMinigame() {
        for (const s of MINIGAME_SELS) { const el = document.querySelector(s); if (el) return el; }
        return null;
    }

    // file_decryption jobs carry either a bare extension (".12vsh") or a full
    // file name ("payload.12vsh"). The loadout capability check needs the
    // extension; matching in Downloads uses the raw condition.
    function parseExt(fileCondition) {
        const s = String(fileCondition || '').trim().toLowerCase();
        if (!s) return '';
        if (s.startsWith('.')) return s;
        const i = s.lastIndexOf('.');
        return i >= 0 ? s.slice(i) : '';
    }

    // Await the next Bus.window message of `type` after firing `trigger()`,
    // resolving with the envelope (or null on timeout). The interceptor relays
    // desktop WS replies (open.folder/get.options responses) onto the bus, so
    // this reads them without scraping the DOM.
    function awaitBus(type, timeoutMs, trigger) {
        return new Promise((resolve) => {
            let done = false;
            const finish = (v) => { if (done) return; done = true; try { unsub(); } catch (_) { /* noop */ } clearTimeout(timer); resolve(v); };
            const unsub = Bus.window.on(type, (env) => finish(env));
            const timer = setTimeout(() => finish(null), timeoutMs);
            try { trigger(); } catch (_) { finish(null); }
        });
    }

    // Resolve the Downloads fileId for `fileCondition` purely over WS: open the
    // Downloads folder (desktop.open.folder) and match the returned files[] by
    // exact name, or by extension when the condition is a bare ".ext". The
    // Downloads folder id is cached by the interceptor (from the get.options it
    // sees on load); if it isn't in yet, ask for the options once to populate it.
    // No DOM scrape, no FolderApplication window required.
    async function findDownloadsFileId(fileCondition, say, timeoutMs) {
        let folderId = root.__cor3DownloadFolderId;
        if (!folderId) {
            if (typeof root.__cor3DesktopGetOptions !== 'function') { say('error', '__cor3DesktopGetOptions WS helper missing'); return null; }
            await awaitBus(MSG.WS.DESKTOP_OPTIONS, 8_000, () => root.__cor3DesktopGetOptions());
            folderId = root.__cor3DownloadFolderId;
        }
        if (!folderId) { say('warn', 'Downloads folder id unknown (open the desktop in-game once)'); return null; }
        if (typeof root.__cor3DesktopOpenFolder !== 'function') { say('error', '__cor3DesktopOpenFolder WS helper missing'); return null; }
        const resp = await awaitBus(MSG.WS.DESKTOP_FOLDER, timeoutMs, () => root.__cor3DesktopOpenFolder(folderId));
        const files = (resp && resp.data && Array.isArray(resp.data.files)) ? resp.data.files : [];
        const raw = String(fileCondition || '').trim().toLowerCase();
        const isExtOnly = raw.startsWith('.');
        const file = files.find((f) => {
            const name = String((f && f.name) || '').toLowerCase();
            return isExtOnly ? name.endsWith(raw) : name === raw;
        });
        return file ? file.id : null;
    }

    const SOLVER_START = [MSG.SOLVER.START_DECRYPT, MSG.SOLVER.START_ICE_WALL, MSG.SOLVER.START_SIMPLE_DECRYPT];
    // We drive the solvers under the 'flow' owner. All three solvers ref-count
    // owners, so STOP here removes only 'flow' — a user with the standalone
    // Auto-decrypt / Auto-simple-decrypt / Auto ICE WALL toggle on (owner 'user')
    // keeps their watcher after this flow. We DO stop ICE WALL: with Auto ICE WALL
    // OFF (no 'user' owner), the watcher this flow started must not survive it.
    const SOLVER_STOP = [MSG.SOLVER.STOP_DECRYPT, MSG.SOLVER.STOP_ICE_WALL, MSG.SOLVER.STOP_SIMPLE_DECRYPT];
    function startSolvers() { for (const m of SOLVER_START) Bus.window.post(m, { owner: 'flow' }); }
    function stopSolvers() { for (const m of SOLVER_STOP) Bus.window.post(m, { owner: 'flow' }); }

    // Returns the FLOW_RESULT body (minus jobId/marketId). `step(node)` reports
    // the live sub-step to the orchestrator so the pipeline status can show it.
    async function runFileDecryption(job, say) {
        const step = (node) => Bus.window.post(AJ.FLOW_STEP, { jobId: job.jobId, node });

        // ── MODULE:FD_READ_FORMAT ──
        step(NODE.FD_READ_FORMAT);
        const fileCondition = job.fileCondition;
        const ext = parseExt(fileCondition);
        if (!ext) { say('warn', `no file extension in "${fileCondition}"`); return { success: true, didWork: false, reason: 'no-file-extension' }; }
        say('info', `file format: ${ext}`);

        const LO = game().loadout;
        if (!LO || typeof LO.ensureDecrypt !== 'function') return { success: false, retryable: true, reason: 'loadout-api-missing' };

        // ── MODULE:FD_CHECK_LOADOUT (decision) ──
        // requiredPower = the file's CRYPT RATE (encryptionLevel hi). The loadout
        // API equips a tool whose DECRYPT power clears it (swapping hardware if
        // the software alone falls short).
        step(NODE.FD_CHECK_LOADOUT);
        const required = Number(job.requiredPower) || 0;
        // No encryptionLevel band on the job → no power gate. Surface it (don't
        // silently let an underpowered tool through): any covering software is
        // accepted, which can fail the minigame if the file outranks it.
        if (required <= 0) say('warn', `no decrypt-power band for ${ext} — proceeding without a power gate`);
        const plan = LO.planDecrypt(ext, required);
        say('info', `decrypt capability for ${ext}${required ? ` @power ${required}` : ''}: ${plan.status}`);
        if (plan.status === 'install' || plan.status === 'swap') {
            // ── MODULE:FD_INSTALL_SW ──
            step(NODE.FD_INSTALL_SW);
        }
        const cap = await LO.ensureDecrypt(ext, required, say);
        if (!cap.ok) {
            // The ensure result itself carries the retry verdict (`transient`,
            // classified by the loadout API — the one place that knows the status
            // semantics): true for timing races ('unknown'/'no-helper'/
            // 'apply-incomplete') → retry next cycle; false for 'none' (no owned
            // software covers this ext) and 'underpower' (no owned SW+HW reaches
            // the CRYPT RATE) → genuinely undoable, orchestrator bugs it.
            const retryable = cap.transient === true;
            say('warn', `cannot gain decrypt capability for ${ext} (${cap.status})`);
            return { success: true, didWork: false, retryable, reason: cap.reason };
        }

        startSolvers();
        try {
            // ── MODULE:FD_OPEN_DOWNLOADS ── find the file in Downloads over WS
            // (desktop.open.folder → match files[]), no DOM scrape.
            step(NODE.FD_OPEN_DOWNLOADS);
            say('info', `looking for "${fileCondition}" in Downloads (WS)`);
            const fileId = await findDownloadsFileId(fileCondition, say, 60_000);
            if (!fileId) { say('warn', `file "${fileCondition}" not in Downloads`); return { success: true, didWork: false, retryable: true, reason: 'file-not-in-downloads' }; }

            // ── MODULE:FD_SOLVE ── open the file via a direct WS request, NOT a
            // DOM double-click. A cor3.gg update made double-clicking a file open
            // a "File Analysis" info window first (desktop.get.file.analysis →
            // FileAnalysisProtocol) that must be dismissed with a "Decrypt"
            // button — the minigame no longer mounts from the double-click. The
            // raw open.file the helper sends still starts the minigame directly
            // (verified live: no analysis window, IceWallBreak/SimpleDecrypt
            // mounts), bypassing that step.
            step(NODE.FD_SOLVE);
            if (typeof root.__cor3DesktopOpenFile !== 'function') { say('error', '__cor3DesktopOpenFile WS helper missing'); return { success: false, retryable: true, reason: 'open-file-helper-missing' }; }
            root.__cor3DesktopOpenFile(fileId);

            const appearDeadline = Date.now() + 90_000;
            let appeared = false;
            while (Date.now() < appearDeadline && !root.__cor3Abort) {
                if (findMinigame()) { appeared = true; break; }
                await dom.sleep(250);
            }
            if (root.__cor3Abort) { say('warn', 'aborted by orchestrator before minigame opened'); return { success: false, retryable: true, reason: 'aborted' }; }
            if (!appeared) { say('warn', 'minigame did not appear within 90s'); return { success: false, retryable: true, reason: 'minigame-did-not-appear' }; }

            say('info', 'minigame open — waiting for solver to finish');
            // Bounded by the abort flag: on STOP / FLOW_TIMEOUT the
            // orchestrator posts FLOW_ABORT (→ __cor3Abort), so this can
            // never spin forever on a minigame the solver fails to close (which
            // would otherwise hang the flow and leave `busy` stuck true).
            while (findMinigame() && !root.__cor3Abort) await dom.sleep(200);
            if (root.__cor3Abort) { say('warn', 'aborted by orchestrator during solve'); return { success: false, retryable: true, reason: 'aborted' }; }

            // ── MODULE:FD_COMPLETE ──
            step(NODE.FD_COMPLETE);
            if (typeof root.__cor3CompleteJob === 'function') root.__cor3CompleteJob(job.jobId, job.marketId);
            else Bus.window.post(MSG.GAME.COMPLETE_JOB, { jobId: job.jobId, marketId: job.marketId });
            say('info', 'minigame solved — job.complete sent');
            return { success: true, didWork: true };
        } finally {
            stopSolvers();
        }
    }

    // Cross-module busy guard. ALL Auto Jobs flow modules (this one + every defineFlow
    // SAI flow) share ONE lock so at most one flow ever runs at a time. The
    // orchestrator already serialises dispatch (it parks on each FLOW_RESULT),
    // but on a FLOW_TIMEOUT it aborts and moves on while the old flow is still
    // unwinding; a per-module flag would let the next cycle's DIFFERENT-type flow
    // start concurrently and reset the shared __cor3Abort out from under the
    // aborting flow. A single global lock makes that next flow reply 'flow-busy'
    // and wait one cycle until the old one finishes, so only one flow ever touches
    // the SAI session / abort flag. `jobId` is the in-flight job (FLOW_ABORT matches it).
    const lock = (root.__cor3FlowLock = root.__cor3FlowLock || { busy: false, jobId: null });

    class FileDecryptionFlow extends Module {
        constructor() {
            super({
                id: 'flow-file-decryption',
                name: 'Flow: File Decryption',
                category: C.CATEGORY.GAME,
                dependsOn: ['loadout-panel'],
                owns: { busTypes: [AJ.FLOW_START, AJ.FLOW_RESULT, AJ.FLOW_ABORT] },
            });
        }

        async start() {
            this.track(Bus.window.on(AJ.FLOW_START, async (env) => {
                // `jobType` (not `type`): the Bus envelope's own `type` field is
                // the message id (COR3_AJ_FLOW_START), so the job's type rides
                // on a differently-named key.
                if (!env || env.jobType !== C.FLOW.FILE_DECRYPTION) return;  // not this flow's type
                if (lock.busy) {
                    this.warn(`FLOW_START ignored — a flow is already running (job ${env.jobId})`);
                    // flow-busy is transient (the previous job is still solving):
                    // tell the orchestrator to retry this job, NOT to bug it.
                    Bus.window.post(AJ.FLOW_RESULT, { jobId: env.jobId, marketId: env.marketId, success: false, retryable: true, reason: 'flow-busy' });
                    return;
                }
                lock.busy = true;
                lock.jobId = env.jobId;
                // Shared abort flag — reset BEFORE the run starts (one flow at
                // a time via __cor3FlowLock, same as _sai-flow.js). Resetting
                // it mid-flow (the old placement, after ensureDecrypt) ERASED
                // an abort that arrived during the loadout work, and the flow
                // then solved + completed the job behind a stopped orchestrator.
                root.__cor3Abort = false;
                const say = (lvl, m, ctx) => { const f = this[lvl] || this.info; f.call(this, m, ctx); };
                this.info(`FLOW_START file_decryption job=${env.jobId} file="${env.fileCondition}"`);
                try {
                    const r = await runFileDecryption(env, say);
                    Bus.window.post(AJ.FLOW_RESULT, Object.assign({ jobId: env.jobId, marketId: env.marketId }, r));
                    this.info(`FLOW_RESULT job=${env.jobId} → ${JSON.stringify(r)}`);
                } catch (e) {
                    this.error(`flow crashed for job ${env.jobId}`, { error: String(e), stack: e && e.stack });
                    // retryable:true — an uncaught throw is a TRANSIENT failure
                    // (same policy as the _sai-flow factory); a genuinely
                    // impossible job surfaces via an explicit retryable:false
                    // result, not a crash.
                    Bus.window.post(AJ.FLOW_RESULT, { jobId: env.jobId, marketId: env.marketId, success: false, retryable: true, reason: 'flow-crash' });
                } finally {
                    lock.busy = false;
                    lock.jobId = null;
                }
            }));

            // Orchestrator cancel (STOP / FLOW_TIMEOUT): flip the shared abort
            // flag so runFileDecryption bails out of its wait loops WITHOUT
            // sending job.complete. The SAI/Downloads helpers gate their own
            // loops on the same flag, so a parked openFolder/findFile unblocks
            // too. runFileDecryption resets the flag to false on its next start.
            this.track(Bus.window.on(AJ.FLOW_ABORT, (env) => {
                if (env && env.jobId === lock.jobId) {
                    root.__cor3Abort = true;
                    this.warn(`FLOW_ABORT — aborting running job ${env.jobId}`);
                }
            }));
        }
    }

    Registry.register(new FileDecryptionFlow());
})();
