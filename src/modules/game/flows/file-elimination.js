// src/modules/game/flows/file-elimination.js
// Job type: file_elimination. Deletes all files matching `fileName` on the
// SAI Files tab. Re-queries each iteration (React re-renders after delete).

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Registry, dom, constants: C } = root.COR3;
    const SAI = root.COR3.game.sai;
    const flows = root.COR3.game.flows;
    const MSG = C.MSG;

    async function run(jobId, marketId, serverName, fileName, mod) {
        if (flows.isWatching()) return;
        flows.setWatching(true);

        const sai = await SAI.findOrOpenSai(serverName);
        if (!sai) { flows.sendTimeout(jobId, marketId, { transient: true }); flows.setWatching(false); return; }
        if (!await SAI.navigateToSection(sai, SAI.SEL.FILES)) { flows.sendTimeout(jobId, marketId); flows.setWatching(false); return; }
        if (!await SAI.waitForSaiContent(sai)) { flows.sendTimeout(jobId, marketId); flows.setWatching(false); return; }

        let initialRows = [];
        for (let i = 0; i < 15 && !root.__jobManagerAbort; i++) {
            initialRows = SAI.findAllFileRowsByName(sai, fileName);
            if (initialRows.length > 0) break;
            await dom.sleep(300);
        }
        if (initialRows.length === 0) {
            // List rendered, file isn't in it — already deleted, or job is
            // stale. Permanent skip until next markets refresh confirms.
            mod.warn(`file not found: ${fileName}`);
            flows.userLog(`File Elimination: file "${fileName}" not on "${serverName}" — permanently skipping`, 'warn');
            flows.sendResult(jobId, marketId, { success: true, didWork: false, reason: 'file-not-on-server' });
            flows.setWatching(false);
            return;
        }

        let deletedCount = 0;
        while (!root.__jobManagerAbort) {
            const row = SAI.findFileRowByName(sai, fileName);
            if (!row) break;
            // Files-tab rows lost their TrashIcon data-sentry-component in
            // the May 2026 cor3.gg refactor; clickRowRemove finds the
            // delete button by its position in the action area instead.
            mod.info(`deleting file #${deletedCount + 1}: ${fileName}`);
            if (!SAI.clickRowRemove(row)) {
                mod.warn('delete button not found');
                flows.sendTimeout(jobId, marketId);
                flows.setWatching(false);
                return;
            }
            await dom.sleep(400);
            await SAI.confirmDeleteDialog();
            await dom.sleep(500);
            deletedCount++;
        }

        if (root.__jobManagerAbort) { flows.setWatching(false); return; }
        flows.userLog(`File Elimination done — deleted ${deletedCount} file(s)`, 'ok');
        flows.sendDone(jobId, marketId);
        flows.setWatching(false);
    }

    class FileEliminationFlow extends Module {
        constructor() {
            super({
                id: 'flow-file-elimination',
                name: 'Flow: File Elimination',
                category: C.CATEGORY.GAME,
                dependsOn: ['flows-core', 'sai-navigator'],
                owns: { busTypes: [MSG.JOB.START_FILE_ELIMINATION] },
            });
        }
        async start() {
            this.track(Bus.window.on(MSG.JOB.START_FILE_ELIMINATION, (env) => {
                const { jobId, marketId, serverName, fileCondition } = env;
                flows.startFlow('FileElimination', { jobId, marketId, serverName, fileName: fileCondition },
                    () => run(jobId, marketId, serverName, fileCondition, this), this);
            }));
        }
    }
    Registry.register(new FileEliminationFlow());
})();
