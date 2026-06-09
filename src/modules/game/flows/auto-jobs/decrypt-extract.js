// Auto Jobs — Decrypt & Extract flow (MAIN world). jobType: decrypt_extract
// (DecryptExtract). The hybrid: download the job's target file from the server
// into Downloads (SAI front-half, pure WS), then decrypt it exactly like
// file_decryption (loadout ensureDecrypt → open.file → standalone solver wins).
// If the file is already in Downloads (job pre-seeded it), skip the SAI download.
(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    if (!root.COR3 || !root.COR3.constants || !root.COR3.autoJobs || !root.COR3.autoJobs.saiFlow) return;
    const C = root.COR3.constants;
    const NODE = C.AJ.NODE;
    const SF = root.COR3.autoJobs.saiFlow;

    // File-name resolution (resolveFile / parseExt / stemOf / normExt) is shared
    // via the SAI-flow helpers (h.*) — see _sai-flow.js — so data_upload and
    // decrypt_extract resolve cor3.gg's inconsistent file names the same way.

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
        id: 'flow-decrypt-extract',
        name: 'Flow: Decrypt & Extract',
        jobType: C.FLOW.DECRYPT_EXTRACT,
        // job: { jobId, marketId, jobType, serverId, serverType, serverName, fileNames:[…] }
        async run(job, h) {
            h.step(NODE.DE_ACCESS);
            const acc = await h.ensureAccess(job.serverId, job.serverType, job.serverName);
            if (!acc.ok) return { success: false, retryable: acc.retryable !== false, reason: acc.reason };
            if (h.abort()) return { success: false, retryable: true, reason: 'aborted' };

            const LO = (root.COR3.game || {}).loadout;
            if (!LO || typeof LO.ensureDecrypt !== 'function') return { success: false, retryable: true, reason: 'loadout-api-missing' };

            // Read the server's file list once (to resolve the download target).
            h.step(NODE.DE_DOWNLOAD);
            const data = await h.getFiles(job.serverId);
            const serverFiles = (data && Array.isArray(data.files)) ? data.files : [];

            // {id,name,ext} descriptors (back-compat: derive from fileNames if the
            // orchestrator didn't send the richer `files`).
            const descriptors = (Array.isArray(job.files) && job.files.length)
                ? job.files
                : (job.fileNames || []).map((n) => ({ id: null, name: n, ext: null }));

            let solved = 0;
            for (const desc of descriptors) {
                if (h.abort()) return { success: false, retryable: true, reason: 'aborted' };

                // Locate the LOCAL file (by id/name/stem). Not there yet? resolve the
                // SERVER file the same way and download it (SAI front-half). cor3.gg
                // names the same file differently in the condition / on the server /
                // in Downloads, so we match by id → name → stem, never assuming the
                // condition's name is the real one.
                let local = h.resolveFile(await h.listDownloads(), desc, 'id');
                if (!local) {
                    const sf = h.resolveFile(serverFiles, desc, 'fileId');
                    if (sf) {
                        h.say('info', `downloading "${sf.name}" (${sf.fileId}) for "${desc.name}"`);
                        await h.awaitAction(15000, () => root.__cor3SaiFileDownload(job.serverId, sf.fileId));
                        await h.sleep(900);
                        local = h.resolveFile(await h.listDownloads(), desc, 'id');
                    }
                }
                if (!local) { h.say('warn', `"${desc.name}" not found locally or on server (by id/name/stem)`); continue; }

                // Decrypt by the LOCAL file's REAL extension (the encrypted ext the
                // server actually wrote, e.g. ".eb54x" — NOT the condition's ".dat").
                // A failure here is per-FILE: skip and try the rest.
                const ext = h.parseExt(local.name) || h.normExt(desc.ext);
                if (!ext) { h.say('warn', `no extension on "${local.name}"`); continue; }
                const required = Number(job.requiredPower) || 0;
                if (required <= 0) h.say('warn', `no decrypt-power band for ${ext} — proceeding without a power gate`);
                const plan = LO.planDecrypt(ext, required);
                if (plan && (plan.status === 'install' || plan.status === 'swap')) h.step(NODE.DE_INSTALL_SW);
                const cap = await LO.ensureDecrypt(ext, required, h.say);
                if (!cap.ok) { h.say('warn', `cannot decrypt ${ext} (${cap.status}) — skipping "${local.name}"`); continue; }

                h.step(NODE.DE_SOLVE);
                const res = await solveLocalFile(local.id, h);
                if (res === 'aborted') return { success: false, retryable: true, reason: 'aborted' };
                if (res === 'no-minigame') { h.say('warn', `minigame did not mount for "${local.name}"`); continue; }
                solved++;
                h.say('info', `decrypted "${local.name}"`);
            }

            if (solved === 0) return { success: true, didWork: false, retryable: true, reason: 'no file decrypted this cycle' };

            h.step(NODE.DE_COMPLETE);
            h.complete();
            h.say('info', `Decrypt & Extract: solved ${solved}/${job.fileNames.length} for "${job.serverName}"`);
            return { success: true, didWork: true };
        },
    });
})();
