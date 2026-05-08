// src/ui/sections/auto-jobs.js — master toggle, status, queue, log

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

    async function getCor3Tab() {
        const [t] = await chrome.tabs.query({ url: ['https://cor3.gg/*', 'https://os.cor3.gg/*'] });
        return t || null;
    }

    async function render(container) {
        const [settings, state, queue, log, bugged] = await Promise.all([
            Store.sync.getOne(C.STORAGE_SYNC.AUTOJOBS_SETTINGS, { enabled: false, debugMode: false, markets: { home: true, dark: true }, enabledJobTypes: {} }),
            Store.local.getOne(C.STORAGE_LOCAL.AUTOJOBS_STATE, { status: 'idle' }),
            Store.local.getOne(C.STORAGE_LOCAL.AUTOJOBS_QUEUE, []),
            Store.local.getOne(C.STORAGE_LOCAL.AUTOJOBS_LOG, []),
            Store.local.getOne(C.STORAGE_LOCAL.BUGGED_JOBS, {}),
        ]);

        container.innerHTML = '';

        // Master toggle + status
        const head = el('div', 'card');
        head.innerHTML = `
            <div class="card-row">
                <span class="card-label">Auto-Jobs</span>
                <span class="pill ${settings.enabled ? 'active' : 'idle'}">${settings.enabled ? 'ON' : 'OFF'}</span>
            </div>
            <div class="card-row mt-sm">
                <span class="card-label">Status</span>
                <span class="pill ${state.status === 'idle' ? 'idle' : (state.status === 'solving' ? 'active' : 'warn')}">${state.status}</span>
            </div>
            ${state.jobName ? `<div class="sm mt-sm">${escape(state.jobName)} <span class="muted">[${escape(state.jobType || '')}]</span></div>` : ''}
            ${state.serverName ? `<div class="sm muted">server: ${escape(state.serverName)}</div>` : ''}
        `;
        const toggleBtn = el('button', 'btn btn-block mt-sm', settings.enabled ? 'STOP' : 'START');
        toggleBtn.classList.toggle('btn-danger', !!settings.enabled);
        toggleBtn.classList.toggle('btn-success', !settings.enabled);
        toggleBtn.addEventListener('click', async () => {
            const nextSettings = Object.assign({}, settings, { enabled: !settings.enabled });
            await Store.sync.setOne(C.STORAGE_SYNC.AUTOJOBS_SETTINGS, nextSettings);
            const tab = await getCor3Tab();
            if (tab) chrome.tabs.sendMessage(tab.id, { action: 'toggleAutoJobs', settings: nextSettings }).catch(() => {});
        });
        head.appendChild(toggleBtn);
        container.appendChild(head);

        // Market source toggles
        container.appendChild(el('div', 'section-title', 'Sources'));
        const src = el('div', 'card');
        src.innerHTML = `
            <div class="card-row">
                <span class="card-label">Home market</span>
                <label class="switch"><input type="checkbox" data-mkt="home" ${settings.markets.home !== false ? 'checked' : ''}><span class="switch-slider"></span></label>
            </div>
            <div class="card-row mt-sm">
                <span class="card-label">Dark market</span>
                <label class="switch"><input type="checkbox" data-mkt="dark" ${settings.markets.dark !== false ? 'checked' : ''}><span class="switch-slider"></span></label>
            </div>
            <div class="card-row mt-sm">
                <span class="card-label">Debug mode (manual trigger)</span>
                <label class="switch"><input type="checkbox" data-debug ${settings.debugMode ? 'checked' : ''}><span class="switch-slider"></span></label>
            </div>
        `;
        src.querySelectorAll('input[data-mkt]').forEach((inp) => {
            inp.addEventListener('change', async (e) => {
                const cur = (await Store.sync.getOne(C.STORAGE_SYNC.AUTOJOBS_SETTINGS, settings)) || settings;
                cur.markets = cur.markets || {};
                cur.markets[e.target.dataset.mkt] = e.target.checked;
                await Store.sync.setOne(C.STORAGE_SYNC.AUTOJOBS_SETTINGS, cur);
            });
        });
        src.querySelector('input[data-debug]').addEventListener('change', async (e) => {
            const cur = (await Store.sync.getOne(C.STORAGE_SYNC.AUTOJOBS_SETTINGS, settings)) || settings;
            cur.debugMode = e.target.checked;
            await Store.sync.setOne(C.STORAGE_SYNC.AUTOJOBS_SETTINGS, cur);
        });
        container.appendChild(src);

        // Queue
        container.appendChild(el('div', 'section-title', `Queue (${queue.length})`));
        if (queue.length === 0) {
            container.appendChild(el('div', 'empty', 'Queue is empty.'));
        } else {
            for (const j of queue) {
                const c = el('div', 'job-card');
                c.innerHTML = `
                    <div class="job-name">${escape(j.jobName || j.jobId)}</div>
                    <div class="job-meta">[${escape(j.jobType)}]${j.serverName ? ' · ' + escape(j.serverName) : ''}${j.fileCondition ? ' · ' + escape(j.fileCondition) : ''}</div>
                `;
                container.appendChild(c);
            }
        }

        // Bugged jobs
        const buggedKeys = Object.keys(bugged || {});
        if (buggedKeys.length > 0) {
            container.appendChild(el('div', 'section-title', `Bugged (${buggedKeys.length})`));
            const bcard = el('div', 'card');
            bcard.innerHTML = buggedKeys.slice(0, 10).map((id) =>
                `<div class="sm">${escape((bugged[id] && bugged[id].name) || id)}</div>`).join('') +
                (buggedKeys.length > 10 ? `<div class="muted sm">… +${buggedKeys.length - 10} more</div>` : '');
            const clear = el('button', 'btn btn-danger small mt-sm', 'Clear bugged');
            clear.addEventListener('click', async () => {
                const tab = await getCor3Tab();
                if (tab) chrome.tabs.sendMessage(tab.id, { action: 'clearBuggedJobs' }).catch(() => {});
            });
            bcard.appendChild(clear);
            container.appendChild(bcard);
        }

        // Log
        container.appendChild(el('div', 'section-title', `Activity log (${log.length})`));
        const stream = el('div', 'log-stream');
        stream.innerHTML = log.slice(-50).map((e) =>
            `<div class="log-line ${e.level || 'info'}"><span class="ts">${new Date(e.ts).toLocaleTimeString()}</span>${escape(e.msg)}</div>`
        ).join('') || '<div class="empty">No activity yet.</div>';
        stream.scrollTop = stream.scrollHeight;
        container.appendChild(stream);
    }

    let unsub1 = null, unsub2 = null;
    root.COR3.ui.autojobs = {
        mount(container) {
            unsub1 = Store.local.onChanged((changes) => {
                if ((changes[C.STORAGE_LOCAL.AUTOJOBS_STATE] || changes[C.STORAGE_LOCAL.AUTOJOBS_QUEUE] ||
                     changes[C.STORAGE_LOCAL.AUTOJOBS_LOG] || changes[C.STORAGE_LOCAL.BUGGED_JOBS])
                    && container.classList.contains('active')) render(container);
            });
            unsub2 = Store.sync.onChanged((changes) => {
                if (changes[C.STORAGE_SYNC.AUTOJOBS_SETTINGS] && container.classList.contains('active')) render(container);
            });
            render(container);
        },
        activate(container) { render(container); },
    };
})();
