// Auto Jobs — IP Injection flow (MAIN world). jobType: ip_injection (InjectIps).
// Add the job's target IPs to the server's transit whitelist, pure WS.
// Target IPs come from the TAKEN job's primary condition details.ips
// (resolved by the orchestrator into job.ips).
(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    if (!root.COR3 || !root.COR3.constants || !root.COR3.autoJobs || !root.COR3.autoJobs.saiFlow) return;
    const C = root.COR3.constants;
    const NODE = C.AJ.NODE;
    const SF = root.COR3.autoJobs.saiFlow;

    SF.defineFlow({
        id: 'flow-ip-injection',
        name: 'Flow: IP Injection',
        jobType: C.FLOW.IP_INJECTION,
        // job: { jobId, marketId, jobType, serverId, serverType, serverName, ips:[…] }
        async run(job, h) {
            h.step(NODE.II_ACCESS);
            const acc = await h.ensureAccess(job.serverId, job.serverType, job.serverName);
            if (!acc.ok) return { success: false, retryable: acc.retryable !== false, reason: acc.reason };
            if (h.abort()) return { success: false, retryable: true, reason: 'aborted' };

            h.step(NODE.II_INJECT);
            let added = 0;
            for (const ip of job.ips) {
                if (h.abort()) return { success: false, retryable: true, reason: 'aborted' };
                const r = await h.awaitAction(12000, () => root.__cor3SaiTransitAdd(job.serverId, ip, '', null));
                const ok = r && !r.error;
                if (ok) added++;
                h.say('info', `transit.add ${ip} → ${ok ? 'added' : 'already present / failed'}`);
            }
            h.say('info', `IP Injection: added ${added}/${job.ips.length} on "${job.serverName}"`);

            // If nothing reported added, don't blindly complete (that would mask a
            // total failure). Verify against the live transit list: if every target
            // IP is already present the goal is met → complete; otherwise the adds
            // genuinely failed → retry next cycle (never a false success).
            if (added === 0) {
                const data = await h.getTransit(job.serverId);
                const present = new Set(((data && data.ips) || []).map((x) => String(x && x.ip)));
                const allPresent = job.ips.length > 0 && job.ips.every((ip) => present.has(String(ip)));
                if (!allPresent) return { success: false, retryable: true, reason: `0/${job.ips.length} IPs added and not all present — retrying` };
                h.say('info', 'all target IPs already present — goal met');
            }

            // Complete after the work (the server grades the conditions on job.complete).
            h.step(NODE.II_COMPLETE);
            h.complete();
            return { success: true, didWork: true };
        },
    });
})();
