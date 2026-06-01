// Auto Jobs — IP Cleanup flow (MAIN world). jobType: ip_cleanup (DeleteIps).
// Remove the job's target IPs from the server's transit whitelist, pure WS.
// Target IPs come from the TAKEN job's primary condition details.ips
// (resolved by the orchestrator into job.ips). VERIFIED end-to-end live.
(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    if (!root.COR3 || !root.COR3.constants || !root.COR3.autoJobs || !root.COR3.autoJobs.saiFlow) return;
    const C = root.COR3.constants;
    const NODE = C.AJ.NODE;
    const SF = root.COR3.autoJobs.saiFlow;

    SF.defineFlow({
        id: 'flow-ip-cleanup',
        name: 'Flow: IP Cleanup',
        jobType: C.FLOW.IP_CLEANUP,
        // job: { jobId, marketId, jobType, serverId, serverType, serverName, ips:[…] }
        async run(job, h) {
            h.step(NODE.IC_ACCESS);
            const acc = await h.ensureAccess(job.serverId, job.serverType, job.serverName);
            if (!acc.ok) return { success: false, retryable: acc.retryable !== false, reason: acc.reason };
            if (h.abort()) return { success: false, retryable: true, reason: 'aborted' };

            h.step(NODE.IC_CLEANUP);
            let removed = 0;
            for (const ip of job.ips) {
                if (h.abort()) return { success: false, retryable: true, reason: 'aborted' };
                const r = await h.awaitAction(12000, () => root.__cor3SaiTransitRemove(job.serverId, ip));
                const ok = r && !r.error;
                if (ok) removed++;
                h.say('info', `transit.remove ${ip} → ${ok ? 'removed' : 'not present / failed'}`);
            }
            h.say('info', `IP Cleanup: removed ${removed}/${job.ips.length} on "${job.serverName}"`);

            // If nothing reported removed, verify the goal is actually met (every
            // target IP absent from the live transit list) before completing — a
            // "not present" IP is already clean, but a total failure must NOT be
            // masked as success. None-removed AND still-present → retry next cycle.
            if (removed === 0) {
                const data = await h.getTransit(job.serverId);
                const present = new Set(((data && data.ips) || []).map((x) => String(x && x.ip)));
                const allAbsent = job.ips.every((ip) => !present.has(String(ip)));
                if (!allAbsent) return { success: false, retryable: true, reason: `0/${job.ips.length} IPs removed and some still present — retrying` };
                h.say('info', 'all target IPs already absent — goal met');
            }

            // Complete after the work (the server validates the conditions on job.complete).
            h.step(NODE.IC_COMPLETE);
            h.complete();
            return { success: true, didWork: true };
        },
    });
})();
