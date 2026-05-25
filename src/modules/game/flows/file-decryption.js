// Job type: file_decryption.
// Primary path (when jobs carry a serverside fileId in their conditions):
//   • Send desktop.open.folder via WS to surface the Downloads folder,
//   • Send desktop.open.file via WS to trigger the minigame for the
//     specific file id (no DOM dblclick, no name-matching).
//   • Stay subscribed to desktop.update.file the whole time so we follow
//     the latest fileId if the server re-issues the encrypted file under
//     the same name (common bugged-job symptom — name in conditions ≠
//     name shown in Downloads).
// Fallback path (no fileId, or WS path didn't make a minigame appear in
// time): scrape Downloads via DOM, match by exact name / extension, and
// dblclick. This is the pre-existing behaviour kept intact so flows
// don't regress on legacy queue entries or older market payloads that
// don't ship a fileId.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Registry, dom, constants: C } = root.COR3;
    const SAI = root.COR3.game.sai;
    const flows = root.COR3.game.flows;
    const MSG = C.MSG;

    // Three possible minigames per file:
    //   • config-hack — Porter-style minimax, solved by solver-decrypt.
    //   • ICE WALL Break — pattern matching, solved by solver-ice-wall.
    //   • Simple Decrypt — one-click progress bar, solved by
    //     solver-simple-decrypt. Previously absent here, so files that
    //     rolled into the SimpleDecrypt variant timed out the 90s wait
    //     three times and got marked bugged. Adding the selector lets the
    //     flow recognise the minigame and wait for it to close normally.
    // Whichever opens, the corresponding solver picks it up. Flow only
    // cares about (a) seeing one of them, and (b) waiting until none
    // matches anymore before reporting done.
    const MINIGAME_SELS = [
        '[data-sentry-element="LogContentStyled"][data-sentry-source-file="config-hack-application.tsx"]',
        '[data-sentry-component="IceWallBreakApplication"]',
        '[data-sentry-component="SimpleDecryptApplication"]',
        '[data-component-name="SimpleDecryptApplication"]',
    ];
    function findMinigame() {
        for (const s of MINIGAME_SELS) {
            const el = document.querySelector(s);
            if (el) return el;
        }
        return null;
    }
    const FOLDER_APP_SEL = '[data-component-name="FolderApplication"]';

    // ─── WS-direct file open (fast path) ──────────────────────────────────
    // Resolves the Downloads folder id, fires desktop.open.folder + .open.file
    // via the interceptor's RPCs, and waits for a minigame to appear.
    // Returns true if the minigame mounted within the deadline, false on
    // timeout (caller then walks the DOM path).
    async function tryOpenFileViaWs(targetFileId, mod) {
        if (typeof root.__cor3DesktopOpenFile !== 'function') return false;
        if (typeof root.__cor3DesktopOpenFolder !== 'function') return false;

        // Ensure we know the Downloads folder id. The interceptor caches it
        // from any desktop.get.options frame (including those the game sends
        // on its own). If it never arrived we kick a fresh get.options and
        // wait briefly. This is best-effort — open.file works without the
        // folder being explicitly opened first, but cor3.gg's UI always
        // opens the folder first and we mirror that for byte-for-byte
        // parity.
        let folderId = root.__cor3DownloadFolderId;
        if (!folderId && typeof root.__cor3DesktopGetOptions === 'function') {
            const optsP = new Promise((resolve) => {
                let done = false;
                const unsub = Bus.window.on(MSG.WS.DESKTOP_OPTIONS, () => {
                    if (done) return;
                    done = true;
                    try { unsub(); } catch (_) {}
                    resolve(root.__cor3DownloadFolderId || null);
                });
                root.__cor3DesktopGetOptions();
                setTimeout(() => {
                    if (done) return;
                    done = true;
                    try { unsub(); } catch (_) {}
                    resolve(root.__cor3DownloadFolderId || null);
                }, 4000);
            });
            folderId = await optsP;
        }
        if (folderId) {
            // Subscribe to the folder reply so we have a synchronisation
            // point before the open.file (the game expects the folder to
            // be "open" first). If reply is dropped we still proceed —
            // open.file works standalone.
            const folderP = new Promise((resolve) => {
                let done = false;
                const unsub = Bus.window.on(MSG.WS.DESKTOP_FOLDER, () => {
                    if (done) return;
                    done = true;
                    try { unsub(); } catch (_) {}
                    resolve(true);
                });
                root.__cor3DesktopOpenFolder(folderId);
                setTimeout(() => {
                    if (done) return;
                    done = true;
                    try { unsub(); } catch (_) {}
                    resolve(false);
                }, 3000);
            });
            await folderP;
        } else {
            mod.debug('WS open.file: no Downloads folderId — skipping folder open');
        }

        const sent = root.__cor3DesktopOpenFile(targetFileId);
        if (!sent) {
            mod.warn(`WS open.file: send failed for fileId ${targetFileId} — falling back to DOM`);
            return false;
        }
        mod.info(`WS open.file: dispatched for fileId ${targetFileId}`);

        // Wait for the minigame to render. 30 s is shorter than the DOM
        // path's 60 s because by the time we send open.file the file is
        // already known to exist server-side; we're only waiting for the
        // minigame container to mount.
        const start = Date.now();
        while (!root.__jobManagerAbort && Date.now() - start < 30_000) {
            if (findMinigame()) return true;
            await dom.sleep(250);
        }
        return false;
    }

    // ─── DOM fallback (legacy / no-fileId path) ───────────────────────────
    async function tryOpenFileViaDom(fileCondition) {
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
        if (!fileEl) return { found: false };

        fileEl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
        await dom.sleep(200);
        fileEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));

        const start = Date.now();
        while (!root.__jobManagerAbort && Date.now() - start < 90_000) {
            if (findMinigame()) return { found: true, appeared: true };
            await dom.sleep(250);
        }
        return { found: true, appeared: false };
    }

    async function run(jobId, marketId, fileCondition, initialFileId, mod) {
        if (flows.isWatching()) return;
        flows.setWatching(true);

        if (!fileCondition && !initialFileId) {
            flows.userLog('File Decryption: no fileCondition or fileId — permanently skipping', 'error');
            flows.sendResult(jobId, marketId, { success: true, didWork: false, reason: 'no-file-condition' });
            flows.setWatching(false);
            return;
        }

        // Follow desktop.update.file / desktop.open.file frames during the
        // flow. Server re-issues encrypted files after job.take with a new
        // id under the same name; without this we'd open by the stale id
        // (or by name, which also drifts on locale-mangled filenames).
        let trackedFileId = initialFileId || null;
        const unsubFile = Bus.window.on(MSG.WS.DESKTOP_FILE, (env) => {
            const f = env && env.data && env.data.file;
            if (!f || !f.id) return;
            const matchesName = fileCondition && typeof f.name === 'string'
                ? f.name.toLowerCase() === fileCondition.toLowerCase()
                : false;
            // Match policy:
            //   • If we already have a fileId, only follow updates that
            //     keep the same name (server re-issuing the same file).
            //   • If we don't yet have a fileId, latch onto the first
            //     name-matching push — that's the file the take created.
            if (!trackedFileId && matchesName) {
                trackedFileId = f.id;
                mod.info(`File Decryption: latched fileId from push (name=${f.name})`);
            } else if (trackedFileId && matchesName && f.id !== trackedFileId) {
                mod.info(`File Decryption: fileId rotated ${trackedFileId} → ${f.id}`);
                trackedFileId = f.id;
            }
        });

        try {
            // Fast path: WS-direct open if we know the id. The DOM-name
            // mismatch and "file not in Downloads" failure modes — which
            // are the ones that turn jobs bugged after MAX_FLOW_ATTEMPTS —
            // are entirely bypassed here. If it doesn't make the minigame
            // appear within 30s we fall through to DOM.
            let appeared = false;
            if (trackedFileId) {
                appeared = await tryOpenFileViaWs(trackedFileId, mod);
                if (appeared) {
                    mod.info('File Decryption: WS path succeeded');
                }
            }

            // DOM fallback. Either we never had a fileId, or the WS path
            // timed out (rare — usually means the server rejected open.file
            // silently because the file id is stale). Falling back to the
            // name-matched dblclick costs us at most another 60s before we
            // hand back a real failure.
            if (!appeared) {
                if (!fileCondition) {
                    mod.warn('File Decryption: WS path failed and no fileCondition for DOM fallback');
                    flows.sendTimeout(jobId, marketId);
                    return;
                }
                if (trackedFileId) mod.warn('File Decryption: WS path timed out — trying DOM path');
                const r = await tryOpenFileViaDom(fileCondition);
                if (!r.found) {
                    if (root.__jobManagerAbort) return;
                    flows.userLog(`File Decryption: file "${fileCondition}" not in Downloads — permanently skipping`, 'warn');
                    flows.sendResult(jobId, marketId, { success: true, didWork: false, reason: 'file-not-in-downloads' });
                    return;
                }
                if (!r.appeared) {
                    mod.warn('Minigame did not appear within 90s (config-hack / ICE WALL / Simple Decrypt)');
                    flows.sendTimeout(jobId, marketId);
                    return;
                }
                appeared = true;
            }

            // Wait for the minigame to close. The actual solver (decrypt /
            // ice-wall / simple-decrypt) runs independently and clicks
            // until done. We just poll until no selector matches.
            while (!root.__jobManagerAbort && findMinigame()) {
                await dom.sleep(100);
            }
            if (root.__jobManagerAbort) return;
            flows.sendDone(jobId, marketId);
        } finally {
            try { unsubFile(); } catch (_) {}
            flows.setWatching(false);
        }
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
                const { jobId, marketId, fileCondition, fileId } = env;
                flows.startFlow('FileDecryption', { jobId, marketId, fileCondition, fileId },
                    () => run(jobId, marketId, fileCondition, fileId || null, this), this);
            }));
        }
    }
    Registry.register(new FileDecryptionFlow());
})();
