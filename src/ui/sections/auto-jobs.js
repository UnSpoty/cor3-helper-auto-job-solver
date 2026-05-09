// src/ui/sections/auto-jobs.js — master toggle, status, queue, activity log.
// Activity log is rendered via uiComponents.logViewer filtered to
// module='auto-jobs' (the same component the Logs tab uses); the legacy
// per-module AUTOJOBS_LOG ring is gone.

(function () {
    const root = window;
    root.COR3.ui = root.COR3.ui || {};
    const { Store, constants: C, uiComponents } = root.COR3;

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

    // Default settings shape — kept in sync with auto-jobs.js. markets has
    // entries for every market we know about; missing keys are treated as
    // truthy by the orchestrator (settings.markets.foo !== false).
    const DEFAULT_SETTINGS = { enabled: false, markets: { home: true, dark: true, srm: true }, enabledJobTypes: {} };

    // The header card and the queue/bugged sections need to re-render on
    // state/queue changes; the activity log lives separately and uses its
    // own subscriber inside uiComponents.logViewer (no full re-mount).
    let liveLogViewer = null;

    function renderHeader(host, settings, state) {
        host.innerHTML = '';
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
        host.appendChild(head);
    }

    function renderSources(host, settings) {
        host.innerHTML = '';
        host.appendChild(el('div', 'section-title', 'Sources'));
        const card = el('div', 'card');
        // Adding a 4th market = one row. The toggles all read settings.markets.<key>
        // which the auto-jobs orchestrator scans against MARKETS_FOR_SCAN.
        const MARKET_LABELS = [
            { key: 'home', label: 'Home market' },
            { key: 'dark', label: 'Dark market' },
            { key: 'srm',  label: 'SRM7-M' },
        ];
        const m = settings.markets || {};
        card.innerHTML = MARKET_LABELS.map((mk, i) => `
            <div class="card-row${i > 0 ? ' mt-sm' : ''}">
                <span class="card-label">${escape(mk.label)}</span>
                <label class="switch"><input type="checkbox" data-mkt="${mk.key}" ${m[mk.key] !== false ? 'checked' : ''}><span class="switch-slider"></span></label>
            </div>
        `).join('');
        card.querySelectorAll('input[data-mkt]').forEach((inp) => {
            inp.addEventListener('change', async (e) => {
                const cur = (await Store.sync.getOne(C.STORAGE_SYNC.AUTOJOBS_SETTINGS, settings)) || settings;
                cur.markets = cur.markets || {};
                cur.markets[e.target.dataset.mkt] = e.target.checked;
                await Store.sync.setOne(C.STORAGE_SYNC.AUTOJOBS_SETTINGS, cur);
            });
        });
        host.appendChild(card);
    }

    function renderQueue(host, queue, bugged) {
        host.innerHTML = '';
        host.appendChild(el('div', 'section-title', `Queue (${queue.length})`));
        if (queue.length === 0) {
            host.appendChild(el('div', 'empty', 'Queue is empty.'));
        } else {
            for (const j of queue) {
                const c = el('div', 'job-card');
                c.innerHTML = `
                    <div class="job-name">${escape(j.jobName || j.jobId)}</div>
                    <div class="job-meta">[${escape(j.jobType)}]${j.serverName ? ' · ' + escape(j.serverName) : ''}${j.fileCondition ? ' · ' + escape(j.fileCondition) : ''}</div>
                `;
                host.appendChild(c);
            }
        }

        const buggedKeys = Object.keys(bugged || {});
        if (buggedKeys.length > 0) {
            host.appendChild(el('div', 'section-title', `Bugged (${buggedKeys.length})`));
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
            host.appendChild(bcard);
        }
    }

    async function render(container) {
        const [settings, state, queue, bugged] = await Promise.all([
            Store.sync.getOne(C.STORAGE_SYNC.AUTOJOBS_SETTINGS, DEFAULT_SETTINGS),
            Store.local.getOne(C.STORAGE_LOCAL.AUTOJOBS_STATE, { status: 'idle' }),
            Store.local.getOne(C.STORAGE_LOCAL.AUTOJOBS_QUEUE, []),
            Store.local.getOne(C.STORAGE_LOCAL.BUGGED_JOBS, {}),
        ]);

        // Tear down a previous logViewer if we're re-rendering — its storage
        // listener leaks otherwise.
        if (liveLogViewer) { try { liveLogViewer.destroy(); } catch (_) {} liveLogViewer = null; }

        container.innerHTML = '';

        const headerHost = el('div');
        const sourcesHost = el('div');
        const queueHost = el('div');
        const logHost = el('div');
        container.appendChild(headerHost);
        container.appendChild(sourcesHost);
        container.appendChild(queueHost);

        renderHeader(headerHost, settings, state);
        renderSources(sourcesHost, settings);
        renderQueue(queueHost, queue, bugged);

        // Activity log — Logger ring filtered to module='auto-jobs'. The
        // logViewer subscribes to cor3_logs storage changes itself, so we
        // don't need to re-render it on every tick.
        container.appendChild(el('div', 'section-title', 'Activity log'));
        const stream = el('div', 'log-stream');
        container.appendChild(stream);
        liveLogViewer = uiComponents.logViewer.attach(stream, { moduleFilter: 'auto-jobs' });
    }

    let unsub1 = null, unsub2 = null;
    root.COR3.ui.autojobs = {
        mount(container) {
            // Re-render on state/queue/bugged changes. Activity log lives in
            // its own subscriber — see liveLogViewer above. We deliberately
            // don't trip a full re-render on cor3_logs (would tear down and
            // re-attach the viewer every log line).
            unsub1 = Store.local.onChanged((changes) => {
                if (!container.classList.contains('active')) return;
                if (changes[C.STORAGE_LOCAL.AUTOJOBS_STATE] ||
                    changes[C.STORAGE_LOCAL.AUTOJOBS_QUEUE] ||
                    changes[C.STORAGE_LOCAL.BUGGED_JOBS]) render(container);
            });
            unsub2 = Store.sync.onChanged((changes) => {
                if (changes[C.STORAGE_SYNC.AUTOJOBS_SETTINGS] && container.classList.contains('active')) render(container);
            });
            render(container);
        },
        activate(container) { render(container); },
        deactivate() {
            if (liveLogViewer) { try { liveLogViewer.destroy(); } catch (_) {} liveLogViewer = null; }
        },
    };
})();
