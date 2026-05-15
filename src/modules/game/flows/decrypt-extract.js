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

    // Same dual-minigame story as file-decryption.js — cor3.gg ships
    // either the legacy config-hack puzzle or the new ICE WALL Break
    // depending on the file. Either solver runs autonomously in MAIN
    // world; we only need to detect appearance + wait for close.
    const MINIGAME_SELS = [
        '[data-sentry-element="LogContentStyled"][data-sentry-source-file="config-hack-application.tsx"]',
        '[data-sentry-component="IceWallBreakApplication"]',
    ];
    function findMinigame() {
        for (const s of MINIGAME_SELS) {
            const el = document.querySelector(s);
            if (el) return el;
        }
        return null;
    }

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
            if (!sai) { flows.sendTimeout(jobId, marketId, { transient: true }); flows.setWatching(false); return; }
            if (!await SAI.navigateToSection(sai, SAI.SEL.FILES)) { flows.sendTimeout(jobId, marketId); flows.setWatching(false); return; }
            if (!await SAI.waitForSaiContent(sai)) { flows.sendTimeout(jobId, marketId); flows.setWatching(false); return; }

            let row = null;
            for (let i = 0; i < 15 && !root.__jobManagerAbort; i++) {
                row = SAI.findFileRowByName(sai, fileName);
                if (row) break;
                await dom.sleep(300);
            }
            if (!row) {
                // 4.5 s of polling, file genuinely isn't on the server.
                // Permanent skip — re-checking in 2 h won't help.
                mod.warn(`file not found on server: ${fileName}`);
                flows.userLog(`Decrypt & Extract: file "${fileName}" not on "${serverName}" — permanently skipping`, 'warn');
                flows.sendResult(jobId, marketId, { success: true, didWork: false, reason: 'file-not-on-server' });
                flows.setWatching(false);
                return;
            }

            // Arm watcher BEFORE clicking download so the new file is
            // identifiable by diff. clickRowDownload uses position-based
            // lookup (DownloadIcon data-sentry-component is gone post-refactor).
            await SAI.downloadsWatcher.arm(10_000);
            if (!SAI.clickRowDownload(row)) {
                mod.warn('download button not found');
                flows.sendTimeout(jobId, marketId);
                flows.setWatching(false);
                return;
            }
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
            if (findMinigame()) { appeared = true; break; }
            await dom.sleep(250);
        }
        if (!appeared) {
            mod.warn('minigame did not appear within 90s (checked both config-hack and ICE WALL Break)');
            flows.sendTimeout(jobId, marketId);
            flows.setWatching(false);
            return;
        }
        while (!root.__jobManagerAbort && findMinigame()) {
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
