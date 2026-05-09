// src/modules/game/flows/ip-cleanup.js
// Job type: ip_cleanup. Removes a list of IPs from the SAI Transit tab.
// Re-queries the scroll container after every delete because React replaces
// the DOM. Aborts (no false complete) if any target IP isn't rendered.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Registry, dom, constants: C } = root.COR3;
    const SAI = root.COR3.game.sai;
    const flows = root.COR3.game.flows;
    const MSG = C.MSG;

    function findIpRow(scrollEl, targetIp) {
        const ipSpan = [...scrollEl.querySelectorAll('span')]
            .find((s) => s.textContent.trim() === targetIp);
        if (!ipSpan) return null;
        return ipSpan.parentElement?.parentElement || null;
    }

    // Wait up to timeoutMs for a row matching targetIp to render. The Transit
    // list is React-virtualised and the post-Connect render takes a beat to
    // settle; the previous one-shot lookup mistakenly aborted jobs whose IPs
    // hadn't appeared yet, then bugged them for 2h.
    async function waitForIpRow(sai, targetIp, timeoutMs = 5_000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline && !root.__jobManagerAbort) {
            const scroll = sai.querySelector(SAI.SEL.SCROLL);
            if (scroll) {
                const row = findIpRow(scroll, targetIp);
                if (row) return row;
            }
            await dom.sleep(300);
        }
        return null;
    }

    async function run(jobId, marketId, serverName, ips, mod) {
        if (flows.isWatching()) return;
        flows.setWatching(true);

        const sai = await SAI.findOrOpenSai(serverName);
        if (!sai) {
            mod.warn(`SAI not found for IP Cleanup server: ${serverName}`);
            flows.sendTimeout(jobId, marketId);
            flows.setWatching(false);
            return;
        }

        if (!await SAI.navigateToSection(sai, SAI.SEL.TRANSIT)) {
            flows.sendTimeout(jobId, marketId);
            flows.setWatching(false);
            return;
        }

        const scroll = await dom.waitForEl(() => sai.querySelector(SAI.SEL.SCROLL), { timeout: 6_000 });
        if (!scroll) {
            mod.warn('IP Cleanup — scroll container not found after tab switch');
            flows.sendTimeout(jobId, marketId);
            flows.setWatching(false);
            return;
        }

        if (ips.length === 0) {
            flows.userLog('IP Cleanup: no target IPs parsed — aborting to avoid clearing the entire transit list', 'error');
            flows.sendTimeout(jobId, marketId);
            flows.setWatching(false);
            return;
        }

        let deletedCount = 0;
        const missingIps = [];
        for (const ip of ips) {
            if (root.__jobManagerAbort) break;

            // Poll for the row instead of one-shot lookup; the Transit list
            // is virtualised and the React mount can lag a few hundred ms
            // behind the connect→tab-switch sequence.
            const row = await waitForIpRow(sai, ip, 5_000);
            if (!row) {
                mod.warn(`IP not in list after 5s: ${ip}`);
                missingIps.push(ip);
                continue;
            }

            const deleteBtn = row.querySelector('button');
            if (!deleteBtn) { mod.warn(`no delete button for IP: ${ip}`); continue; }

            mod.info(`deleting IP: ${ip}`);
            deleteBtn.click();
            await dom.sleep(500);
            await SAI.confirmDeleteDialog();
            await dom.sleep(300);
            deletedCount++;
        }

        if (root.__jobManagerAbort) { flows.setWatching(false); return; }

        if (missingIps.length > 0) {
            // Transient: the IPs may simply not be in the rendered slice of a
            // virtualised list, or server-side state lagged behind. Mark the
            // timeout transient so the orchestrator buggs it for 15 min, not
            // 2 h — next scan will likely succeed.
            flows.userLog(`IP Cleanup: ${missingIps.length}/${ips.length} target IP(s) not in DOM (${missingIps.join(', ')}) — retry later`, 'warn');
            flows.sendTimeout(jobId, marketId, { transient: true });
        } else if (deletedCount === ips.length) {
            mod.info(`IP Cleanup done — ${deletedCount} IPs deleted`);
            flows.sendDone(jobId, marketId);
        } else {
            mod.warn(`deleted ${deletedCount}/${ips.length} IPs`);
            flows.sendTimeout(jobId, marketId);
        }
        flows.setWatching(false);
    }

    class IpCleanupFlow extends Module {
        constructor() {
            super({
                id: 'flow-ip-cleanup',
                name: 'Flow: IP Cleanup',
                category: C.CATEGORY.GAME,
                dependsOn: ['flows-core', 'sai-navigator'],
                owns: { busTypes: [MSG.JOB.START_IP_CLEANUP] },
            });
        }
        async start() {
            this.track(Bus.window.on(MSG.JOB.START_IP_CLEANUP, (env) => {
                const { jobId, marketId, serverName, ips } = env;
                flows.startFlow('IPCleanup', { jobId, marketId, serverName, ips },
                    () => run(jobId, marketId, serverName, ips, this), this);
            }));
        }
    }
    Registry.register(new IpCleanupFlow());
})();
