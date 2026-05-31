// Auto-Jobs v2 — Log Download flow (MAIN world). jobType: log_download
// (DownloadLog). Download the job's target log(s) into Downloads, pure WS.
// Logs are keyed by `seq`; the job carries details.logSeqs (preferred) and/or
// logNames (resolved to seqs via get.logs by message match). No minigame.
(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    if (!root.COR3 || !root.COR3.constants || !root.COR3.autoJobsV2 || !root.COR3.autoJobsV2.saiFlow) return;
    const C = root.COR3.constants;
    const NODE = C.AJV2.NODE;
    const SF = root.COR3.autoJobsV2.saiFlow;
    const NO_LOGS = new Set(C.NO_LOGS_SERVERS || []);

    // Resolve the target log seqs: explicit job.logSeqs, else match job.logNames
    // against the live get.logs messages.
    async function resolveSeqs(job, h) {
        const seqs = Array.isArray(job.logSeqs) ? job.logSeqs.filter((s) => Number.isInteger(s)) : [];
        if (seqs.length) return seqs;
        const names = Array.isArray(job.logNames) ? job.logNames : [];
        if (!names.length) return [];
        const data = await h.getLogs(job.serverId);
        const logs = (data && Array.isArray(data.logs)) ? data.logs : [];
        const out = [];
        for (const name of names) {
            const n = String(name || '').toLowerCase();
            const m = logs.find((l) => String((l && l.message) || '').toLowerCase().includes(n));
            if (m && Number.isInteger(m.seq)) out.push(m.seq);
        }
        return [...new Set(out)];
    }

    SF.defineFlow({
        id: 'flow-v2-log-download',
        name: 'Flow v2: Log Download',
        jobType: C.FLOW.LOG_DOWNLOAD,
        // job: { jobId, marketId, jobType, serverId, serverType, serverName, logSeqs:[…], logNames:[…] }
        async run(job, h) {
            if (job.serverName && NO_LOGS.has(job.serverName)) return { success: true, didWork: false, reason: `server "${job.serverName}" has no Logs subsystem` };

            h.step(NODE.LG_ACCESS);
            const acc = await h.ensureAccess(job.serverId, job.serverType, job.serverName);
            if (!acc.ok) return { success: false, retryable: acc.retryable !== false, reason: acc.reason };
            if (h.abort()) return { success: false, retryable: true, reason: 'aborted' };

            h.step(NODE.LG_DOWNLOAD);
            const seqs = await resolveSeqs(job, h);
            // No target log identified this cycle (not on the server yet, or a
            // name-match miss) → RETRY rather than permanently bug a download that
            // may become possible once the log appears.
            if (!seqs.length) return { success: false, retryable: true, reason: 'no target log seq resolved from job — retrying' };

            let downloaded = 0;
            for (const seq of seqs) {
                if (h.abort()) return { success: false, retryable: true, reason: 'aborted' };
                const r = await h.awaitAction(15000, () => root.__cor3SaiLogDownload(job.serverId, seq));
                const ok = r && !r.error;
                if (ok) downloaded++;
                h.say('info', `log.download seq=${seq} → ${ok ? 'downloaded' : 'failed'}`);
            }
            if (downloaded === 0) return { success: false, retryable: true, reason: 'no log downloaded (all failed)' };

            h.step(NODE.LG_COMPLETE);
            h.complete();
            h.say('info', `Log Download: downloaded ${downloaded}/${seqs.length} from "${job.serverName}"`);
            return { success: true, didWork: true };
        },
    });
})();
