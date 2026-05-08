// src/modules/game/flows/ip-injection.js
// Job type: ip_injection. Adds a list of IPs into the SAI Transit tab.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Registry, dom, constants: C } = root.COR3;
    const SAI = root.COR3.game.sai;
    const flows = root.COR3.game.flows;
    const MSG = C.MSG;

    async function run(jobId, marketId, serverName, ips, mod) {
        if (flows.isWatching()) return;
        flows.setWatching(true);

        if (!ips || ips.length === 0) {
            flows.userLog('IP Injection: no target IPs parsed — aborting to avoid injecting nothing', 'error');
            flows.sendTimeout(jobId, marketId);
            flows.setWatching(false);
            return;
        }

        const sai = await SAI.findOrOpenSai(serverName);
        if (!sai) {
            mod.warn(`SAI not found for IP Injection server: ${serverName}`);
            flows.sendTimeout(jobId, marketId);
            flows.setWatching(false);
            return;
        }
        if (!await SAI.waitForServerAccess(sai, serverName)) {
            flows.sendTimeout(jobId, marketId);
            flows.setWatching(false);
            return;
        }
        await SAI.navigateToSection(sai, SAI.SEL.TRANSIT);

        for (const ip of ips) {
            if (root.__jobManagerAbort) break;
            await SAI.addIpViaModal(sai, ip);
            await dom.sleep(300);
        }

        if (root.__jobManagerAbort) { flows.setWatching(false); return; }
        flows.userLog(`IP Injection done — ${ips.length} IP(s) added`, 'ok');
        flows.sendDone(jobId, marketId);
        flows.setWatching(false);
    }

    class IpInjectionFlow extends Module {
        constructor() {
            super({
                id: 'flow-ip-injection',
                name: 'Flow: IP Injection',
                category: C.CATEGORY.GAME,
                dependsOn: ['flows-core', 'sai-navigator'],
                owns: { busTypes: [MSG.JOB.START_IP_INJECTION] },
            });
        }
        async start() {
            this.track(Bus.window.on(MSG.JOB.START_IP_INJECTION, (env) => {
                const { jobId, marketId, serverName, ips } = env;
                flows.startFlow('IPInjection', { jobId, marketId, serverName, ips },
                    () => run(jobId, marketId, serverName, ips, this), this);
            }));
        }
    }
    Registry.register(new IpInjectionFlow());
})();
