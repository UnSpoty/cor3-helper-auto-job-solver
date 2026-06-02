// Auto Jobs — Master Switches panel.
//
// A collapsible card above the Network Map with global on/off toggles:
//   • Markets   — a disabled market's jobs are never accepted.
//   • Job types — a disabled type is rejected on every server/market.
//
// Writes STORAGE_LOCAL.AJ_MASTER_SWITCHES (Auto-Jobs-owned). The pipeline's
// CHECK_JOBS_CONDITION and the Job List both read it through the shared
// evaluator (COR3.ajEligibility), so toggling here updates both the
// enforced verdict (next cycle) and the displayed SKIP flags (instantly).
//
// Default semantics: a switch is ON unless explicitly stored `false`
// (absent === on), so a fresh install has everything enabled.
//
// Exposes attach() on COR3.uiComponents.masterSwitches.

(function () {
    const root = window;
    if (!root.COR3 || !root.COR3.constants) return;
    const { Store, constants: C } = root.COR3;
    const SL = C.STORAGE_LOCAL;
    const t = (k, vars) => root.COR3.i18n.t(k, vars);

    const MARKETS = ['home', 'dark', 'srm'];
    const TYPES = Object.values(C.FLOW);

    function el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text !== undefined) e.textContent = text;
        return e;
    }

    // Chip toggle styled like the loadout CAPABILITIES chips: green = ON,
    // grey outline = OFF. Click flips it.
    function chip(text, on, onClick) {
        const b = el('button', 'aj-ms-chip' + (on ? ' on' : ''), text);
        b.addEventListener('click', () => onClick(!on));
        return b;
    }

    function attach(container) {
        container.innerHTML = '';

        const card = el('div', 'card aj-ms');

        const header = el('button', 'aj-ms-head');
        const caret = el('span', 'aj-ms-caret', '▸');
        header.appendChild(caret);
        header.appendChild(el('span', 'card-label', t('autojobs.masterSwitches')));
        const summary = el('span', 'muted xs aj-ms-summary', '');
        header.appendChild(summary);
        card.appendChild(header);

        const body = el('div', 'aj-ms-body collapsed');
        card.appendChild(body);
        container.appendChild(card);

        let collapsed = true;
        header.addEventListener('click', () => {
            collapsed = !collapsed;
            body.classList.toggle('collapsed', collapsed);
            caret.textContent = collapsed ? '▸' : '▾';
        });

        let switches = {};
        const isOn = (group, key) => {
            const m = switches[group] || {};
            return m[key] !== false;  // absent === on
        };
        // Behaviour toggles default OFF (absent === off) — the opposite of the
        // markets/jobTypes switches: a behaviour like auto-dismiss must be opted
        // into, never enabled silently on a fresh install.
        const isBehaviourOn = (key) => (switches.behaviour || {})[key] === true;
        async function setSwitch(group, key, on) {
            const cur = (await Store.local.getOne(SL.AJ_MASTER_SWITCHES, {})) || {};
            cur[group] = cur[group] || {};
            cur[group][key] = on;
            await Store.local.setOne(SL.AJ_MASTER_SWITCHES, cur);
        }

        function group(title, chips) {
            const g = el('div', 'aj-ms-group');
            g.appendChild(el('div', 'aj-ms-grp-title', title));
            const wrap = el('div', 'aj-ms-chips');
            chips.forEach((c) => wrap.appendChild(c));
            g.appendChild(wrap);
            return g;
        }

        function render() {
            body.innerHTML = '';

            let off = 0;
            for (const slot of MARKETS) if (!isOn('markets', slot)) off++;
            for (const tp of TYPES) if (!isOn('jobTypes', tp)) off++;
            // `off` counts markets/jobTypes (default-on) that are disabled; the
            // behaviour toggle is default-off, so flag it separately when active.
            const auto = isBehaviourOn('autoDismissFailed') ? ' · ' + t('autojobs.msAutoDismissTag') : '';
            summary.textContent = (off ? t('autojobs.msNOff', { n: off }) : t('autojobs.msAllOn')) + auto;

            body.appendChild(group(t('autojobs.msBehaviour'), [
                chip(t('autojobs.msAutoDismissChip'), isBehaviourOn('autoDismissFailed'),
                    (on) => setSwitch('behaviour', 'autoDismissFailed', on)),
            ]));
            body.appendChild(group(t('autojobs.msMarkets'), MARKETS.map((slot) =>
                chip(t('autojobs.market.' + slot), isOn('markets', slot), (on) => setSwitch('markets', slot, on)))));
            body.appendChild(group(t('autojobs.msJobTypes'), TYPES.map((tp) =>
                chip(t('autojobs.jobType.' + tp), isOn('jobTypes', tp), (on) => setSwitch('jobTypes', tp, on)))));
        }

        const unsub = Store.local.onChanged((c) => {
            if (c[SL.AJ_MASTER_SWITCHES]) {
                switches = c[SL.AJ_MASTER_SWITCHES].newValue || {};
                render();
            }
        });
        Store.local.getOne(SL.AJ_MASTER_SWITCHES, {}).then((s) => { switches = s || {}; render(); });

        return {
            destroy() {
                if (typeof unsub === 'function') unsub();
                container.innerHTML = '';
            },
        };
    }

    root.COR3.uiComponents = root.COR3.uiComponents || {};
    root.COR3.uiComponents.masterSwitches = { attach };
})();
