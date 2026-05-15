// src/modules/game/flows/file-decryption.js
// Job type: file_decryption.
// Opens Downloads folder, finds target file by exact name or extension,
// double-clicks it to launch the config-hack minigame, waits for the solver
// to close it, reports done.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Registry, dom, constants: C } = root.COR3;
    const SAI = root.COR3.game.sai;
    const flows = root.COR3.game.flows;
    const MSG = C.MSG;

    // May 2026: cor3.gg ships TWO different minigames for file decryption
    // depending on the file. We treat either as "minigame appeared":
    //   • Legacy config-hack — Porter-style minimax, solved by solver-decrypt.
    //   • ICE WALL Break — pattern matching, solved by solver-ice-wall.
    // Whichever opens, the corresponding solver picks it up. Flow only
    // cares about (a) seeing one of them, and (b) waiting for both to be
    // gone before reporting done.
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
    const FOLDER_APP_SEL = '[data-component-name="FolderApplication"]';

    async function run(jobId, marketId, fileCondition, mod) {
        if (flows.isWatching()) return;
        flows.setWatching(true);

        if (!fileCondition) {
            flows.userLog('File Decryption: no fileCondition — permanently skipping', 'error');
            flows.sendResult(jobId, marketId, { success: true, didWork: false, reason: 'no-file-condition' });
            flows.setWatching(false);
            return;
        }

        await SAI.downloadsWatcher.openFolder(30_000);

        const needle = fileCondition.toLowerCase();
        const isExtOnly = needle.startsWith('.');
        flows.userLog(`File Decryption: looking for "${fileCondition}"`, 'info');

        function matchesFile(item) {
            const nameDiv = [...item.children].find((c) => c.tagName === 'DIV' && !c.classList.contains('folder-application-icon'));
            const fname = nameDiv?.textContent.trim().toLowerCase() || '';
            return isExtOnly ? fname.endsWith(needle) : fname === needle;
        }

        let fileEl = null;
        const deadline = Date.now() + 60_000;
        while (!root.__jobManagerAbort && Date.now() < deadline && !fileEl) {
            const app = document.querySelector(FOLDER_APP_SEL);
            if (app) {
                for (const item of app.querySelectorAll('.folder-application[data-app-id]')) {
                    if (matchesFile(item)) { fileEl = item; break; }
                }
            }
            if (!fileEl) await dom.sleep(500);
        }

        if (!fileEl) {
            if (root.__jobManagerAbort) { flows.setWatching(false); return; }
            // 60 s of polling and the file never appeared in Downloads.
            // This isn't a runtime crash — the file genuinely isn't there.
            // Treat as a structural skip until next refresh confirms.
            flows.userLog(`File Decryption: file "${fileCondition}" not in Downloads — permanently skipping`, 'warn');
            flows.sendResult(jobId, marketId, { success: true, didWork: false, reason: 'file-not-in-downloads' });
            flows.setWatching(false);
            return;
        }

        fileEl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
        await dom.sleep(200);
        fileEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));

        const start = Date.now();
        let appeared = false;
        while (!root.__jobManagerAbort && Date.now() - start < 90_000) {
            if (findMinigame()) { appeared = true; break; }
            await dom.sleep(250);
        }
        if (!appeared) {
            mod.warn('Minigame did not appear within 90s (checked both config-hack and ICE WALL Break)');
            flows.sendTimeout(jobId, marketId);
            flows.setWatching(false);
            return;
        }
        // Wait for the minigame to close. The actual solver (decrypt or
        // ice-wall) runs independently and clicks until done. We just
        // poll until neither selector matches anything.
        while (!root.__jobManagerAbort && findMinigame()) {
            await dom.sleep(100);
        }
        if (root.__jobManagerAbort) { flows.setWatching(false); return; }
        flows.sendDone(jobId, marketId);
        flows.setWatching(false);
    }

    class FileDecryptionFlow extends Module {
        constructor() {
            super({
                id: 'flow-file-decryption',
                name: 'Flow: File Decryption',
                category: C.CATEGORY.GAME,
                dependsOn: ['flows-core', 'sai-navigator'],
                owns: { busTypes: [MSG.JOB.START_DECRYPTION] },
            });
        }
        async start() {
            this.track(Bus.window.on(MSG.JOB.START_DECRYPTION, (env) => {
                const { jobId, marketId, fileCondition } = env;
                flows.startFlow('FileDecryption', { jobId, marketId, fileCondition },
                    () => run(jobId, marketId, fileCondition, this), this);
            }));
        }
    }
    Registry.register(new FileDecryptionFlow());
})();
