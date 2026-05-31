// Auto-Jobs v2 — Data Download flow (MAIN world). jobType: data_download
// (DownloadData). Download the job's target file(s) from the server into the
// player's Downloads, pure WS. Job carries file NAMES → map name→fileId via
// get.files, then file.download (the file lands in Downloads via
// desktop.update.file). No minigame.
(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    if (!root.COR3 || !root.COR3.constants || !root.COR3.autoJobsV2 || !root.COR3.autoJobsV2.saiFlow) return;
    const C = root.COR3.constants;
    const NODE = C.AJV2.NODE;
    const SF = root.COR3.autoJobsV2.saiFlow;

    const findFile = (files, name) => {
        const n = String(name || '').toLowerCase();
        return files.find((f) => String((f && f.name) || '').toLowerCase() === n) || null;
    };

    SF.defineFlow({
        id: 'flow-v2-data-download',
        name: 'Flow v2: Data Download',
        jobType: C.FLOW.DATA_DOWNLOAD,
        // job: { jobId, marketId, jobType, serverId, serverType, serverName, fileNames:[…] }
        async run(job, h) {
            h.step(NODE.DD_ACCESS);
            const acc = await h.ensureAccess(job.serverId, job.serverType, job.serverName);
            if (!acc.ok) return { success: false, retryable: acc.retryable !== false, reason: acc.reason };
            if (h.abort()) return { success: false, retryable: true, reason: 'aborted' };

            h.step(NODE.DD_DOWNLOAD);
            const data = await h.getFiles(job.serverId);
            if (!data) return { success: false, retryable: true, reason: 'get.files timed out' };
            const files = Array.isArray(data.files) ? data.files : [];

            let downloaded = 0, notFound = 0;
            for (const name of job.fileNames) {
                if (h.abort()) return { success: false, retryable: true, reason: 'aborted' };
                const f = findFile(files, name);
                if (!f) { notFound++; h.say('warn', `file "${name}" not on server`); continue; }
                const r = await h.awaitAction(15000, () => root.__cor3SaiFileDownload(job.serverId, f.fileId));
                const ok = r && !r.error;
                if (ok) downloaded++;
                h.say('info', `file.download ${name} (${f.fileId}) → ${ok ? 'downloaded' : 'failed'}`);
            }

            // No target file downloaded: the file may simply not be on the server
            // YET this cycle (or all downloads failed) — RETRY rather than bug it
            // permanently (a bug has no TTL). A genuinely-missing target keeps
            // retrying (visible in the log), never silently lost.
            if (downloaded === 0) return { success: false, retryable: true, reason: `no target file downloaded (${notFound} not found) — retrying` };

            h.step(NODE.DD_COMPLETE);
            h.complete();
            h.say('info', `Data Download: downloaded ${downloaded}/${job.fileNames.length} from "${job.serverName}"`);
            return { success: true, didWork: true };
        },
    });
})();
