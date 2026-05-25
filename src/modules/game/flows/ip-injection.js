// Job type: ip_injection. Adds a list of IPs into the SAI Transit tab.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Registry, dom, constants: C } = root.COR3;
    const SAI = root.COR3.game.sai;
    const flows = root.COR3.game.flows;
    const MSG = C.MSG;

    // ── debug instrumentation ─────────────────────────────────────────────
    // The game server occasionally drops "generated" IPs from a target
    // server while the server-side completion check still expects them.
    // To diagnose, we log:
    //   - target IPs from the job
    //   - White List snapshot BEFORE add (already-present / missing / extra)
    //   - per-IP add result (ok / duplicate-error / not-confirmed)
    //   - White List snapshot AFTER add (still-missing / extra)
    // Flow behaviour is unchanged — sendDone still fires; the log shows
    // which IPs the server has vs. which it expects.

    const IP_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

    function diffArrays(target, current) {
        const cur = new Set(current);
        const tgt = new Set(target);
        return {
            alreadyPresent: target.filter((ip) => cur.has(ip)),
            missing:        target.filter((ip) => !cur.has(ip)),
            extra:          current.filter((ip) => !tgt.has(ip)),
        };
    }

    function collectVisibleIps(sai) {
        const scroll = sai.querySelector(SAI.SEL.SCROLL);
        const out = new Set();
        if (!scroll) return out;
        for (const s of scroll.querySelectorAll('span')) {
            const t = s.textContent.trim();
            if (IP_RE.test(t)) out.add(t);
        }
        return out;
    }

    // Best-effort full snapshot. The Transit list is virtualised; scroll the
    // viewport top→bottom collecting IPs at each step. If we can't locate a
    // scrollable element, we return what's visible and flag partial=true.
    async function snapshotWhiteList(sai) {
        const scrollContainer = sai.querySelector(SAI.SEL.SCROLL);
        if (!scrollContainer) return { ips: [], partial: true };
        const seen = collectVisibleIps(sai);
        const isScrollable = (el) => el && el.scrollHeight > el.clientHeight + 4;
        let scroller = scrollContainer.querySelector('[data-radix-scroll-area-viewport]')
                    || (isScrollable(scrollContainer) ? scrollContainer : null);
        if (!scroller) {
            for (const el of scrollContainer.querySelectorAll('*')) {
                if (isScrollable(el)) { scroller = el; break; }
            }
        }
        if (!scroller) return { ips: [...seen], partial: true };
        const startTop = scroller.scrollTop;
        try {
            scroller.scrollTop = 0;
            await dom.sleep(150);
            for (const s of scrollContainer.querySelectorAll('span')) {
                const t = s.textContent.trim();
                if (IP_RE.test(t)) seen.add(t);
            }
            let guard = 60;
            while (guard-- > 0) {
                const before = scroller.scrollTop;
                scroller.scrollTop += Math.max(40, scroller.clientHeight - 40);
                await dom.sleep(150);
                for (const s of scrollContainer.querySelectorAll('span')) {
                    const t = s.textContent.trim();
                    if (IP_RE.test(t)) seen.add(t);
                }
                if (scroller.scrollTop === before) break;
                if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) break;
            }
        } finally {
            scroller.scrollTop = startTop;
        }
        return { ips: [...seen], partial: false };
    }

    // Look inside the SAI widget for the red "Operation failed / sai-transit-*"
    // toast. We match by text shape rather than class because we don't have a
    // stable selector for it yet.
    function findSaiErrorMessages(sai) {
        const widget = sai.closest('[data-sentry-component="ApplicationWidget"]') || sai;
        const out = new Set();
        for (const el of widget.querySelectorAll('span,div,p')) {
            if (!el.offsetParent) continue;
            const txt = (el.textContent || '').trim();
            if (!txt || txt.length > 80) continue;
            if (/^sai-transit-[a-z0-9-]+$/i.test(txt)) out.add(txt);
            else if (/^operation failed$/i.test(txt)) out.add('Operation failed');
        }
        return [...out];
    }

    async function run(jobId, marketId, serverName, ips, mod) {
        if (flows.isWatching()) return;
        flows.setWatching(true);

        flows.userLog(
            `IP Injection [debug]: jobId=${jobId} marketId=${marketId} server="${serverName}" ` +
            `target=${(ips || []).length} [${(ips || []).join(', ')}]`,
            'debug'
        );

        if (!ips || ips.length === 0) {
            flows.userLog('IP Injection: no target IPs parsed — permanently skipping (no work to do)', 'error');
            flows.sendResult(jobId, marketId, { success: true, didWork: false, reason: 'no-ips' });
            flows.setWatching(false);
            return;
        }

        const sai = await SAI.findOrOpenSai(serverName);
        if (!sai) {
            mod.warn(`SAI not found for IP Injection server: ${serverName}`);
            flows.sendTimeout(jobId, marketId, { transient: true });
            flows.setWatching(false);
            return;
        }
        if (!await SAI.waitForServerAccess(sai, serverName)) {
            flows.sendTimeout(jobId, marketId);
            flows.setWatching(false);
            return;
        }
        await SAI.navigateToSection(sai, SAI.SEL.TRANSIT);
        await dom.sleep(400);

        const before = await snapshotWhiteList(sai);
        const dBefore = diffArrays(ips, before.ips);
        flows.userLog(
            `IP Injection [debug]: White List BEFORE — ${before.ips.length} IP(s)${before.partial ? ' (partial)' : ''}: [${before.ips.join(', ')}]`,
            'debug'
        );
        flows.userLog(
            `IP Injection [debug]: diff BEFORE — already-present ${dBefore.alreadyPresent.length} [${dBefore.alreadyPresent.join(', ')}]; ` +
            `missing ${dBefore.missing.length} [${dBefore.missing.join(', ')}]; ` +
            `extra ${dBefore.extra.length} [${dBefore.extra.join(', ')}]`,
            'debug'
        );

        for (const ip of ips) {
            if (root.__jobManagerAbort) break;
            await SAI.addIpViaModal(sai, ip);
            await dom.sleep(400);
            const errors = findSaiErrorMessages(sai);
            const visible = collectVisibleIps(sai);
            let status;
            if (errors.length) status = `error: ${errors.join(' | ')}`;
            else if (visible.has(ip)) status = 'ok';
            else status = 'not-confirmed (not in visible slice)';
            flows.userLog(`IP Injection [debug]: add ${ip} → ${status}`, errors.length ? 'warn' : 'debug');
            await dom.sleep(300);
        }

        if (root.__jobManagerAbort) { flows.setWatching(false); return; }

        const after = await snapshotWhiteList(sai);
        const dAfter = diffArrays(ips, after.ips);
        flows.userLog(
            `IP Injection [debug]: White List AFTER — ${after.ips.length} IP(s)${after.partial ? ' (partial)' : ''}: [${after.ips.join(', ')}]`,
            'debug'
        );
        flows.userLog(
            `IP Injection [debug]: diff AFTER — still-missing ${dAfter.missing.length} [${dAfter.missing.join(', ')}]; ` +
            `extra (on-server, not-in-job — possible "generated" IPs) ${dAfter.extra.length} [${dAfter.extra.join(', ')}]`,
            'info'
        );

        flows.userLog(`IP Injection done — ${ips.length} IP(s) attempted`, 'ok');
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
