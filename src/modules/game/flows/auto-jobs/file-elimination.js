// Auto Jobs — File Elimination flow (MAIN world). jobType: file_elimination
// (DeleteFile). Delete the job's target file(s) from the server, pure WS.
// The job carries file NAMES (details.fileNames/fileName); the WS op keys on
// fileId, so the flow reads get.files and maps name→fileId.
(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    if (!root.COR3 || !root.COR3.constants || !root.COR3.autoJobs || !root.COR3.autoJobs.saiFlow) return;
    const C = root.COR3.constants;
    const NODE = C.AJ.NODE;
    const SF = root.COR3.autoJobs.saiFlow;

    const findFile = (files, name) => {
        const n = String(name || '').toLowerCase();
        return files.find((f) => String((f && f.name) || '').toLowerCase() === n) || null;
    };

    SF.defineFlow({
        id: 'flow-file-elimination',
        name: 'Flow: File Elimination',
        jobType: C.FLOW.FILE_ELIMINATION,
        // job: { jobId, marketId, jobType, serverId, serverType, serverName, fileNames:[…] }
        async run(job, h) {
            h.step(NODE.FE_ACCESS);
            const acc = await h.ensureAccess(job.serverId, job.serverType, job.serverName);
            if (!acc.ok) return { success: false, retryable: acc.retryable !== false, reason: acc.reason };
            if (h.abort()) return { success: false, retryable: true, reason: 'aborted' };

            h.step(NODE.FE_DELETE);
            const data = await h.getFiles(job.serverId);
            if (!data) return { success: false, retryable: true, reason: 'get.files timed out' };
            const files = Array.isArray(data.files) ? data.files : [];

            let deleted = 0, notFound = 0;
            for (const name of job.fileNames) {
                if (h.abort()) return { success: false, retryable: true, reason: 'aborted' };
                const f = findFile(files, name);
                if (!f) { notFound++; h.say('warn', `file "${name}" not on server`); continue; }
                const r = await h.awaitAction(12000, () => root.__cor3SaiFileDelete(job.serverId, f.fileId));
                const ok = r && !r.error;
                if (ok) deleted++;
                h.say('info', `file.delete ${name} (${f.fileId}) → ${ok ? 'deleted' : 'failed'}`);
            }

            if (deleted === 0) {
                // Every target already ABSENT from the server → the deletion goal
                // is already met → complete (the server validates on job.complete;
                // if it's actually a wrong server/name the complete is rejected and
                // the job is re-dispatched). Some present but all deletes failed →
                // transient → retry. Never a permanent bug for a done/doable job.
                if (notFound === job.fileNames.length) return { success: true, didWork: true, reason: 'all target files already absent — goal met' };
                return { success: false, retryable: true, reason: `0 deleted, ${notFound} absent — retrying` };
            }

            h.step(NODE.FE_COMPLETE);
            h.complete();
            h.say('info', `File Elimination: deleted ${deleted}/${job.fileNames.length} on "${job.serverName}"`);
            return { success: true, didWork: true };
        },
    });
})();
