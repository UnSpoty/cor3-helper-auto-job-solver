// Auto Jobs — Log Deletion flow (MAIN world). jobType: log_deletion
// (DeleteLog). Delete the job's target log(s) from the server, pure WS. Logs
// are keyed by `seq` (details.logSeqs preferred; logNames → seq via get.logs).
// (log.delete payload {serverId, seq} inferred from the consistent delete/remove
// pattern — file.delete/transit.remove were verified live.)
(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    if (!root.COR3 || !root.COR3.constants || !root.COR3.autoJobs || !root.COR3.autoJobs.saiFlow) return;
    const C = root.COR3.constants;
    const NODE = C.AJ.NODE;
    const SF = root.COR3.autoJobs.saiFlow;
    const NO_LOGS = new Set(C.NO_LOGS_SERVERS || []);

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
        id: 'flow-log-deletion',
        name: 'Flow: Log Deletion',
        jobType: C.FLOW.LOG_DELETION,
        // job: { jobId, marketId, jobType, serverId, serverType, serverName, logSeqs:[…], logNames:[…] }
        async run(job, h) {
            if (job.serverName && NO_LOGS.has(job.serverName)) return { success: true, didWork: false, reason: `server "${job.serverName}" has no Logs subsystem` };

            h.step(NODE.LD_ACCESS);
            const acc = await h.ensureAccess(job.serverId, job.serverType, job.serverName);
            if (!acc.ok) return { success: false, retryable: acc.retryable !== false, reason: acc.reason };
            if (h.abort()) return { success: false, retryable: true, reason: 'aborted' };

            h.step(NODE.LD_DELETE);
            const seqs = await resolveSeqs(job, h);
            // No target log resolved → the logs are already gone from the server →
            // the deletion goal is met → complete (the server validates on
            // job.complete; a name mismatch is rejected and re-dispatched). Never a
            // permanent bug for a job that is likely already done.
            if (!seqs.length) return { success: true, didWork: true, reason: 'no target log present — goal met' };

            let deleted = 0;
            for (const seq of seqs) {
                if (h.abort()) return { success: false, retryable: true, reason: 'aborted' };
                const r = await h.awaitAction(15000, () => root.__cor3SaiLogDelete(job.serverId, seq));
                const ok = r && !r.error;
                if (ok) deleted++;
                h.say('info', `log.delete seq=${seq} → ${ok ? 'deleted' : 'failed'}`);
            }
            if (deleted === 0) return { success: false, retryable: true, reason: 'no log deleted (all failed)' };

            h.step(NODE.LD_COMPLETE);
            h.complete();
            h.say('info', `Log Deletion: deleted ${deleted}/${seqs.length} on "${job.serverName}"`);
            return { success: true, didWork: true };
        },
    });
})();
