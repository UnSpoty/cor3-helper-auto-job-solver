// src/ui/sections/mercenaries.js — roster + auto-send-merc settings

(function () {
    const root = window;
    root.COR3.ui = root.COR3.ui || {};
    const { Store, constants: C } = root.COR3;

    function el(tag, cls, html) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (html !== undefined) e.innerHTML = html;
        return e;
    }
    function escape(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

    async function render(container) {
        const [mercs, configs, autoSend] = await Promise.all([
            Store.local.getOne(C.STORAGE_LOCAL.MERCENARIES),
            Store.local.getOne(C.STORAGE_LOCAL.MERC_CONFIG, {}),
            Store.sync.getOne(C.STORAGE_SYNC.AUTO_SEND_MERC, { enabled: false, autoChooseMerc: true }),
        ]);
        const list = mercs && (Array.isArray(mercs) ? mercs : mercs.mercenaries) || [];
        container.innerHTML = '';

        // Auto-send controls
        container.appendChild(el('div', 'section-title', 'Auto-send mercenary'));
        const ctrl = el('div', 'card');
        ctrl.innerHTML = `
            <div class="card-row">
                <span class="card-label">Enabled</span>
                <label class="switch"><input type="checkbox" data-k="enabled" ${autoSend && autoSend.enabled ? 'checked' : ''}><span class="switch-slider"></span></label>
            </div>
            <div class="card-row mt-sm">
                <span class="card-label">Auto-choose cheapest</span>
                <label class="switch"><input type="checkbox" data-k="autoChooseMerc" ${autoSend && autoSend.autoChooseMerc !== false ? 'checked' : ''}><span class="switch-slider"></span></label>
            </div>
            ${autoSend && autoSend.disabledReason
                ? `<div class="warn sm mt-sm">Disabled: ${escape(autoSend.disabledReason)}</div>` : ''}
        `;
        ctrl.querySelectorAll('input[data-k]').forEach((inp) => {
            inp.addEventListener('change', async (e) => {
                const cur = (await Store.sync.getOne(C.STORAGE_SYNC.AUTO_SEND_MERC, {})) || {};
                cur[e.target.dataset.k] = e.target.checked;
                if (e.target.dataset.k === 'enabled' && e.target.checked) cur.disabledReason = null;
                await Store.sync.setOne(C.STORAGE_SYNC.AUTO_SEND_MERC, cur);
            });
        });
        container.appendChild(ctrl);

        // Roster
        container.appendChild(el('div', 'section-title', 'Roster'));
        if (list.length === 0) {
            container.appendChild(el('div', 'empty', 'No mercenary data yet.'));
            return;
        }
        for (const m of list) {
            const cfg = configs[m.id] || {};
            const card = el('div', 'merc-card' + (m.status !== 'AVAILABLE' ? ' unavail' : '') + (autoSend && autoSend.mercenaryId === m.id ? ' selected' : ''));
            card.innerHTML = `
                <div>
                    <div><strong>${escape(m.callsign || m.id)}</strong></div>
                    <div class="sm muted">${escape(m.status || '')}${cfg.totalCost ? ` · cost ${cfg.totalCost}` : ''}${cfg.riskScore != null ? ` · risk ${cfg.riskScore}` : ''}</div>
                </div>
                <button class="btn small">${autoSend && autoSend.mercenaryId === m.id ? 'Selected' : 'Pick'}</button>
            `;
            card.querySelector('button').addEventListener('click', async () => {
                const cur = (await Store.sync.getOne(C.STORAGE_SYNC.AUTO_SEND_MERC, {})) || {};
                cur.mercenaryId = m.id;
                cur.mercenaryName = m.callsign || m.id;
                await Store.sync.setOne(C.STORAGE_SYNC.AUTO_SEND_MERC, cur);
            });
            container.appendChild(card);
        }
    }

    let unsub1 = null, unsub2 = null;
    root.COR3.ui.mercs = {
        mount(container) {
            unsub1 = Store.local.onChanged((changes) => {
                if ((changes[C.STORAGE_LOCAL.MERCENARIES] || changes[C.STORAGE_LOCAL.MERC_CONFIG])
                    && container.classList.contains('active')) render(container);
            });
            unsub2 = Store.sync.onChanged((changes) => {
                if (changes[C.STORAGE_SYNC.AUTO_SEND_MERC] && container.classList.contains('active')) render(container);
            });
            render(container);
        },
        activate(container) { render(container); },
    };
})();
