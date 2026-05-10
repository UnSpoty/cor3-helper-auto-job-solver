// src/ui/sections/auto-jobs.js — master toggle, status, queue, activity log.
// Activity log is rendered via uiComponents.logViewer filtered to
// module='auto-jobs' (the same component the Logs tab uses); the legacy
// per-module AUTOJOBS_LOG ring is gone.

(function () {
    const root = window;
    root.COR3.ui = root.COR3.ui || {};
    const { Store, constants: C, uiComponents } = root.COR3;
    const t = (k, vars) => root.COR3.i18n.t(k, vars);

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
    const DEFAULT_SETTINGS = { enabled: false, markets: { home: true, dark: true, srm: true }, enabledJobTypes: {}, autoDismissFailed: true };

    // The header card and the queue/bugged sections need to re-render on
    // state/queue changes; the activity log lives separately and uses its
    // own subscriber inside uiComponents.logViewer (no full re-mount).
    let liveLogViewer = null;

    // Solvers Auto-Jobs depends on. Each one corresponds to a chrome.storage.
    // sync key on the Overview tab (Auto solvers section). If any of these
    // is off, Auto-Jobs would accept jobs and then sit waiting on a minigame
    // that nobody's solving — better to refuse to start.
    function requiredSolvers() {
        return [
            { key: C.STORAGE_SYNC.AUTO_DECRYPT_ENABLED,  label: t('overview.autoDecrypt'),  reason: 'file_decryption / decrypt_extract jobs open a config-hack minigame that this solver handles' },
            { key: C.STORAGE_SYNC.AUTO_ICE_WALL_ENABLED, label: t('overview.autoIceWall'), reason: 'reconnecting to a server can drop into the ICE break minigame; this solver handles it' },
        ];
    }

    // Phase 4 header: state pill + description + next-hint, plus action
    // buttons (Start/Stop, Reset, Download Log). Reads STATE_LABELS from
    // the orchestrator helper (loaded into popup.html in Phase 4).
    function renderHeader(host, settings, state, solverFlags) {
        host.innerHTML = '';

        // Phase 5: HALTED banner. Renders ABOVE the regular header card so
        // it's the first thing the user sees when the orchestrator threw
        // in the towel. The "Reset" button below will clear it.
        if (state.status === 'halted') {
            const banner = el('div', 'card aj-halted-banner');
            const reason = state.haltReason || 'Unknown reason';
            banner.innerHTML = `
                <div class="card-row">
                    <span class="card-label">⚠ Auto-Jobs HALTED</span>
                    <span class="pill err">halted</span>
                </div>
                <div class="state-desc xs">${escape(reason)}</div>
                <div class="muted xs mt-sm">
                    Reached ${escape('3×')} consecutive failures. Click <b>Reset</b> below to clear and resume,
                    or check the activity log + Download Log for details.
                </div>
            `;
            host.appendChild(banner);
        }

        const head = el('div', 'card');

        const required = requiredSolvers();
        const missingSolvers = required.filter((s) => !solverFlags[s.key]);
        const blocked = missingSolvers.length > 0;

        const states = root.COR3.autoJobs && root.COR3.autoJobs.states;
        const canonical = (states && states.mapLegacyToCanonical(state.status)) || state.status || 'idle';
        const labels = states && states.STATE_LABELS;
        const meta = (labels && labels[canonical]) || { title: state.status || '?', description: '', nextHint: null };
        const nextMeta = (labels && meta.nextHint && labels[meta.nextHint]) || null;

        const moduleStateClass = canonical.replace(/_/g, '-');

        // Top row: title + ON/OFF pill
        const topRow = el('div', 'card-row');
        topRow.innerHTML = `
            <span class="card-label">${escape(t('autojobs.title'))}</span>
            <span class="pill ${settings.enabled ? 'active' : 'idle'}">${settings.enabled ? t('common.on') : t('common.off')}</span>
        `;
        head.appendChild(topRow);

        // State pill row + next-state hint
        const stateRow = el('div', 'card-row mt-sm');
        const nextHint = nextMeta ? `<span class="muted xs">→ next: ${escapeAttr(nextMeta.title)}</span>` : '';
        stateRow.innerHTML = `
            <span class="card-label">${escape(t('autojobs.status'))}</span>
            <span class="pill aj-state aj-state-${escapeAttr(moduleStateClass)}">${escape(meta.title || canonical)}</span>
            ${nextHint}
        `;
        head.appendChild(stateRow);

        if (meta.description) {
            head.appendChild(el('div', 'state-desc xs muted mt-sm', escape(meta.description)));
        }

        if (state.jobName) {
            head.appendChild(el('div', 'sm mt-sm',
                `${escape(state.jobName)} <span class="muted">[${escape(state.jobType || '')}]</span>`
                + (state.serverName ? ` <span class="muted">@ ${escape(state.serverName)}</span>` : '')));
        }

        if (blocked && !settings.enabled) {
            const warn = el('div', 'card-row mt-sm');
            warn.innerHTML = `
                <span class="pill warn">${escape(t('autojobs.requiredSolvers'))}</span>
                <span class="sm muted">${escape(t('autojobs.enableInOverview'))}</span>
            `;
            head.appendChild(warn);
            const list = el('div', 'mt-sm');
            for (const s of missingSolvers) {
                list.appendChild(el('div', 'sm', `· <b>${escape(s.label)}</b> — <span class="muted xs">${escape(s.reason)}</span>`));
            }
            head.appendChild(list);
        }

        // Action buttons: primary Start/Stop, secondary Reset + Download Log.
        const toggleBtn = el('button', 'btn btn-block mt-sm', settings.enabled ? t('common.stop') : t('common.start'));
        toggleBtn.classList.toggle('btn-danger', !!settings.enabled);
        toggleBtn.classList.toggle('btn-success', !settings.enabled && !blocked);
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

        const actionRow = el('div', 'aj-action-row mt-sm');
        // Reset — force the orchestrator out of any stuck state.
        const resetBtn = el('button', 'btn small', 'Reset');
        resetBtn.title = 'Force the orchestrator back to idle and clear the queue';
        resetBtn.addEventListener('click', async () => {
            if (!confirm('Reset Auto-Jobs?\n\nThis aborts the current flow, clears the queue, and forces the orchestrator back to idle. Permanently rejected entries are kept (clear those separately).')) return;
            const tab = await getCor3Tab();
            if (tab) chrome.tabs.sendMessage(tab.id, { action: 'autoJobsReset' }).catch(() => {});
        });
        actionRow.appendChild(resetBtn);

        // Download Log — full debug bundle (settings + NM_GRAPH summary +
        // reachability + queue + rejected jobs + module logs).
        const downloadBtn = el('button', 'btn small', 'Download Log');
        downloadBtn.title = 'Save a full Auto-Jobs debug bundle as a .txt file';
        downloadBtn.addEventListener('click', async () => {
            try {
                const exporter = root.COR3.autoJobs && root.COR3.autoJobs.logExport;
                if (!exporter || typeof exporter.downloadDebugBundle !== 'function') {
                    alert('Log export helper is unavailable in this context.');
                    return;
                }
                downloadBtn.disabled = true;
                downloadBtn.textContent = 'Building…';
                const bytes = await exporter.downloadDebugBundle();
                downloadBtn.textContent = `Downloaded (${Math.ceil((bytes || 0) / 1024)} KB)`;
                setTimeout(() => { downloadBtn.disabled = false; downloadBtn.textContent = 'Download Log'; }, 2500);
            } catch (err) {
                downloadBtn.disabled = false;
                downloadBtn.textContent = 'Download Log';
                alert('Failed to build debug bundle: ' + (err && err.message || err));
            }
        });
        actionRow.appendChild(downloadBtn);
        head.appendChild(actionRow);

        host.appendChild(head);
    }

    // Helper: HTML-attr escape for class names / titles. Reuses `escape` for
    // the same encoding but exists as a named import so it's clear what
    // context the value is going into.
    function escapeAttr(s) { return escape(s); }

    function renderSources(host, settings) {
        host.innerHTML = '';
        host.appendChild(el('div', 'section-title', t('autojobs.sources')));
        const card = el('div', 'card');
        // Adding a 4th market = one row. The toggles all read settings.markets.<key>
        // which the auto-jobs orchestrator scans against MARKETS_FOR_SCAN.
        const MARKET_LABELS = [
            { key: 'home', label: t('overview.homeMarket') },
            { key: 'dark', label: t('overview.darkMarket') },
            { key: 'srm',  label: t('overview.srm') },
        ];
        const m = settings.markets || {};
        const marketRows = MARKET_LABELS.map((mk, i) => `
            <div class="card-row${i > 0 ? ' mt-sm' : ''}">
                <span class="card-label">${escape(mk.label)}</span>
                <label class="switch"><input type="checkbox" data-mkt="${mk.key}" ${m[mk.key] !== false ? 'checked' : ''}><span class="switch-slider"></span></label>
            </div>
        `).join('');
        // Auto-dismiss FAILED jobs — one master switch. The orchestrator's
        // dismissFailedFromMarkets walks recentJobs on every market arrival
        // and dispatches a market.job.dismiss for any status==='FAILED'
        // entry it hasn't seen yet. Kept ON by default — failed jobs are
        // pure clutter and there's no reason to keep them around.
        const dismissOn = settings.autoDismissFailed !== false;
        const dismissRow = `
            <div class="card-row mt-sm" title="${escape(t('autojobs.autoDismissHint'))}">
                <span class="card-label">${escape(t('autojobs.autoDismiss'))}</span>
                <label class="switch"><input type="checkbox" data-aj-toggle="autoDismissFailed" ${dismissOn ? 'checked' : ''}><span class="switch-slider"></span></label>
            </div>
        `;
        card.innerHTML = marketRows + dismissRow;
        card.querySelectorAll('input[data-mkt]').forEach((inp) => {
            inp.addEventListener('change', async (e) => {
                const cur = (await Store.sync.getOne(C.STORAGE_SYNC.AUTOJOBS_SETTINGS, settings)) || settings;
                cur.markets = cur.markets || {};
                cur.markets[e.target.dataset.mkt] = e.target.checked;
                await Store.sync.setOne(C.STORAGE_SYNC.AUTOJOBS_SETTINGS, cur);
            });
        });
        card.querySelectorAll('input[data-aj-toggle]').forEach((inp) => {
            inp.addEventListener('change', async (e) => {
                const cur = (await Store.sync.getOne(C.STORAGE_SYNC.AUTOJOBS_SETTINGS, settings)) || settings;
                cur[e.target.dataset.ajToggle] = e.target.checked;
                await Store.sync.setOne(C.STORAGE_SYNC.AUTOJOBS_SETTINGS, cur);
            });
        });
        host.appendChild(card);
    }

    // Per-job-type whitelist. Each toggle writes into
    // settings.enabledJobTypes[type]; the orchestrator's findCandidates and
    // tryResumeInProgress already skip any type whose value is === false
    // (anything else — undefined, true — is treated as enabled). The list
    // is hard-coded against UI_JOB_TYPE_KEYWORDS so adding a new job type
    // means touching this file once + the orchestrator's dispatch table.
    function renderJobTypes(host, settings) {
        host.innerHTML = '';
        const wrap = document.createElement('details');
        wrap.className = 'collapsible';
        wrap.open = true;
        const enabledMap = settings.enabledJobTypes || {};
        const disabledCount = Object.values(enabledMap).filter((v) => v === false).length;
        const summary = document.createElement('summary');
        summary.className = 'section-title';
        summary.textContent = `${t('autojobs.jobTypes')}${disabledCount > 0 ? ` · ${disabledCount} ${t('autojobs.disabled')}` : ''}`;
        wrap.appendChild(summary);

        const card = el('div', 'card');
        card.appendChild(el('div', 'muted xs', t('autojobs.jobTypesHint')));
        const list = el('div', 'mt-sm');
        const types = Object.keys(UI_JOB_TYPE_KEYWORDS);
        for (const type of types) {
            const on = enabledMap[type] !== false;
            const label = t(`autojobs.jobType.${type}`);
            const row = el('div', 'card-row mt-sm');
            row.innerHTML = `
                <span class="card-label">${escape(label)}</span>
                <label class="switch"><input type="checkbox" data-jobtype="${escape(type)}" ${on ? 'checked' : ''}><span class="switch-slider"></span></label>
            `;
            list.appendChild(row);
        }
        list.addEventListener('change', async (e) => {
            const type = e.target.dataset.jobtype;
            if (!type) return;
            const cur = (await Store.sync.getOne(C.STORAGE_SYNC.AUTOJOBS_SETTINGS, settings)) || settings;
            cur.enabledJobTypes = cur.enabledJobTypes || {};
            // Store explicit booleans so undefined keeps meaning "default-on"
            // and we don't have to special-case missing entries elsewhere.
            cur.enabledJobTypes[type] = !!e.target.checked;
            await Store.sync.setOne(C.STORAGE_SYNC.AUTOJOBS_SETTINGS, cur);
        });
        card.appendChild(list);
        wrap.appendChild(card);
        host.appendChild(wrap);
    }

    // Renders the "Permanently skipped" subsection (replaces Phase-2 "Failed/
    // Bugged" with TTL'd entries). Lists rejectedJobs entries with the
    // human-readable reason the flow gave so the user knows exactly why
    // their queue moved on. Auto-cleared when markets refresh and confirm
    // the job is gone, or via the "Clear" button.
    function renderFailed(host, rejected) {
        const ids = Object.keys(rejected || {});
        if (ids.length === 0) return;
        const card = el('div', 'card');
        card.appendChild(el('div', 'card-row', `<span class="card-label">Permanently skipped (${ids.length})</span><span class="muted xs">No retry — markets refresh will clear automatically</span>`));
        const list = el('div', 'mt-sm');
        for (const id of ids.slice(0, 12)) {
            const e = rejected[id] || {};
            const desc = escape(e.descriptor || id);
            const reason = escape(e.reason || 'unknown');
            list.appendChild(el('div', 'sm', `<span class="pill warn">skip</span> ${desc} <span class="muted xs">⤷ ${reason}</span>`));
        }
        if (ids.length > 12) list.appendChild(el('div', 'muted sm mt-sm', `… +${ids.length - 12} more`));
        card.appendChild(list);
        const clear = el('button', 'btn btn-danger small mt-sm', 'Clear all');
        clear.addEventListener('click', async () => {
            const tab = await getCor3Tab();
            // Backend kept the legacy 'clearBuggedJobs' channel name —
            // it now wipes rejectedJobs instead.
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
    //   • "skip" — server in priorities[name]==='skip', OR job permanently rejected
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
        if (ctx.rejectedJobs[job.id]) { tags.push('skip'); dim = true; }
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

    function renderJobs(host, marketsData, settings, priorities, rejectedJobs, queue, state, nmGraph) {
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
            rejectedJobs: rejectedJobs || {},
            queuedIds,
            runningJobId,
            enabledJobTypes: settings?.enabledJobTypes || {},
            marketEnabled: true,  // overwritten per market below
        };

        // Section title with global breakdown so user sees totals at a glance.
        const totalAvailable = marketsData.reduce((n, m) => n + (m.data?.jobs?.length || 0), 0);
        const totalQueued = (queue || []).length;
        const totalFailed = Object.keys(rejectedJobs || {}).length;
        const totalAll = totalAvailable + totalQueued + totalFailed;
        host.appendChild(el('div', 'section-title',
            `${escape(t('autojobs.jobs'))} (${totalAll}) <span class="muted xs">· ${totalAvailable} ${escape(t('autojobs.available'))} · ${totalQueued} ${escape(t('overview.inProgress'))} · ${totalFailed} ${escape(t('autojobs.failed'))}</span>`));

        if (totalAll === 0) {
            host.appendChild(el('div', 'empty', t('autojobs.noJobs')));
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
                <span class="card-label">${escape(m.label)}${m.enabled ? '' : ' · ' + escape(t('autojobs.disabled'))}</span>
                <span class="muted sm">${jobs.length} ${escape(t('overview.avail'))}${marketQueued > 0 ? ` · ${marketQueued} ${escape(t('autojobs.queued'))}` : ''}</span>
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

        // Permanently rejected jobs — at the bottom of Jobs section.
        // No TTL — auto-cleared on market refresh, or via "Clear" button.
        renderFailed(host, rejectedJobs);
    }

    function renderServerPriorities(host, nmGraph, priorities) {
        host.innerHTML = '';
        const wrap = document.createElement('details');
        wrap.className = 'collapsible';
        wrap.open = false;
        const skipCount = Object.values(priorities || {}).filter((v) => v === 'skip').length;
        const summary = document.createElement('summary');
        summary.className = 'section-title';
        summary.textContent = `${t('autojobs.serverPriorities')}${skipCount > 0 ? ` · ${skipCount} skipped` : ''}`;
        wrap.appendChild(summary);

        const card = el('div', 'card');
        card.appendChild(el('div', 'muted xs',
            'Each server shows its BFS depth (hops from Home). Auto-jobs runs deeper servers first by default — keeps K/D timers off the hubs. Toggle Skip to refuse jobs for a server entirely.'));

        const allServers = (nmGraph && Array.isArray(nmGraph.servers)) ? nmGraph.servers : [];
        const targetable = allServers.filter((s) => s.name && s.name !== nmGraph?.home);

        const rescanRow = el('div', 'row gap-sm mt-sm');
        const rescanBtn = el('button', 'btn small', t('autojobs.refreshGraph'));
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

    // Phase 4: state-history timeline. Reads STORAGE_LOCAL.AJ_STATE_HISTORY
    // (orchestrator persists last STATE_HISTORY_RING transitions). Collapsed
    // by default — most users don't need it but it's invaluable when
    // debugging "stuck" reports.
    function renderTimeline(host, history) {
        host.innerHTML = '';
        if (!Array.isArray(history) || history.length === 0) return;

        const states = root.COR3.autoJobs && root.COR3.autoJobs.states;
        const labels = states && states.STATE_LABELS;
        const wrap = document.createElement('details');
        wrap.className = 'collapsible aj-timeline';
        const summary = document.createElement('summary');
        summary.innerHTML = `<span class="card-label">State history</span><span class="muted xs">${history.length} transition(s)</span>`;
        wrap.appendChild(summary);
        const card = el('div', 'card aj-timeline-list');
        // Newest first so the most recent transition is at the top.
        for (const entry of history.slice().reverse()) {
            const ts = entry.ts ? new Date(entry.ts) : null;
            const tsTxt = ts ? `${String(ts.getHours()).padStart(2, '0')}:${String(ts.getMinutes()).padStart(2, '0')}:${String(ts.getSeconds()).padStart(2, '0')}` : '?';
            const toMeta = labels && entry.to && labels[entry.to];
            const toLabel = toMeta ? toMeta.title : (entry.to || '?');
            const fromTxt = entry.from
                ? `<span class="muted xs">${escape((labels && labels[entry.from] && labels[entry.from].title) || entry.from)} →</span> `
                : '';
            const reasonTxt = entry.reason ? `<span class="muted xs"> (${escape(String(entry.reason))})</span>` : '';
            const stateClass = (entry.to || '').replace(/_/g, '-');
            card.appendChild(el('div', 'aj-timeline-row sm',
                `<span class="muted xs aj-timeline-ts">${escape(tsTxt)}</span> ${fromTxt}<span class="pill aj-state aj-state-${escape(stateClass)}">${escape(toLabel)}</span>${reasonTxt}`));
        }
        wrap.appendChild(card);
        host.appendChild(wrap);
    }

    let liveNetworkMap = null;

    async function render(container) {
        const [settings, state, queue, rejected, history, nmGraph, priorities, home, dark, srm, autoDecrypt, autoIceWall] = await Promise.all([
            Store.sync.getOne(C.STORAGE_SYNC.AUTOJOBS_SETTINGS, DEFAULT_SETTINGS),
            Store.local.getOne(C.STORAGE_LOCAL.AUTOJOBS_STATE, { status: 'idle' }),
            Store.local.getOne(C.STORAGE_LOCAL.AUTOJOBS_QUEUE, []),
            Store.local.getOne(C.STORAGE_LOCAL.AJ_REJECTED_JOBS, {}),
            Store.local.getOne(C.STORAGE_LOCAL.AJ_STATE_HISTORY, []),
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

        // Tear down previous live components so their storage listeners don't leak.
        if (liveLogViewer)  { try { liveLogViewer.destroy();  } catch (_) {} liveLogViewer  = null; }
        if (liveNetworkMap) { try { liveNetworkMap.destroy(); } catch (_) {} liveNetworkMap = null; }

        container.innerHTML = '';

        const headerHost = el('div');
        const networkHost = el('div', 'aj-network-host');
        const sourcesHost = el('div');
        const jobTypesHost = el('div');
        const timelineHost = el('div');
        const jobsHost = el('div');
        const prioHost = el('div');
        container.appendChild(headerHost);
        container.appendChild(networkHost);
        container.appendChild(sourcesHost);
        container.appendChild(jobTypesHost);
        container.appendChild(timelineHost);
        container.appendChild(jobsHost);
        container.appendChild(prioHost);

        renderHeader(headerHost, settings, state, solverFlags);

        // Local Network Map — sits between header and sources. Component
        // owns its own storage subscriptions for granular re-renders.
        if (uiComponents.networkMap && typeof uiComponents.networkMap.attach === 'function') {
            liveNetworkMap = uiComponents.networkMap.attach(networkHost);
        }

        renderSources(sourcesHost, settings);
        renderJobTypes(jobTypesHost, settings);
        renderTimeline(timelineHost, history);
        renderJobs(jobsHost, [
            { key: 'home', label: 'Home Market', data: home, enabled: settings.markets?.home !== false },
            { key: 'dark', label: 'Dark Market', data: dark, enabled: settings.markets?.dark !== false },
            { key: 'srm',  label: 'SRM7-M',      data: srm,  enabled: settings.markets?.srm  !== false },
        ], settings, priorities, rejected, queue, state, nmGraph);
        renderServerPriorities(prioHost, nmGraph, priorities || {});

        // Activity log — Logger ring filtered to module='auto-jobs'. The
        // logViewer subscribes to cor3_logs storage changes itself.
        container.appendChild(el('div', 'section-title', t('autojobs.activityLog')));
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
                    changes[C.STORAGE_LOCAL.AJ_REJECTED_JOBS] ||
                    changes[C.STORAGE_LOCAL.AJ_STATE_HISTORY] ||
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
            if (liveLogViewer)  { try { liveLogViewer.destroy();  } catch (_) {} liveLogViewer  = null; }
            if (liveNetworkMap) { try { liveNetworkMap.destroy(); } catch (_) {} liveNetworkMap = null; }
        },
    };
})();
