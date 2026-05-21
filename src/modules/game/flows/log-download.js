// src/modules/game/flows/log-download.js
// Job type: log_download. Matches log rows by NAME first; uses logSeqs only
// to disambiguate when several rows share a name.
//
// We tried "seq-first" briefly (May 2026) after a duplicate-name complaint,
// but a follow-up showed seq from the server doesn't always map to a
// position in the visible DOM list (virtualised list / server-side absolute
// seq) — so seq-first regressed the common case where only one row matches
// the name. Name-first is the conservative baseline; seq is the tiebreaker.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Registry, dom, constants: C } = root.COR3;
    const SAI = root.COR3.game.sai;
    const flows = root.COR3.game.flows;
    const MSG = C.MSG;

    async function run(jobId, marketId, serverName, logName, logSeqs, mod) {
        if (flows.isWatching()) return;
        flows.setWatching(true);

        const sai = await SAI.findOrOpenSai(serverName);
        if (!sai) { flows.sendTimeout(jobId, marketId, { transient: true }); flows.setWatching(false); return; }

        // navigateToSection clicks the Logs tab. On servers that have NO
        // Logs section at all (D4RK), the click silently no-ops and we end
        // up acting on whatever tab was open. Detect this immediately so
        // we don't fire "row not found" against unrelated rows. The
        // planner already pre-filters against C.NO_LOGS_SERVERS — this is
        // a defensive guard for new D4RK servers not yet in that list.
        const navigated = await SAI.navigateToSection(sai, SAI.SEL.LOGS);
        if (!navigated || !sai.querySelector(SAI.SEL.LOGS)) {
            flows.userLog(`Log Download: server "${serverName}" has no Logs section — permanently skipping`, 'warn');
            flows.sendResult(jobId, marketId, { success: true, didWork: false, reason: 'no-logs-section' });
            flows.setWatching(false);
            return;
        }
        if (!await SAI.waitForSaiContent(sai)) { flows.sendTimeout(jobId, marketId); flows.setWatching(false); return; }

        const haveSeqs = Array.isArray(logSeqs) && logSeqs.length > 0;
        const downloadCount = haveSeqs ? logSeqs.length : 1;
        const label = logName
            ? `name "${logName}"${haveSeqs ? ` (seq tiebreaker [${logSeqs.join(', ')}])` : ''}`
            : `seq [${logSeqs.join(', ')}]`;
        flows.userLog(`Log Download: ${label}, downloading ${downloadCount}`, 'info');

        let downloadedCount = 0;

        if (logName) {
            for (let i = 0; i < downloadCount && !root.__jobManagerAbort; i++) {
                let rows = [];
                for (let attempt = 0; attempt < 15 && !root.__jobManagerAbort; attempt++) {
                    rows = SAI.findAllLogRowsByName(sai, logName);
                    if (rows.length > 0) break;
                    await dom.sleep(300);
                }
                let row = null;
                if (rows.length === 0) {
                    mod.warn(`no row found by name: ${logName}`);
                    flows.userLog(`Log Download: name "${logName}" not in list`, 'error');
                    break;
                }
                if (rows.length === 1) {
                    row = rows[0];
                } else if (haveSeqs && Number.isInteger(logSeqs[i])) {
                    // Duplicate names — try seq as a positional tiebreaker.
                    // Only accept the seq-row if it's one of the name matches,
                    // otherwise the seq is server-absolute and meaningless here.
                    const seqRow = SAI.findLogRowByIndex(sai, logSeqs[i]);
                    row = (seqRow && rows.includes(seqRow)) ? seqRow : (rows[i] || rows[0]);
                } else {
                    row = rows[i] || rows[0];
                }
                const downloadBtn = row.querySelector(SAI.SEL.DOWNLOAD_ICON)?.closest('button');
                if (!downloadBtn) {
                    flows.userLog(`Log Download: download button not found for row ${i + 1}`, 'error');
                    break;
                }
                downloadBtn.click();
                await dom.sleep(700);
                downloadedCount++;
            }
        } else if (haveSeqs) {
            for (let i = 0; i < logSeqs.length && !root.__jobManagerAbort; i++) {
                let row = null;
                for (let attempt = 0; attempt < 15 && !root.__jobManagerAbort; attempt++) {
                    row = SAI.findLogRowByIndex(sai, logSeqs[i]);
                    if (row) break;
                    await dom.sleep(300);
                }
                if (!row) {
                    flows.userLog(`Log Download: seq ${logSeqs[i]} not found`, 'error');
                    break;
                }
                const downloadBtn = row.querySelector(SAI.SEL.DOWNLOAD_ICON)?.closest('button');
                if (!downloadBtn) {
                    flows.userLog(`Log Download: download button not found for seq ${logSeqs[i]}`, 'error');
                    break;
                }
                downloadBtn.click();
                await dom.sleep(700);
                downloadedCount++;
            }
        } else {
            // Both logName and logSeqs missing — orchestrator handed us a job
            // it shouldn't have. Structural reject so the next planner pass
            // skips it permanently.
            flows.userLog('Log Download: no logName or logSeqs — permanently skipping', 'error');
            flows.sendResult(jobId, marketId, { success: true, didWork: false, reason: 'no-log-target' });
            flows.setWatching(false);
            return;
        }

        if (root.__jobManagerAbort) { flows.setWatching(false); return; }
        if (downloadedCount === 0) {
            // No matching log row was visible. This is the "log not in list"
            // case the user complained about — don't keep retrying it on a
            // 2 h cooldown, surface it as a permanent skip until the markets
            // refresh and confirm the job is gone (or comes back).
            flows.userLog(`Log Download: target log(s) not in list on "${serverName}" — permanently skipping`, 'warn');
            flows.sendResult(jobId, marketId, { success: true, didWork: false, reason: 'log-not-in-list' });
            flows.setWatching(false);
            return;
        }
        flows.userLog(`Log Download done (${downloadedCount}/${downloadCount})`, 'ok');
        flows.sendDone(jobId, marketId);
        flows.setWatching(false);
    }

    class LogDownloadFlow extends Module {
        constructor() {
            super({
                id: 'flow-log-download',
                name: 'Flow: Log Download',
                category: C.CATEGORY.GAME,
                dependsOn: ['flows-core', 'sai-navigator'],
                owns: { busTypes: [MSG.JOB.START_LOG_DOWNLOAD] },
            });
        }
        async start() {
            this.track(Bus.window.on(MSG.JOB.START_LOG_DOWNLOAD, (env) => {
                const { jobId, marketId, serverName, fileCondition, logSeqs } = env;
                flows.startFlow('LogDownload', { jobId, marketId, serverName, logName: fileCondition, logSeqs },
                    () => run(jobId, marketId, serverName, fileCondition, logSeqs, this), this);
            }));
        }
    }
    Registry.register(new LogDownloadFlow());
})();
