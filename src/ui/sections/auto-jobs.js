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

    // Solvers Auto-Jobs depends on. Each one corresponds to a chrome.storage.
    // sync key on the Overview tab (Auto solvers section). If any of these
    // is off, Auto-Jobs would accept jobs and then sit waiting on a minigame
    // that nobody's solving — better to refuse to start.
    const REQUIRED_SOLVERS = [
        { key: C.STORAGE_SYNC.AUTO_DECRYPT_ENABLED,  label: 'Auto-decrypt',  reason: 'file_decryption / decrypt_extract jobs open a config-hack minigame that this solver handles' },
        { key: C.STORAGE_SYNC.AUTO_ICE_WALL_ENABLED, label: 'Auto ICE WALL', reason: 'reconnecting to a server can drop into the ICE break minigame; this solver handles it' },
    ];

    function renderHeader(host, settings, state, solverFlags) {
        host.innerHTML = '';
        const head = el('div', 'card');

        const missingSolvers = REQUIRED_SOLVERS.filter((s) => !solverFlags[s.key]);
        const blocked = missingSolvers.length > 0;

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

        if (blocked && !settings.enabled) {
            // Render a small warn-card listing exactly which solvers to enable
            // and why. Lives between status and the START button so the user
            // sees the gate before they click.
            const warn = el('div', 'card-row mt-sm');
            warn.innerHTML = `
                <span class="pill warn">Required solvers</span>
                <span class="sm muted">enable in Overview → Auto solvers</span>
            `;
            head.appendChild(warn);
            const list = el('div', 'mt-sm');
            for (const s of missingSolvers) {
                list.appendChild(el('div', 'sm', `· <b>${escape(s.label)}</b> — <span class="muted xs">${escape(s.reason)}</span>`));
            }
            head.appendChild(list);
        }

        const toggleBtn = el('button', 'btn btn-block mt-sm', settings.enabled ? 'STOP' : 'START');
        toggleBtn.classList.toggle('btn-danger', !!settings.enabled);
        toggleBtn.classList.toggle('btn-success', !settings.enabled && !blocked);
        // Stop is always allowed; start is gated on solvers being on.
        toggleBtn.disabled = blocked && !settings.enabled;
        if (toggleBtn.disabled) toggleBtn.title = `Enable required solvers first: ${missingSolvers.map((s) => s.label).join(', ')}`;
        toggleBtn.addEventListener('click', async () => {
            if (toggleBtn.disabled) return;
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

    // Renders the "Failed" subsection (formerly "Bugged") that lists jobs
    // currently in the soft/hard bug TTL. Lives inside the Jobs section now;
    // queue items are visualised via per-row chips in renderJobs instead of
    // a separate Queue list (they were duplicate info).
    function renderFailed(host, bugged) {
        const buggedKeys = Object.keys(bugged || {});
        if (buggedKeys.length === 0) return;
        const card = el('div', 'card');
        card.appendChild(el('div', 'card-row', `<span class="card-label">Failed (${buggedKeys.length})</span><span class="muted xs">soft- and hard-bugged jobs, awaiting TTL</span>`));
        const list = el('div', 'mt-sm');
        const now = Date.now();
        for (const id of buggedKeys.slice(0, 12)) {
            const e = bugged[id] || {};
            const ttlMs = e.ttl || 2 * 60 * 60 * 1000;
            const remainingMs = Math.max(0, (e.ts || 0) + ttlMs - now);
            const remainingMin = Math.ceil(remainingMs / 60000);
            list.appendChild(el('div', 'sm', `<span class="pill warn">bug</span> ${escape(e.name || id)} <span class="muted xs">— retry in ${remainingMin}m</span>`));
        }
        if (buggedKeys.length > 12) list.appendChild(el('div', 'muted sm mt-sm', `… +${buggedKeys.length - 12} more`));
        card.appendChild(list);
        const clear = el('button', 'btn btn-danger small mt-sm', 'Clear failed');
        clear.addEventListener('click', async () => {
            const tab = await getCor3Tab();
            if (tab) chrome.tabs.sendMessage(tab.id, { action: 'clearBuggedJobs' }).catch(() => {});
        });
        card.appendChild(clear);
        host.appendChild(card);
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

    // Render queued-but-not-visible jobs as a synthetic job-like object
    // (autoJobsQueue stores resolved entries: jobId/marketId/jobName/jobType/
    // serverName/etc — not the original market job{}, so we have to fake the
    // shape to feed into jobRow). Used when a job was accepted (taken off the
    // market board) but hasn't finished executing yet — without this it'd
    // disappear from Jobs entirely between accept and complete.
    function syntheticJobFromQueue(q) {
        return {
            id: q.jobId,
            name: q.jobName || q.jobType || q.jobId,
            relatedServers: q.serverName ? [{ serverName: q.serverName }] : null,
            // No rewardCredits available — leave undefined, jobRow handles it
        };
    }

    function renderJobs(host, marketsData, settings, priorities, buggedJobs, queue, state, nmGraph) {
        host.innerHTML = '';

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

        // Section title with global breakdown so user sees totals at a glance.
        const totalAvailable = marketsData.reduce((n, m) => n + (m.data?.jobs?.length || 0), 0);
        const totalQueued = (queue || []).length;
        const totalFailed = Object.keys(buggedJobs || {}).length;
        const totalAll = totalAvailable + totalQueued + totalFailed;
        host.appendChild(el('div', 'section-title',
            `Jobs (${totalAll}) <span class="muted xs">· ${totalAvailable} available · ${totalQueued} in progress · ${totalFailed} failed</span>`));

        if (totalAll === 0) {
            host.appendChild(el('div', 'empty', 'No jobs visible.'));
            return;
        }

        for (const m of marketsData) {
            const jobs = m.data?.jobs || [];
            // Queue items belonging to this market that are NOT on the
            // visible job board — usually accepted-but-not-finished. We
            // synthesise a job{} shape for jobRow to consume so they appear
            // in the list with correct chips (running/queued).
            const visibleIds = new Set(jobs.map((j) => j.id));
            const orphanQueueItems = (queue || []).filter((q) =>
                q.marketId === m.data?.marketId && !visibleIds.has(q.jobId));
            const orphanRows = orphanQueueItems.map(syntheticJobFromQueue);

            if (jobs.length === 0 && orphanRows.length === 0) continue;

            const card = el('div', 'card' + (m.enabled ? '' : ' disabled'));
            const header = el('div', 'card-row');
            const marketQueued = (queue || []).filter((q) => q.marketId === m.data?.marketId).length;
            header.innerHTML = `
                <span class="card-label">${escape(m.label)}${m.enabled ? '' : ' · disabled'}</span>
                <span class="muted sm">${jobs.length} avail${marketQueued > 0 ? ` · ${marketQueued} queued` : ''}</span>
            `;
            card.appendChild(header);

            const marketCtx = { ...ctx, marketEnabled: m.enabled };
            // Sort within a market: running first, queued second, then by
            // depth descending (deepest first — matches orchestrator's
            // jobPriority ordering).
            const all = [...jobs, ...orphanRows];
            all.sort((a, b) => {
                const aR = runningJobId === a.id ? 2 : (queuedIds.has(a.id) ? 1 : 0);
                const bR = runningJobId === b.id ? 2 : (queuedIds.has(b.id) ? 1 : 0);
                if (aR !== bR) return bR - aR;
                const da = nmDepths[jobServer(a)] ?? -1;
                const db = nmDepths[jobServer(b)] ?? -1;
                return db - da;
            });
            for (const job of all) card.appendChild(jobRow(job, m.label, marketCtx));
            host.appendChild(card);
        }

        // Failed (bugged) jobs — at the bottom of Jobs section. Includes
        // soft-bugs (transient timeouts, 15 min) and hard-bugs (2 h).
        renderFailed(host, buggedJobs);
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
        // Last-refresh timestamp gives the user feedback that Refresh did
        // fire even when the topology didn't actually change between calls.
        const updatedAt = nmGraph?.updatedAt ? new Date(nmGraph.updatedAt).toLocaleTimeString() : null;
        rescanRow.appendChild(el('span', 'muted xs',
            `${targetable.length} known${nmGraph?.home ? ` · home: ${escape(nmGraph.home)}` : ''}${updatedAt ? ` · refreshed ${updatedAt}` : ''}`));
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
                let depthBadge;
                if (Number.isFinite(s.depth)) {
                    if (s.viaHidden) {
                        // Side-network server reachable only via a hidden
                        // gateway edge (D4RK / SRM7). Distinct visual so
                        // the user knows the depth count crosses a faction
                        // boundary that requires set.endpoint preflight.
                        depthBadge = `<span class="pill warn" title="Reachable via hidden gateway edge — ${escape(s.faction || '?')} side network">${s.depth}*</span>`;
                    } else {
                        depthBadge = `<span class="pill idle" title="BFS depth from Home">${s.depth}</span>`;
                    }
                } else {
                    depthBadge = `<span class="pill warn" title="No path from Home — ${escape(s.faction || '')}">∞</span>`;
                }
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
        const [settings, state, queue, bugged, nmGraph, priorities, home, dark, srm, autoDecrypt, autoIceWall] = await Promise.all([
            Store.sync.getOne(C.STORAGE_SYNC.AUTOJOBS_SETTINGS, DEFAULT_SETTINGS),
            Store.local.getOne(C.STORAGE_LOCAL.AUTOJOBS_STATE, { status: 'idle' }),
            Store.local.getOne(C.STORAGE_LOCAL.AUTOJOBS_QUEUE, []),
            Store.local.getOne(C.STORAGE_LOCAL.BUGGED_JOBS, {}),
            Store.local.getOne(C.STORAGE_LOCAL.NM_GRAPH, null),
            Store.sync.getOne(C.STORAGE_SYNC.SERVER_PRIORITIES, {}),
            Store.local.getOne(C.STORAGE_LOCAL.MARKET, null),
            Store.local.getOne(C.STORAGE_LOCAL.DARK_MARKET, null),
            Store.local.getOne(C.STORAGE_LOCAL.SRM_MARKET, null),
            Store.sync.getOne(C.STORAGE_SYNC.AUTO_DECRYPT_ENABLED, false),
            Store.sync.getOne(C.STORAGE_SYNC.AUTO_ICE_WALL_ENABLED, false),
        ]);
        const solverFlags = {
            [C.STORAGE_SYNC.AUTO_DECRYPT_ENABLED]: !!autoDecrypt,
            [C.STORAGE_SYNC.AUTO_ICE_WALL_ENABLED]: !!autoIceWall,
        };

        // Tear down a previous logViewer if we're re-rendering — its storage
        // listener leaks otherwise.
        if (liveLogViewer) { try { liveLogViewer.destroy(); } catch (_) {} liveLogViewer = null; }

        container.innerHTML = '';

        const headerHost = el('div');
        const sourcesHost = el('div');
        const jobsHost = el('div');
        const prioHost = el('div');
        container.appendChild(headerHost);
        container.appendChild(sourcesHost);
        container.appendChild(jobsHost);
        container.appendChild(prioHost);

        renderHeader(headerHost, settings, state, solverFlags);
        renderSources(sourcesHost, settings);
        // Unified Jobs section: per-market lists with chips for state
        // (queued/running/skip/bug/off) + a Failed card at the bottom.
        // Replaces the separate "Queue" and "Bugged" sections.
        renderJobs(jobsHost, [
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
                    changes[C.STORAGE_SYNC.SERVER_PRIORITIES] ||
                    changes[C.STORAGE_SYNC.AUTO_DECRYPT_ENABLED] ||
                    changes[C.STORAGE_SYNC.AUTO_ICE_WALL_ENABLED]) render(container);
            });
            render(container);
        },
        activate(container) { render(container); },
        deactivate() {
            if (liveLogViewer) { try { liveLogViewer.destroy(); } catch (_) {} liveLogViewer = null; }
        },
    };
})();
