// Job type: log_deletion. Matches log rows by NAME first; uses logSeqs only
// to disambiguate when several rows share a name. See log-download.js for
// why seq-first regressed (server-absolute seq ≠ visible DOM position when
// the list is virtualised).
// Note: logName is packed as the `fileCondition` field on the START message.

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

        const haveSeqs = Array.isArray(logSeqs) && logSeqs.length > 0;
        const deleteCount = haveSeqs ? logSeqs.length : 1;
        let deletedCount = 0;

        if (logName) {
            const label = `name "${logName}"${haveSeqs ? ` (seq tiebreaker [${logSeqs.join(', ')}])` : ''}`;
            flows.userLog(`Log Deletion: ${label}, deleting ${deleteCount}`, 'info');
            // For multi-target deletions we still consume rows top-down via
            // findLogRowByName each iteration — once a row is deleted the
            // DOM updates and the next call sees a fresh match.
            for (let i = 0; i < deleteCount && !root.__jobManagerAbort; i++) {
                let rows = [];
                for (let attempt = 0; attempt < 15 && !root.__jobManagerAbort; attempt++) {
                    rows = SAI.findAllLogRowsByName(sai, logName);
                    if (rows.length > 0) break;
                    await dom.sleep(300);
                }
                let row = null;
                if (rows.length === 0) {
                    if (deletedCount === 0) {
                        mod.warn(`log not found by name: ${logName}`);
                        flows.userLog(`Log Deletion: log "${logName}" not in list on "${serverName}" — permanently skipping`, 'warn');
                        flows.sendResult(jobId, marketId, { success: true, didWork: false, reason: 'log-not-in-list' });
                        flows.setWatching(false);
                        return;
                    }
                    break;
                }
                if (rows.length === 1) {
                    row = rows[0];
                } else if (haveSeqs && Number.isInteger(logSeqs[i])) {
                    const seqRow = SAI.findLogRowByIndex(sai, logSeqs[i]);
                    row = (seqRow && rows.includes(seqRow)) ? seqRow : rows[0];
                } else {
                    row = rows[0];
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
        } else if (haveSeqs) {
            // Deleting shifts indices below the target, so go highest-first
            // to keep remaining seqs stable through the loop.
            const targets = [...logSeqs].sort((a, b) => b - a);
            flows.userLog(`Log Deletion: seq [${targets.join(', ')}], deleting ${deleteCount}`, 'info');
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
