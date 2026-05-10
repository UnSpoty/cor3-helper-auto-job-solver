// src/modules/game/flows/data-download.js
// Job type: data_download. Downloads multiple files by name from SAI Files.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Registry, dom, constants: C } = root.COR3;
    const SAI = root.COR3.game.sai;
    const flows = root.COR3.game.flows;
    const MSG = C.MSG;

    async function run(jobId, marketId, serverName, fileNames, mod) {
        if (flows.isWatching()) return;
        flows.setWatching(true);

        const names = Array.isArray(fileNames)
            ? fileNames.filter(Boolean)
            : (fileNames ? [fileNames] : []);

        if (names.length === 0) {
            mod.warn('no file names supplied');
            flows.sendResult(jobId, marketId, { success: true, didWork: false, reason: 'no-file-names' });
            flows.setWatching(false);
            return;
        }

        const sai = await SAI.findOrOpenSai(serverName);
        if (!sai) { flows.sendTimeout(jobId, marketId, { transient: true }); flows.setWatching(false); return; }
        if (!await SAI.navigateToSection(sai, SAI.SEL.FILES)) { flows.sendTimeout(jobId, marketId); flows.setWatching(false); return; }
        if (!await SAI.waitForSaiContent(sai)) { flows.sendTimeout(jobId, marketId); flows.setWatching(false); return; }

        function collectRowsForAllNames() {
            const seen = new Set();
            const out = [];
            for (const name of names) {
                for (const row of SAI.findAllFileRowsByName(sai, name)) {
                    if (!seen.has(row)) { seen.add(row); out.push(row); }
                }
            }
            return out;
        }

        let rows = [];
        for (let i = 0; i < 15 && !root.__jobManagerAbort; i++) {
            rows = collectRowsForAllNames();
            if (rows.length >= names.length) break;
            await dom.sleep(300);
        }

        if (rows.length === 0) {
            mod.warn(`no matching files found: ${names.join(', ')}`);
            flows.userLog(`Data Download: no files match [${names.join(', ')}] on "${serverName}" — permanently skipping`, 'warn');
            flows.sendResult(jobId, marketId, { success: true, didWork: false, reason: 'files-not-on-server' });
            flows.setWatching(false);
            return;
        }
        if (rows.length < names.length) {
            mod.warn(`found ${rows.length} row(s) for ${names.length} requested file(s); proceeding`);
        }

        let downloaded = 0;
        for (let idx = 0; idx < rows.length && !root.__jobManagerAbort; idx++) {
            // Position-based action lookup — Files-tab DownloadIcon attr is
            // gone post-refactor; clickRowDownload finds the button by its
            // position in the row's action area.
            if (!SAI.clickRowDownload(rows[idx])) {
                mod.warn(`download button not found for file #${idx + 1}`);
                continue;
            }
            downloaded++;
            await dom.sleep(500);
        }

        if (root.__jobManagerAbort) { flows.setWatching(false); return; }
        flows.userLog(`Data Download done — ${downloaded} file(s)`, 'ok');
        flows.sendDone(jobId, marketId);
        flows.setWatching(false);
    }

    class DataDownloadFlow extends Module {
        constructor() {
            super({
                id: 'flow-data-download',
                name: 'Flow: Data Download',
                category: C.CATEGORY.GAME,
                dependsOn: ['flows-core', 'sai-navigator'],
                owns: { busTypes: [MSG.JOB.START_DATA_DOWNLOAD] },
            });
        }
        async start() {
            this.track(Bus.window.on(MSG.JOB.START_DATA_DOWNLOAD, (env) => {
                const { jobId, marketId, serverName, fileNames } = env;
                flows.startFlow('DataDownload', { jobId, marketId, serverName, fileNames },
                    () => run(jobId, marketId, serverName, fileNames, this), this);
            }));
        }
    }
    Registry.register(new DataDownloadFlow());
})();
