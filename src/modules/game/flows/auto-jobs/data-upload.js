// Auto Jobs — Data Upload flow (MAIN world). jobType: data_upload
// (matches both "data upload" and the legacy "file upload" job name — one type,
// see pipeline JOB_TYPE_KEYWORDS). Push the job's target file(s) from the
// player's Downloads to the server over WS.
//
// file.upload wire: the server's upload DTO is { serverId, name, sizeMb } — it
// rejects a fileId (a local Downloads id means nothing on the target server),
// so we read the source file's name + sizeMb from the Downloads folder object
// and send those. (Earlier { serverId, fileId } guess was rejected with
// "property fileId should not exist; name must be <=128 chars; sizeMb should not
// be empty".)
(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    if (!root.COR3 || !root.COR3.constants || !root.COR3.autoJobs || !root.COR3.autoJobs.saiFlow) return;
    const C = root.COR3.constants;
    const NODE = C.AJ.NODE;
    const SF = root.COR3.autoJobs.saiFlow;

    SF.defineFlow({
        id: 'flow-data-upload',
        name: 'Flow: Data Upload',
        jobType: C.FLOW.DATA_UPLOAD,
        // job: { jobId, marketId, jobType, serverId, serverType, serverName, fileNames:[…] }
        async run(job, h) {
            h.step(NODE.DU_ACCESS);
            const acc = await h.ensureAccess(job.serverId, job.serverType, job.serverName);
            if (!acc.ok) return { success: false, retryable: acc.retryable !== false, reason: acc.reason };
            if (h.abort()) return { success: false, retryable: true, reason: 'aborted' };

            h.step(NODE.DU_UPLOAD);
            let uploaded = 0, notFound = 0;
            for (const name of job.fileNames) {
                if (h.abort()) return { success: false, retryable: true, reason: 'aborted' };
                const file = await h.findDownloadsFile(name);
                if (!file) { notFound++; h.say('warn', `"${name}" not in Downloads to upload`); continue; }
                const r = await h.awaitAction(15000, () => root.__cor3SaiFileUpload(job.serverId, file.name, file.sizeMb));
                const ok = r && !r.error;
                if (ok) uploaded++;
                h.say('info', `file.upload ${file.name} (${file.sizeMb} MB) → ${ok ? 'uploaded' : 'failed'}${r && r.error ? ' [' + JSON.stringify(r.error) + ']' : ''}`);
            }

            if (uploaded === 0) return { success: true, didWork: false, reason: `no file uploaded (${notFound} not in Downloads)` };

            h.step(NODE.DU_COMPLETE);
            h.complete();
            h.say('info', `Data Upload: uploaded ${uploaded}/${job.fileNames.length} to "${job.serverName}"`);
            return { success: true, didWork: true };
        },
    });
})();
