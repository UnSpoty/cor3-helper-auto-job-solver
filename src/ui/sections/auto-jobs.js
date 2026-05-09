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

    // Mirror of auto-jobs.js JOB_TYPE_KEYWORDS so the UI can label rows
    // without round-tripping to the orchestrator. Keep in sync; if a new job
    // type is added, copy it here too — small enough that DRYing this through
    // a shared module isn't worth the IIFE-load-order complication.
    const UI_JOB_TYPE_KEYWORDS = {
        file_decryption:  ['file decryption',   'file_decryption'],
        ip_cleanup:       ['ip cleanup',         'ip_cleanup'],
        ip_injection:     ['ip injection',       'ip_injection'],
        log_deletion:     ['log deletion',       'log_deletion'],
        log_download:     ['log download',       'log_download'],
        file_elimination: ['file elimination',   'file_elimination'],
        data_download:    ['data download',      'data_download'],
        data_upload:      ['data upload',        'data_upload'],
        decrypt_extract:  ['decrypt & extract',  'decrypt and extract', 'decrypt_extract'],
    };
    function detectJobType(job) {
        const name = (job.name || job.category || '').toLowerCase();
        for (const [type, keywords] of Object.entries(UI_JOB_TYPE_KEYWORDS)) {
            if (keywords.some((kw) => name.includes(kw))) return type;
        }
        return null;
    }
    function jobServer(job) {
        const rs = job.relatedServers;
        if (Array.isArray(rs) && rs[0]) return rs[0].serverName || rs[0].name || null;
        if (typeof rs === 'string') return rs;
        return null;
    }

    // Build a single available-jobs row. State chips:
    //   • "queued" — already accepted into autoJobsQueue
    //   • "running" — current state.jobId
    //   • "skip" — server is in serverPriorities[name]==='skip'
    //   • "bug" — job id in buggedJobs (still TTL'd)
    //   • "off" — market disabled OR job-type disabled
    function jobRow(job, source, ctx) {
        const type = detectJobType(job);
        const server = jobServer(job);
        const depth = (server && ctx.nmDepths[server] != null) ? ctx.nmDepths[server] : null;

        const tags = [];
        let dim = false;
        if (!ctx.marketEnabled) { tags.push('off'); dim = true; }
        if (type && ctx.enabledJobTypes && ctx.enabledJobTypes[type] === false) { tags.push('off'); dim = true; }
        if (server && ctx.priorities[server] === 'skip') { tags.push('skip'); dim = true; }
        if (ctx.buggedJobs[job.id]) { tags.push('bug'); dim = true; }
        if (ctx.queuedIds.has(job.id)) tags.push('queued');
        if (ctx.runningJobId === job.id) tags.push('running');

        const depthBadge = (depth != null)
            ? `<span class="pill idle" title="BFS depth from Home">${depth}</span>`
            : (server ? `<span class="pill warn" title="Off-tree (separate sub-network)">∞</span>` : '');
        const reward = Number.isFinite(job.rewardCredits) ? `${job.rewardCredits} CR` : '';
        const tagHtml = tags.length
            ? '<span class="row gap-sm">' + tags.map((t) => `<span class="pill ${t === 'running' ? 'active' : t === 'queued' ? 'idle' : 'warn'}">${t}</span>`).join('') + '</span>'
            : '';

        const row = el('div', 'job-card' + (dim ? ' disabled' : ''));
        row.innerHTML = `
            <div class="row gap-sm">
                ${depthBadge}
                <span class="job-name">${escape(job.name || 'Unknown')}</span>
                ${tagHtml}
            </div>
            <div class="job-meta">${server ? escape(server) : '—'}${reward ? ' · ' + escape(reward) : ''} · <span class="muted xs">${escape(source)}</span></div>
        `;
        return row;
    }

    function renderAvailableJobs(host, marketsData, settings, priorities, buggedJobs, queue, state, nmGraph) {
        host.innerHTML = '';
        // marketsData = [{ key, label, data, enabled }, ...]
        const totalShown = marketsData.reduce((n, m) => n + (m.data?.jobs?.length || 0), 0);
        host.appendChild(el('div', 'section-title', `Available jobs (${totalShown})`));
        if (totalShown === 0) {
            host.appendChild(el('div', 'empty', 'No jobs visible on any market.'));
            return;
        }

        // Lookup tables shared across rows
        const nmDepths = {};
        if (nmGraph && Array.isArray(nmGraph.servers)) {
            for (const s of nmGraph.servers) {
                if (s.name && Number.isFinite(s.depth)) nmDepths[s.name] = s.depth;
            }
        }
        const queuedIds = new Set((queue || []).map((j) => j.jobId));
        const runningJobId = state?.jobId || null;
        const ctx = {
            nmDepths,
            priorities: priorities || {},
            buggedJobs: buggedJobs || {},
            queuedIds,
            runningJobId,
            enabledJobTypes: settings?.enabledJobTypes || {},
            marketEnabled: true,  // overwritten per market below
        };

        for (const m of marketsData) {
            const jobs = m.data?.jobs || [];
            if (jobs.length === 0) continue;

            const card = el('div', 'card' + (m.enabled ? '' : ' disabled'));
            const header = el('div', 'card-row');
            header.innerHTML = `
                <span class="card-label">${escape(m.label)}${m.enabled ? '' : ' · disabled'}</span>
                <span class="muted sm">${jobs.length} job(s)</span>
            `;
            card.appendChild(header);

            const marketCtx = { ...ctx, marketEnabled: m.enabled };
            // Sort within a market: queued first, then by depth descending
            // (deepest first — matches orchestrator's jobPriority ordering).
            const sorted = [...jobs].sort((a, b) => {
                const aQ = queuedIds.has(a.id) ? 1 : 0;
                const bQ = queuedIds.has(b.id) ? 1 : 0;
                if (aQ !== bQ) return bQ - aQ;
                const da = nmDepths[jobServer(a)] ?? -1;
                const db = nmDepths[jobServer(b)] ?? -1;
                return db - da;
            });
            for (const job of sorted) card.appendChild(jobRow(job, m.label, marketCtx));
            host.appendChild(card);
        }
    }

    function renderServerPriorities(host, nmGraph, priorities) {
        host.innerHTML = '';
        const wrap = document.createElement('details');
        wrap.className = 'collapsible';
        wrap.open = false;
        const skipCount = Object.values(priorities || {}).filter((v) => v === 'skip').length;
        const summary = document.createElement('summary');
        summary.className = 'section-title';
        summary.textContent = `Server priorities${skipCount > 0 ? ` · ${skipCount} skipped` : ''}`;
        wrap.appendChild(summary);

        const card = el('div', 'card');
        card.appendChild(el('div', 'muted xs',
            'Each server shows its BFS depth (hops from Home). Auto-jobs runs deeper servers first by default — keeps K/D timers off the hubs. Toggle Skip to refuse jobs for a server entirely.'));

        const allServers = (nmGraph && Array.isArray(nmGraph.servers)) ? nmGraph.servers : [];
        const targetable = allServers.filter((s) => s.name && s.name !== nmGraph?.home);

        const rescanRow = el('div', 'row gap-sm mt-sm');
        const rescanBtn = el('button', 'btn small', 'Refresh graph');
        rescanBtn.addEventListener('click', async () => {
            const tab = await getCor3Tab();
            if (tab) chrome.tabs.sendMessage(tab.id, { action: 'rescanNetworkMap' }).catch(() => {});
        });
        rescanRow.appendChild(rescanBtn);
        rescanRow.appendChild(el('span', 'muted xs', `${targetable.length} known${nmGraph?.home ? ` · home: ${escape(nmGraph.home)}` : ''}`));
        card.appendChild(rescanRow);

        const list = el('div', 'mt-sm');
        if (targetable.length === 0) {
            list.appendChild(el('div', 'muted sm', 'No graph data yet — click Refresh graph (the extension fetches it automatically on connect; this button is for manual re-sync after maintenance).'));
        } else {
            // Sort by depth ascending (shallowest at the top of the visible
            // list = closest to home), with name as tiebreaker. This is a
            // display order; the runtime priority is opposite (deepest first).
            const sorted = [...targetable].sort((a, b) => {
                const da = Number.isFinite(a.depth) ? a.depth : 999;
                const db = Number.isFinite(b.depth) ? b.depth : 999;
                if (da !== db) return da - db;
                return (a.name || '').localeCompare(b.name || '');
            });
            for (const s of sorted) {
                const skipped = priorities[s.name] === 'skip';
                const depthBadge = Number.isFinite(s.depth) ? `<span class="pill idle" title="BFS depth from Home">${s.depth}</span>` : `<span class="pill warn" title="No path from Home — ${escape(s.faction || '')}">∞</span>`;
                const row = el('div', 'card-row mt-sm');
                row.innerHTML = `
                    <span class="row gap-sm">
                        ${depthBadge}
                        <span class="${skipped ? 'muted sm' : 'sm'}">${escape(s.name)}</span>
                    </span>
                    <label class="switch" title="Skip — never accept jobs for this server">
                        <input type="checkbox" data-server="${escape(s.name)}" ${skipped ? 'checked' : ''}>
                        <span class="switch-slider"></span>
                    </label>
                `;
                list.appendChild(row);
            }
            list.addEventListener('change', async (e) => {
                if (!e.target.dataset.server) return;
                const cur = (await Store.sync.getOne(C.STORAGE_SYNC.SERVER_PRIORITIES, {})) || {};
                const name = e.target.dataset.server;
                if (e.target.checked) cur[name] = 'skip';
                else delete cur[name];
                await Store.sync.setOne(C.STORAGE_SYNC.SERVER_PRIORITIES, cur);
            });
        }
        card.appendChild(list);
        wrap.appendChild(card);
        host.appendChild(wrap);
    }

    async function render(container) {
        const [settings, state, queue, bugged, nmGraph, priorities, home, dark, srm] = await Promise.all([
            Store.sync.getOne(C.STORAGE_SYNC.AUTOJOBS_SETTINGS, DEFAULT_SETTINGS),
            Store.local.getOne(C.STORAGE_LOCAL.AUTOJOBS_STATE, { status: 'idle' }),
            Store.local.getOne(C.STORAGE_LOCAL.AUTOJOBS_QUEUE, []),
            Store.local.getOne(C.STORAGE_LOCAL.BUGGED_JOBS, {}),
            Store.local.getOne(C.STORAGE_LOCAL.NM_GRAPH, null),
            Store.sync.getOne(C.STORAGE_SYNC.SERVER_PRIORITIES, {}),
            Store.local.getOne(C.STORAGE_LOCAL.MARKET, null),
            Store.local.getOne(C.STORAGE_LOCAL.DARK_MARKET, null),
            Store.local.getOne(C.STORAGE_LOCAL.SRM_MARKET, null),
        ]);

        // Tear down a previous logViewer if we're re-rendering — its storage
        // listener leaks otherwise.
        if (liveLogViewer) { try { liveLogViewer.destroy(); } catch (_) {} liveLogViewer = null; }

        container.innerHTML = '';

        const headerHost = el('div');
        const sourcesHost = el('div');
        const queueHost = el('div');
        const availHost = el('div');
        const prioHost = el('div');
        container.appendChild(headerHost);
        container.appendChild(sourcesHost);
        container.appendChild(queueHost);
        container.appendChild(availHost);
        container.appendChild(prioHost);

        renderHeader(headerHost, settings, state);
        renderSources(sourcesHost, settings);
        renderQueue(queueHost, queue, bugged);
        renderAvailableJobs(availHost, [
            { key: 'home', label: 'Home Market', data: home, enabled: settings.markets?.home !== false },
            { key: 'dark', label: 'Dark Market', data: dark, enabled: settings.markets?.dark !== false },
            { key: 'srm',  label: 'SRM7-M',      data: srm,  enabled: settings.markets?.srm  !== false },
        ], settings, priorities, bugged, queue, state, nmGraph);
        renderServerPriorities(prioHost, nmGraph, priorities || {});

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
                    changes[C.STORAGE_LOCAL.BUGGED_JOBS] ||
                    changes[C.STORAGE_LOCAL.NM_GRAPH] ||
                    changes[C.STORAGE_LOCAL.MARKET] ||
                    changes[C.STORAGE_LOCAL.DARK_MARKET] ||
                    changes[C.STORAGE_LOCAL.SRM_MARKET]) render(container);
            });
            unsub2 = Store.sync.onChanged((changes) => {
                if (!container.classList.contains('active')) return;
                if (changes[C.STORAGE_SYNC.AUTOJOBS_SETTINGS] ||
                    changes[C.STORAGE_SYNC.SERVER_PRIORITIES]) render(container);
            });
            render(container);
        },
        activate(container) { render(container); },
        deactivate() {
            if (liveLogViewer) { try { liveLogViewer.destroy(); } catch (_) {} liveLogViewer = null; }
        },
    };
})();
