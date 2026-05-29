// Auto-Jobs v2 — File Decryption flow (MAIN world).
//
// The v2 equivalent of v1's flows/file-decryption.js, written from scratch
// per the v2 rules (no port, no fallbacks, log under its own id). It is the
// MAIN-world executor for the JOB_FLOW node when the job type is
// file_decryption — the most unique flow because it manages the loadout
// before it can solve.
//
// Protocol (see constants.AJV2 / MSG.AUTOJOBS_V2):
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
//      FLOW_RESULT the whole time, so the v2 loop is effectively paused for
//      the duration of the minigame (the "JOB-FLOW must stop during Decrypt"
//      requirement).
//   5. Send job.complete and report success.
//
// Reuses shared game infra only: COR3.game.sai (Downloads helpers),
// COR3.game.loadout (capability API exposed by loadout-panel), the
// MSG.SOLVER.* watchers, and the __cor3CompleteJob WS helper.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    if (!root.COR3 || !root.COR3.constants || !root.COR3.Bus) return;
    const { Module, Bus, Registry, dom, constants: C } = root.COR3;
    const MSG = C.MSG;
    const AJV2 = MSG.AUTOJOBS_V2;
    const NODE = C.AJV2.NODE;

    function game() { return root.COR3.game || {}; }

    // The three minigames a decrypt file can open. We only care that ONE is
    // present and, later, that NONE is — the matching solver does the solving.
    const MINIGAME_SELS = [
        '[data-sentry-element="LogContentStyled"][data-sentry-source-file="config-hack-application.tsx"]',
        '[data-sentry-component="IceWallBreakApplication"]',
        '[data-sentry-component="SimpleDecryptApplication"]',
        '[data-component-name="SimpleDecryptApplication"]',
    ];
    const FOLDER_APP_SEL = '[data-component-name="FolderApplication"]';

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

    function fileRowName(item) {
        const nameDiv = [...item.children].find((c) => c.tagName === 'DIV' && !c.classList.contains('folder-application-icon'));
        return (nameDiv && nameDiv.textContent ? nameDiv.textContent : '').trim().toLowerCase();
    }

    async function findFileEl(needle, isExtOnly, timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const app = document.querySelector(FOLDER_APP_SEL);
            if (app) {
                for (const item of app.querySelectorAll('.folder-application[data-app-id]')) {
                    const name = fileRowName(item);
                    if (isExtOnly ? name.endsWith(needle) : name === needle) return item;
                }
            }
            await dom.sleep(500);
        }
        return null;
    }

    const SOLVER_START = [MSG.SOLVER.START_DECRYPT, MSG.SOLVER.START_ICE_WALL, MSG.SOLVER.START_SIMPLE_DECRYPT];
    const SOLVER_STOP = [MSG.SOLVER.STOP_DECRYPT, MSG.SOLVER.STOP_ICE_WALL, MSG.SOLVER.STOP_SIMPLE_DECRYPT];
    function startSolvers() { for (const m of SOLVER_START) Bus.window.post(m, null); }
    function stopSolvers() { for (const m of SOLVER_STOP) Bus.window.post(m, null); }

    // Returns the FLOW_RESULT body (minus jobId/marketId). `step(node)` reports
    // the live sub-step to the orchestrator so the Flow Map can highlight it.
    async function runFileDecryption(job, say) {
        const step = (node) => Bus.window.post(AJV2.FLOW_STEP, { jobId: job.jobId, node });

        // ── MODULE:FD_READ_FORMAT ──
        step(NODE.FD_READ_FORMAT);
        const fileCondition = job.fileCondition;
        const ext = parseExt(fileCondition);
        if (!ext) { say('warn', `no file extension in "${fileCondition}"`); return { success: true, didWork: false, reason: 'no-file-extension' }; }
        say('info', `file format: ${ext}`);

        const LO = game().loadout;
        if (!LO || typeof LO.ensureDecrypt !== 'function') return { success: false, reason: 'loadout-api-missing' };

        // ── MODULE:FD_CHECK_LOADOUT (decision) ──
        step(NODE.FD_CHECK_LOADOUT);
        const plan = LO.planDecrypt(ext);
        say('info', `decrypt capability for ${ext}: ${plan.status}`);
        if (plan.status === 'install' || plan.status === 'swap') {
            // ── MODULE:FD_INSTALL_SW ──
            step(NODE.FD_INSTALL_SW);
        }
        const cap = await LO.ensureDecrypt(ext, say);
        if (!cap.ok) {
            // none / install-failed → cannot do this job → orchestrator bugs it.
            say('warn', `cannot gain decrypt capability for ${ext} (${cap.status})`);
            return { success: true, didWork: false, reason: cap.reason || `no-decrypt-capability:${ext}` };
        }

        const SAI = game().sai;
        if (!SAI || !SAI.downloadsWatcher) return { success: false, reason: 'sai-helpers-missing' };

        // Shared Downloads/SAI helpers gate their loops on this flag; v1 may
        // have left it set. (Runtime flag, not v1 storage/messages.)
        root.__jobManagerAbort = false;

        startSolvers();
        try {
            // ── MODULE:FD_OPEN_DOWNLOADS ──
            step(NODE.FD_OPEN_DOWNLOADS);
            const folder = await SAI.downloadsWatcher.openFolder(30_000);
            if (!folder) return { success: false, reason: 'downloads-folder-not-open' };

            const raw = String(fileCondition || '').trim();
            const isExtOnly = raw.startsWith('.');
            const needle = raw.toLowerCase();
            say('info', `looking for "${fileCondition}" in Downloads`);
            const fileEl = await findFileEl(needle, isExtOnly, 60_000);
            if (!fileEl) { say('warn', `file "${fileCondition}" not in Downloads`); return { success: true, didWork: false, reason: 'file-not-in-downloads' }; }

            // ── MODULE:FD_SOLVE ──
            step(NODE.FD_SOLVE);
            fileEl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
            await dom.sleep(200);
            fileEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));

            const appearDeadline = Date.now() + 90_000;
            let appeared = false;
            while (Date.now() < appearDeadline) {
                if (findMinigame()) { appeared = true; break; }
                await dom.sleep(250);
            }
            if (!appeared) { say('warn', 'minigame did not appear within 90s'); return { success: false, reason: 'minigame-did-not-appear' }; }

            say('info', 'minigame open — waiting for solver to finish');
            while (findMinigame()) await dom.sleep(200);

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

    let busy = false;

    class FileDecryptionV2Flow extends Module {
        constructor() {
            super({
                id: 'flow-v2-file-decryption',
                name: 'Flow v2: File Decryption',
                category: C.CATEGORY.GAME,
                dependsOn: ['sai-navigator', 'loadout-panel'],
                owns: { busTypes: [AJV2.FLOW_START, AJV2.FLOW_RESULT] },
            });
        }

        async start() {
            this.track(Bus.window.on(AJV2.FLOW_START, async (env) => {
                // `jobType` (not `type`): the Bus envelope's own `type` field is
                // the message id (COR3_AJV2_FLOW_START), so the job's type rides
                // on a differently-named key.
                if (!env || env.jobType !== C.FLOW.FILE_DECRYPTION) return;  // not this flow's type
                if (busy) {
                    this.warn(`FLOW_START ignored — a flow is already running (job ${env.jobId})`);
                    Bus.window.post(AJV2.FLOW_RESULT, { jobId: env.jobId, marketId: env.marketId, success: false, reason: 'flow-busy' });
                    return;
                }
                busy = true;
                const say = (lvl, m, ctx) => { const f = this[lvl] || this.info; f.call(this, m, ctx); };
                this.info(`FLOW_START file_decryption job=${env.jobId} file="${env.fileCondition}"`);
                try {
                    const r = await runFileDecryption(env, say);
                    Bus.window.post(AJV2.FLOW_RESULT, Object.assign({ jobId: env.jobId, marketId: env.marketId }, r));
                    this.info(`FLOW_RESULT job=${env.jobId} → ${JSON.stringify(r)}`);
                } catch (e) {
                    this.error(`flow crashed for job ${env.jobId}`, { error: String(e), stack: e && e.stack });
                    Bus.window.post(AJV2.FLOW_RESULT, { jobId: env.jobId, marketId: env.marketId, success: false, reason: 'flow-crash' });
                } finally {
                    busy = false;
                }
            }));
        }
    }

    Registry.register(new FileDecryptionV2Flow());
})();
