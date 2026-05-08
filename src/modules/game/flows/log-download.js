// src/modules/game/flows/log-download.js
// Job type: log_download. Downloads log entries by name (preferred) or seq.

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
        if (!sai) { flows.sendTimeout(jobId, marketId); flows.setWatching(false); return; }
        if (!await SAI.navigateToSection(sai, SAI.SEL.LOGS)) { flows.sendTimeout(jobId, marketId); flows.setWatching(false); return; }
        if (!await SAI.waitForSaiContent(sai)) { flows.sendTimeout(jobId, marketId); flows.setWatching(false); return; }

        const downloadCount = (Array.isArray(logSeqs) && logSeqs.length > 0) ? logSeqs.length : 1;
        flows.userLog(`Log Download: name "${logName}", downloading ${downloadCount}`, 'info');

        let downloadedCount = 0;

        if (logName) {
            for (let i = 0; i < downloadCount && !root.__jobManagerAbort; i++) {
                let rows = [];
                for (let attempt = 0; attempt < 15 && !root.__jobManagerAbort; attempt++) {
                    rows = SAI.findAllLogRowsByName(sai, logName);
                    if (rows.length > i) break;
                    await dom.sleep(300);
                }
                const row = rows[i] || null;
                if (!row) {
                    mod.warn(`row ${i} not found for: ${logName}`);
                    flows.userLog(`Log Download: row ${i + 1}/${downloadCount} not found`, 'error');
                    break;
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
        } else if (Array.isArray(logSeqs) && logSeqs.length > 0) {
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
            flows.userLog('Log Download: no logName or logSeqs — aborting', 'error');
            flows.sendTimeout(jobId, marketId);
            flows.setWatching(false);
            return;
        }

        if (root.__jobManagerAbort) { flows.setWatching(false); return; }
        if (downloadedCount === 0) {
            flows.userLog('Log Download: nothing downloaded', 'error');
            flows.sendTimeout(jobId, marketId);
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
