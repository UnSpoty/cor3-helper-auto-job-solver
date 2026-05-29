// Auto-Jobs v2 — Master Switches panel.
//
// A collapsible card above the Network Map with global on/off toggles:
//   • Markets   — a disabled market's jobs are never accepted.
//   • Job types — a disabled type is rejected on every server/market.
//
// Writes STORAGE_LOCAL.AJV2_MASTER_SWITCHES (v2-owned). The pipeline's
// CHECK_JOBS_CONDITION and the Job List both read it through the shared
// evaluator (COR3.ajv2Eligibility), so toggling here updates both the
// enforced verdict (next cycle) and the displayed SKIP flags (instantly).
//
// Default semantics: a switch is ON unless explicitly stored `false`
// (absent === on), so a fresh install has everything enabled.
//
// Exposes attach() on COR3.uiComponentsV2.masterSwitches.

(function () {
    const root = window;
    if (!root.COR3 || !root.COR3.constants) return;
    const { Store, constants: C } = root.COR3;
    const SL = C.STORAGE_LOCAL;

    const MARKETS = [['home', 'Home'], ['dark', 'Dark'], ['srm', 'SRM7-M']];
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
        const b = el('button', 'ajv2-ms-chip' + (on ? ' on' : ''), text);
        b.addEventListener('click', () => onClick(!on));
        return b;
    }

    function attach(container) {
        container.innerHTML = '';

        const card = el('div', 'card ajv2-ms');

        const header = el('button', 'ajv2-ms-head');
        const caret = el('span', 'ajv2-ms-caret', '▸');
        header.appendChild(caret);
        header.appendChild(el('span', 'card-label', 'Master Switches'));
        const summary = el('span', 'muted xs ajv2-ms-summary', '');
        header.appendChild(summary);
        card.appendChild(header);

        const body = el('div', 'ajv2-ms-body collapsed');
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
        async function setSwitch(group, key, on) {
            const cur = (await Store.local.getOne(SL.AJV2_MASTER_SWITCHES, {})) || {};
            cur[group] = cur[group] || {};
            cur[group][key] = on;
            await Store.local.setOne(SL.AJV2_MASTER_SWITCHES, cur);
        }

        function group(title, chips) {
            const g = el('div', 'ajv2-ms-group');
            g.appendChild(el('div', 'ajv2-ms-grp-title', title));
            const wrap = el('div', 'ajv2-ms-chips');
            chips.forEach((c) => wrap.appendChild(c));
            g.appendChild(wrap);
            return g;
        }

        function render() {
            body.innerHTML = '';

            let off = 0;
            for (const [slot] of MARKETS) if (!isOn('markets', slot)) off++;
            for (const tp of TYPES) if (!isOn('jobTypes', tp)) off++;
            summary.textContent = off ? `${off} off` : 'all on';

            body.appendChild(group('Markets', MARKETS.map(([slot, lbl]) =>
                chip(lbl, isOn('markets', slot), (on) => setSwitch('markets', slot, on)))));
            body.appendChild(group('Job types', TYPES.map((tp) =>
                chip(tp.replace(/_/g, ' '), isOn('jobTypes', tp), (on) => setSwitch('jobTypes', tp, on)))));
        }

        const unsub = Store.local.onChanged((c) => {
            if (c[SL.AJV2_MASTER_SWITCHES]) {
                switches = c[SL.AJV2_MASTER_SWITCHES].newValue || {};
                render();
            }
        });
        Store.local.getOne(SL.AJV2_MASTER_SWITCHES, {}).then((s) => { switches = s || {}; render(); });

        return {
            destroy() {
                if (typeof unsub === 'function') unsub();
                container.innerHTML = '';
            },
        };
    }

    root.COR3.uiComponentsV2 = root.COR3.uiComponentsV2 || {};
    root.COR3.uiComponentsV2.masterSwitches = { attach };
})();
