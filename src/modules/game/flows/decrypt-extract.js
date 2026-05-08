// src/modules/game/flows/decrypt-extract.js
// Job type: decrypt_extract. Downloads file from server (unless already in
// Downloads), opens it in Downloads to launch the config-hack minigame, waits
// for solver to close it.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Registry, dom, constants: C } = root.COR3;
    const SAI = root.COR3.game.sai;
    const flows = root.COR3.game.flows;
    const MSG = C.MSG;

    const MINIGAME_SEL = '[data-sentry-element="LogContentStyled"][data-sentry-source-file="config-hack-application.tsx"]';

    async function run(jobId, marketId, serverName, fileName, mod) {
        if (flows.isWatching()) return;
        flows.setWatching(true);

        let fileEl = null;

        // Already in Downloads?
        const existingFile = await SAI.findFileInDownloads(fileName, 5_000);
        if (existingFile) {
            mod.info(`file already in Downloads: ${fileName}`);
            fileEl = existingFile;
        } else {
            // Download from server
            const sai = await SAI.findOrOpenSai(serverName);
            if (!sai) { flows.sendTimeout(jobId, marketId); flows.setWatching(false); return; }
            if (!await SAI.navigateToSection(sai, SAI.SEL.FILES)) { flows.sendTimeout(jobId, marketId); flows.setWatching(false); return; }
            if (!await SAI.waitForSaiContent(sai)) { flows.sendTimeout(jobId, marketId); flows.setWatching(false); return; }

            let row = null;
            for (let i = 0; i < 15 && !root.__jobManagerAbort; i++) {
                row = SAI.findFileRowByName(sai, fileName);
                if (row) break;
                await dom.sleep(300);
            }
            if (!row) {
                mod.warn(`file not found on server: ${fileName}`);
                flows.sendTimeout(jobId, marketId);
                flows.setWatching(false);
                return;
            }

            const downloadBtn = row.querySelector(SAI.SEL.DOWNLOAD_ICON)?.closest('button');
            if (!downloadBtn) {
                mod.warn('download button not found');
                flows.sendTimeout(jobId, marketId);
                flows.setWatching(false);
                return;
            }

            // Arm watcher BEFORE clicking download so the new file is identifiable by diff
            await SAI.downloadsWatcher.arm(10_000);
            downloadBtn.click();
            mod.info('download triggered, waiting for file in Downloads…');

            fileEl = await SAI.downloadsWatcher.waitForNewFile(30_000);
            if (!fileEl && !root.__jobManagerAbort) {
                mod.warn('new file not detected in Downloads after 30s');
            }
        }

        if (fileEl && !root.__jobManagerAbort) {
            fileEl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
            await dom.sleep(200);
            fileEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        }

        const start = Date.now();
        let appeared = false;
        while (!root.__jobManagerAbort && Date.now() - start < 90_000) {
            if (document.querySelector(MINIGAME_SEL)) { appeared = true; break; }
            await dom.sleep(250);
        }
        if (!appeared) {
            mod.warn('minigame did not appear within 90s');
            flows.sendTimeout(jobId, marketId);
            flows.setWatching(false);
            return;
        }
        while (!root.__jobManagerAbort && document.querySelector(MINIGAME_SEL)) {
            await dom.sleep(100);
        }
        if (root.__jobManagerAbort) { flows.setWatching(false); return; }
        flows.userLog('Decrypt & Extract done', 'ok');
        flows.sendDone(jobId, marketId);
        flows.setWatching(false);
    }

    class DecryptExtractFlow extends Module {
        constructor() {
            super({
                id: 'flow-decrypt-extract',
                name: 'Flow: Decrypt & Extract',
                category: C.CATEGORY.GAME,
                dependsOn: ['flows-core', 'sai-navigator'],
                owns: { busTypes: [MSG.JOB.START_DECRYPT_EXTRACT] },
            });
        }
        async start() {
            this.track(Bus.window.on(MSG.JOB.START_DECRYPT_EXTRACT, (env) => {
                const { jobId, marketId, serverName, fileCondition } = env;
                flows.startFlow('DecryptExtract', { jobId, marketId, serverName, fileCondition },
                    () => run(jobId, marketId, serverName, fileCondition, this), this);
            }));
        }
    }
    Registry.register(new DecryptExtractFlow());
})();
