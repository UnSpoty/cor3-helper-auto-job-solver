// src/ui/sections/alarms.js — multi-alarm system

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

    const TIMER_LABELS = { daily: 'Daily Ops', home_jobs: 'Home Market reset', dark_jobs: 'Dark Market reset' };
    function genId() { return 'alarm_' + Date.now() + '_' + Math.floor(Math.random() * 1000); }

    async function render(container) {
        const [alarms, exps] = await Promise.all([
            Store.sync.getOne(C.STORAGE_SYNC.ALARMS, []),
            Store.local.getOne(C.STORAGE_LOCAL.EXPEDITIONS, []),
        ]);
        const labels = Object.assign({}, TIMER_LABELS);
        for (const e of exps || []) labels['exp_' + e.id] = `${e.locationName || 'Expedition'} — ${e.zoneName || ''}`;

        container.innerHTML = '';
        container.appendChild(el('div', 'section-title', `Alarms (${(alarms || []).length})`));

        if (!alarms || alarms.length === 0) {
            container.appendChild(el('div', 'empty', 'No alarms configured.'));
        } else {
            const list = el('div', 'alarm-list');
            for (const a of alarms) {
                const row = el('div', 'alarm-row');
                row.innerHTML = `
                    <label class="switch"><input type="checkbox" data-id="${a.id}" data-act="toggle" ${a.enabled ? 'checked' : ''}><span class="switch-slider"></span></label>
                    <div>
                        <div class="sm">${escape(labels[a.timerSource] || a.timerSource)}</div>
                        <div class="muted xs">≤ ${a.thresholdSeconds}s · ${a.volume}%${a.continuous ? ' · loop' : ''}</div>
                    </div>
                    <button class="btn btn-danger small" data-id="${a.id}" data-act="del">×</button>
                `;
                list.appendChild(row);
            }
            list.addEventListener('change', async (e) => {
                if (e.target.dataset.act !== 'toggle') return;
                const list = (await Store.sync.getOne(C.STORAGE_SYNC.ALARMS, [])) || [];
                const idx = list.findIndex((x) => x.id === e.target.dataset.id);
                if (idx === -1) return;
                list[idx].enabled = e.target.checked;
                await Store.sync.setOne(C.STORAGE_SYNC.ALARMS, list);
            });
            list.addEventListener('click', async (e) => {
                if (e.target.dataset.act !== 'del') return;
                const list = (await Store.sync.getOne(C.STORAGE_SYNC.ALARMS, [])) || [];
                const filtered = list.filter((x) => x.id !== e.target.dataset.id);
                await Store.sync.setOne(C.STORAGE_SYNC.ALARMS, filtered);
            });
            container.appendChild(list);
        }

        // Add new
        container.appendChild(el('div', 'section-title', 'Add alarm'));
        const form = el('div', 'card');
        const opts = Object.entries(labels).map(([k, v]) => `<option value="${k}">${escape(v)}</option>`).join('');
        form.innerHTML = `
            <div class="row gap-sm"><span class="card-label flex1">Timer</span><select id="al-timer">${opts}</select></div>
            <div class="row gap-sm mt-sm"><span class="card-label flex1">Threshold (sec)</span><input type="number" id="al-thresh" min="1" value="60" style="width: 80px;"></div>
            <div class="row gap-sm mt-sm"><span class="card-label flex1">Volume (%)</span><input type="range" id="al-vol" min="10" max="100" value="50" style="width: 120px;"></div>
            <div class="row gap-sm mt-sm"><span class="card-label flex1">Continuous</span><label class="switch"><input type="checkbox" id="al-cont"><span class="switch-slider"></span></label></div>
            <div class="row gap-sm mt-sm">
                <button class="btn small" id="al-test">Test</button>
                <button class="btn small" id="al-add">Add</button>
                <button class="btn btn-danger small" id="al-stop">Stop all</button>
            </div>
        `;
        form.querySelector('#al-test').addEventListener('click', async () => {
            const tab = (await chrome.tabs.query({ url: ['https://cor3.gg/*', 'https://os.cor3.gg/*'] }))[0];
            if (tab) chrome.tabs.sendMessage(tab.id, {
                type: 'testAlarm',
                payload: { volume: Number(form.querySelector('#al-vol').value), continuous: form.querySelector('#al-cont').checked },
            }).catch(() => {});
        });
        form.querySelector('#al-stop').addEventListener('click', async () => {
            const tab = (await chrome.tabs.query({ url: ['https://cor3.gg/*', 'https://os.cor3.gg/*'] }))[0];
            if (tab) chrome.tabs.sendMessage(tab.id, { type: 'stopAlarm' }).catch(() => {});
        });
        form.querySelector('#al-add').addEventListener('click', async () => {
            const a = {
                id: genId(),
                timerSource: form.querySelector('#al-timer').value,
                thresholdSeconds: Math.max(1, Number(form.querySelector('#al-thresh').value) || 60),
                volume: Number(form.querySelector('#al-vol').value),
                continuous: form.querySelector('#al-cont').checked,
                enabled: true,
            };
            const list = (await Store.sync.getOne(C.STORAGE_SYNC.ALARMS, [])) || [];
            list.push(a);
            await Store.sync.setOne(C.STORAGE_SYNC.ALARMS, list);
        });
        container.appendChild(form);
    }

    let unsub = null;
    root.COR3.ui.alarms = {
        mount(container) {
            unsub = Store.sync.onChanged((changes) => {
                if (changes[C.STORAGE_SYNC.ALARMS] && container.classList.contains('active')) render(container);
            });
            render(container);
        },
        activate(container) { render(container); },
    };
})();
