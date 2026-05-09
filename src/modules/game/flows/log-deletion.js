// src/modules/game/flows/log-deletion.js
// Job type: log_deletion. Deletes log entries by name (preferred) or seq.
// Note: legacy content.js packs logName as `fileCondition` field on the
// START message — we follow that contract.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Registry, dom, constants: C } = root.COR3;
    const SAI = root.COR3.game.sai;
    const flows = root.COR3.game.flows;
    const MSG = C.MSG;

    async function run(jobId, marketId, serverName, logName, logSeqs, mod) {
        if (flows.isWatching()) return;
        flows.setWatching(true);

        if (!logName && (!logSeqs || !logSeqs.length)) {
            flows.userLog('Log Deletion: no logName or logSeqs — aborting', 'error');
            flows.sendTimeout(jobId, marketId);
            flows.setWatching(false);
            return;
        }

        const sai = await SAI.findOrOpenSai(serverName);
        if (!sai) { flows.sendTimeout(jobId, marketId, { transient: true }); flows.setWatching(false); return; }
        if (!await SAI.navigateToSection(sai, SAI.SEL.LOGS)) { flows.sendTimeout(jobId, marketId); flows.setWatching(false); return; }
        if (!await SAI.waitForSaiContent(sai)) { flows.sendTimeout(jobId, marketId); flows.setWatching(false); return; }

        const deleteCount = (Array.isArray(logSeqs) && logSeqs.length > 0) ? logSeqs.length : 1;
        let deletedCount = 0;

        if (logName) {
            flows.userLog(`Log Deletion: name "${logName}", deleting ${deleteCount}`, 'info');
            while (!root.__jobManagerAbort && deletedCount < deleteCount) {
                let row = null;
                for (let i = 0; i < 15 && !root.__jobManagerAbort; i++) {
                    row = SAI.findLogRowByName(sai, logName);
                    if (row) break;
                    await dom.sleep(300);
                }
                if (!row) {
                    if (deletedCount === 0) {
                        mod.warn(`log not found by name: ${logName}`);
                        flows.sendTimeout(jobId, marketId);
                        flows.setWatching(false);
                        return;
                    }
                    break;
                }
                mod.info(`deleting (${deletedCount + 1}/${deleteCount}): ${logName}`);
                const deleteBtn = row.querySelector(SAI.SEL.TRASH_ICON)?.closest('button');
                if (!deleteBtn) {
                    mod.warn('delete button not found');
                    flows.sendTimeout(jobId, marketId);
                    flows.setWatching(false);
                    return;
                }
                deleteBtn.click();
                await dom.sleep(400);
                await SAI.confirmDeleteDialog();
                await dom.sleep(500);
                deletedCount++;
            }
        } else {
            const targets = [...logSeqs].sort((a, b) => b - a);
            flows.userLog(`Log Deletion: seq fallback [${targets.join(', ')}]`, 'info');
            for (const seq of targets) {
                if (root.__jobManagerAbort) { flows.setWatching(false); return; }
                let row = null;
                for (let i = 0; i < 15 && !root.__jobManagerAbort; i++) {
                    row = SAI.findLogRowByIndex(sai, seq);
                    if (row) break;
                    await dom.sleep(300);
                }
                if (!row) {
                    mod.warn(`log not found by seq: ${seq}`);
                    flows.sendTimeout(jobId, marketId);
                    flows.setWatching(false);
                    return;
                }
                const deleteBtn = row.querySelector(SAI.SEL.TRASH_ICON)?.closest('button');
                if (!deleteBtn) {
                    mod.warn(`delete button not found, seq: ${seq}`);
                    flows.sendTimeout(jobId, marketId);
                    flows.setWatching(false);
                    return;
                }
                deleteBtn.click();
                await dom.sleep(400);
                await SAI.confirmDeleteDialog();
                await dom.sleep(500);
                deletedCount++;
            }
        }

        if (root.__jobManagerAbort) { flows.setWatching(false); return; }
        flows.userLog(`Log Deletion done — ${deletedCount} log(s) deleted`, 'ok');
        flows.sendDone(jobId, marketId);
        flows.setWatching(false);
    }

    class LogDeletionFlow extends Module {
        constructor() {
            super({
                id: 'flow-log-deletion',
                name: 'Flow: Log Deletion',
                category: C.CATEGORY.GAME,
                dependsOn: ['flows-core', 'sai-navigator'],
                owns: { busTypes: [MSG.JOB.START_LOG_DELETION] },
            });
        }
        async start() {
            this.track(Bus.window.on(MSG.JOB.START_LOG_DELETION, (env) => {
                const { jobId, marketId, serverName, fileCondition, logSeqs } = env;
                flows.startFlow('LogDeletion', { jobId, marketId, serverName, logName: fileCondition, logSeqs },
                    () => run(jobId, marketId, serverName, fileCondition, logSeqs, this), this);
            }));
        }
    }
    Registry.register(new LogDeletionFlow());
})();
