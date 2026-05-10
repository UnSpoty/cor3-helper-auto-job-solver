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
            flows.userLog('Log Deletion: no logName or logSeqs — permanently skipping', 'error');
            flows.sendResult(jobId, marketId, { success: true, didWork: false, reason: 'no-log-target' });
            flows.setWatching(false);
            return;
        }

        const sai = await SAI.findOrOpenSai(serverName);
        if (!sai) { flows.sendTimeout(jobId, marketId, { transient: true }); flows.setWatching(false); return; }

        // Same D4RK guard as log-download: if the Logs tab simply isn't
        // present, we'd silently delete from whatever section is open.
        const navigated = await SAI.navigateToSection(sai, SAI.SEL.LOGS);
        if (!navigated || !sai.querySelector(SAI.SEL.LOGS)) {
            flows.userLog(`Log Deletion: server "${serverName}" has no Logs section — permanently skipping`, 'warn');
            flows.sendResult(jobId, marketId, { success: true, didWork: false, reason: 'no-logs-section' });
            flows.setWatching(false);
            return;
        }
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
                        // The whole list rendered, the named log just isn't
                        // there — likely the server's existing logs predate
                        // the job, or it was already deleted. Permanent skip
                        // (not 2 h bug); markets refresh will confirm if
                        // the job stays around.
                        mod.warn(`log not found by name: ${logName}`);
                        flows.userLog(`Log Deletion: log "${logName}" not in list on "${serverName}" — permanently skipping`, 'warn');
                        flows.sendResult(jobId, marketId, { success: true, didWork: false, reason: 'log-not-in-list' });
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
                    flows.userLog(`Log Deletion: seq ${seq} not in list on "${serverName}" — permanently skipping`, 'warn');
                    flows.sendResult(jobId, marketId, { success: true, didWork: false, reason: 'log-not-in-list' });
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
