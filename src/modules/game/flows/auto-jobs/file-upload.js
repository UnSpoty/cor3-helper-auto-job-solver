// Auto Jobs — File/Data Upload flow (MAIN world). jobType: file_upload
// (handles both "file upload" and "data upload" — one type, see pipeline
// JOB_TYPE_KEYWORDS). Push the job's target file(s) from the player's Downloads
// to the server over WS.
//
// ⚠️ UNVERIFIED WIRE: file.upload was not captured live (the SAI Files tab needs
// a LOAD/upload tool equipped). __cor3SaiFileUpload sends the best-guess
// { serverId, fileId } (fileId = the Downloads file id). Verify live and adjust
// the wire if the server rejects it.
(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    if (!root.COR3 || !root.COR3.constants || !root.COR3.autoJobs || !root.COR3.autoJobs.saiFlow) return;
    const C = root.COR3.constants;
    const NODE = C.AJ.NODE;
    const SF = root.COR3.autoJobs.saiFlow;

    SF.defineFlow({
        id: 'flow-file-upload',
        name: 'Flow: File/Data Upload',
        jobType: C.FLOW.FILE_UPLOAD,
        // job: { jobId, marketId, jobType, serverId, serverType, serverName, fileNames:[…] }
        async run(job, h) {
            h.step(NODE.FU_ACCESS);
            const acc = await h.ensureAccess(job.serverId, job.serverType, job.serverName);
            if (!acc.ok) return { success: false, retryable: acc.retryable !== false, reason: acc.reason };
            if (h.abort()) return { success: false, retryable: true, reason: 'aborted' };

            h.step(NODE.FU_UPLOAD);
            let uploaded = 0, notFound = 0;
            for (const name of job.fileNames) {
                if (h.abort()) return { success: false, retryable: true, reason: 'aborted' };
                const fileId = await h.findDownloadsFileId(name);
                if (!fileId) { notFound++; h.say('warn', `"${name}" not in Downloads to upload`); continue; }
                const r = await h.awaitAction(15000, () => root.__cor3SaiFileUpload(job.serverId, fileId));
                const ok = r && !r.error;
                if (ok) uploaded++;
                h.say('info', `file.upload ${name} (${fileId}) → ${ok ? 'uploaded' : 'failed'}${r && r.error ? ' [' + JSON.stringify(r.error) + ']' : ''}`);
            }

            if (uploaded === 0) return { success: true, didWork: false, reason: `no file uploaded (${notFound} not in Downloads)` };

            h.step(NODE.FU_COMPLETE);
            h.complete();
            h.say('info', `File Upload: uploaded ${uploaded}/${job.fileNames.length} to "${job.serverName}"`);
            return { success: true, didWork: true };
        },
    });
})();
