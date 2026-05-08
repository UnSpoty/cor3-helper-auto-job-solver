// src/ui/sections/stash.js — inventory list

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

    async function render(container) {
        const stash = await Store.local.getOne(C.STORAGE_LOCAL.STASH);
        container.innerHTML = '';

        const head = el('div', 'card');
        if (stash && stash.maxCapacity !== undefined) {
            const used = stash.currentUsage || 0;
            const max = stash.maxCapacity || 0;
            const pct = max > 0 ? Math.round((used / max) * 100) : 0;
            const cls = pct > 90 ? 'err' : pct > 70 ? 'warn' : 'ok';
            head.innerHTML = `<div class="card-row"><span class="card-label">Capacity</span><span class="${cls}">${used} / ${max} (${pct}%)</span></div>`;
        } else {
            head.innerHTML = '<div class="muted sm">No stash data.</div>';
        }
        const refresh = el('button', 'btn small mt-sm', 'Refresh');
        refresh.addEventListener('click', async () => {
            const tab = (await chrome.tabs.query({ url: ['https://cor3.gg/*', 'https://os.cor3.gg/*'] }))[0];
            if (tab) chrome.tabs.sendMessage(tab.id, { action: 'requestStash' }).catch(() => {});
        });
        head.appendChild(refresh);
        container.appendChild(head);

        const items = (stash && Array.isArray(stash.items)) ? stash.items : [];
        if (items.length === 0) {
            container.appendChild(el('div', 'empty', 'Empty inventory.'));
            return;
        }
        container.appendChild(el('div', 'section-title', `Items (${items.length})`));
        for (const item of items) {
            const c = el('div', 'card compact');
            c.innerHTML = `<div class="card-row"><span>${escape(item.name || item.itemName || '?')}</span><span class="sm muted">x${item.quantity || 1}</span></div>`;
            container.appendChild(c);
        }
    }
    function escape(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

    let unsub = null;
    root.COR3.ui.stash = {
        mount(container) {
            unsub = Store.local.onChanged((changes) => {
                if (changes[C.STORAGE_LOCAL.STASH] && container.classList.contains('active')) render(container);
            });
            render(container);
        },
        activate(container) { render(container); },
    };
})();
