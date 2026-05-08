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

    const MINIGAME_SEL = '[data-sentry-element="LogContentStyled"][data-sentry-source-file="config-hack-application.tsx"]';
    const FOLDER_APP_SEL = '[data-component-name="FolderApplication"]';

    async function run(jobId, marketId, fileCondition, mod) {
        if (flows.isWatching()) return;
        flows.setWatching(true);

        if (!fileCondition) {
            flows.userLog('File Decryption: no fileCondition — aborting', 'error');
            flows.sendTimeout(jobId, marketId);
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
            flows.userLog(`File Decryption: file not found ("${fileCondition}") — failing job`, 'error');
            flows.sendTimeout(jobId, marketId);
            flows.setWatching(false);
            return;
        }

        fileEl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
        await dom.sleep(200);
        fileEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));

        const start = Date.now();
        let appeared = false;
        while (!root.__jobManagerAbort && Date.now() - start < 90_000) {
            if (document.querySelector(MINIGAME_SEL)) { appeared = true; break; }
            await dom.sleep(250);
        }
        if (!appeared) {
            mod.warn('Minigame did not appear within 90s');
            flows.sendTimeout(jobId, marketId);
            flows.setWatching(false);
            return;
        }
        while (!root.__jobManagerAbort && document.querySelector(MINIGAME_SEL)) {
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
