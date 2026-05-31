// Auto-Jobs v2 — Decrypt & Extract flow (MAIN world). jobType: decrypt_extract
// (DecryptExtract). The hybrid: download the job's target file from the server
// into Downloads (SAI front-half, pure WS), then decrypt it exactly like
// file_decryption (loadout ensureDecrypt → open.file → standalone solver wins).
// If the file is already in Downloads (job pre-seeded it), skip the SAI download.
(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    if (!root.COR3 || !root.COR3.constants || !root.COR3.autoJobsV2 || !root.COR3.autoJobsV2.saiFlow) return;
    const C = root.COR3.constants;
    const NODE = C.AJV2.NODE;
    const SF = root.COR3.autoJobsV2.saiFlow;

    function parseExt(name) {
        const s = String(name || '').trim().toLowerCase();
        const i = s.lastIndexOf('.');
        return i >= 0 ? s.slice(i) : '';
    }
    const findFile = (files, name) => {
        const n = String(name || '').toLowerCase();
        return files.find((f) => String((f && f.name) || '').toLowerCase() === n) || null;
    };

    // Open the local Downloads file's minigame and wait for the solver to close
    // it. Returns 'solved' | 'no-minigame' | 'aborted'.
    async function solveLocalFile(fileId, h) {
        h.startSolvers();
        try {
            if (typeof root.__cor3DesktopOpenFile !== 'function') return 'no-minigame';
            root.__cor3DesktopOpenFile(fileId);
            const appearDeadline = Date.now() + 90000;
            let appeared = false;
            while (Date.now() < appearDeadline && !h.abort()) { if (h.findMinigame()) { appeared = true; break; } await h.sleep(250); }
            if (h.abort()) return 'aborted';
            if (!appeared) return 'no-minigame';
            while (h.findMinigame() && !h.abort()) await h.sleep(200);
            return h.abort() ? 'aborted' : 'solved';
        } finally {
            h.stopSolvers();
        }
    }

    SF.defineFlow({
        id: 'flow-v2-decrypt-extract',
        name: 'Flow v2: Decrypt & Extract',
        jobType: C.FLOW.DECRYPT_EXTRACT,
        // job: { jobId, marketId, jobType, serverId, serverType, serverName, fileNames:[…] }
        async run(job, h) {
            h.step(NODE.DE_ACCESS);
            const acc = await h.ensureAccess(job.serverId, job.serverType, job.serverName);
            if (!acc.ok) return { success: false, retryable: acc.retryable !== false, reason: acc.reason };
            if (h.abort()) return { success: false, retryable: true, reason: 'aborted' };

            const LO = (root.COR3.game || {}).loadout;
            if (!LO || typeof LO.ensureDecrypt !== 'function') return { success: false, retryable: true, reason: 'loadout-api-missing' };

            // Read the server's file list once (to map name→fileId for the download).
            h.step(NODE.DE_DOWNLOAD);
            const data = await h.getFiles(job.serverId);
            const serverFiles = (data && Array.isArray(data.files)) ? data.files : [];

            h.step(NODE.DE_SOLVE);
            let solved = 0;
            for (const name of job.fileNames) {
                if (h.abort()) return { success: false, retryable: true, reason: 'aborted' };

                // Already in Downloads? else download it from the server (SAI front-half).
                let fileId = await h.findDownloadsFileId(name);
                if (!fileId) {
                    const sf = findFile(serverFiles, name);
                    if (sf) {
                        await h.awaitAction(15000, () => root.__cor3SaiFileDownload(job.serverId, sf.fileId));
                        await h.sleep(900);
                        fileId = await h.findDownloadsFileId(name);
                    }
                }
                if (!fileId) { h.say('warn', `"${name}" not available locally or on server`); continue; }

                // Gain the decrypt capability for this extension. A failure here is
                // per-FILE: skip this one and try the rest (different extensions may
                // be decryptable) rather than abandoning the whole job on the first.
                const ext = parseExt(name);
                if (!ext) { h.say('warn', `no extension in "${name}"`); continue; }
                const cap = await LO.ensureDecrypt(ext, h.say);
                if (!cap.ok) { h.say('warn', `cannot decrypt ${ext} (${cap.status}) — skipping "${name}"`); continue; }

                const res = await solveLocalFile(fileId, h);
                if (res === 'aborted') return { success: false, retryable: true, reason: 'aborted' };
                if (res === 'no-minigame') { h.say('warn', `minigame did not mount for "${name}"`); continue; }
                solved++;
                h.say('info', `decrypted "${name}"`);
            }

            if (solved === 0) return { success: true, didWork: false, retryable: true, reason: 'no file decrypted this cycle' };

            h.step(NODE.DE_COMPLETE);
            h.complete();
            h.say('info', `Decrypt & Extract: solved ${solved}/${job.fileNames.length} for "${job.serverName}"`);
            return { success: true, didWork: true };
        },
    });
})();
