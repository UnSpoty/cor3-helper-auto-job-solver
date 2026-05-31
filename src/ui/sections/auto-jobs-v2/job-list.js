// Auto-Jobs v2 — Job List.
//
// Sits between the Network Map and the Flow Map. Renders the job board the
// pipeline produced (MODULE:JOB_QUEUE), with the detail of each job and a
// SKIP flag (+ reason) for jobs that CHECK_JOBS_CONDITION ruled out.
//
// Pure read of the v2-owned AJV2_JOB_QUEUE key — written by the pipeline,
// never by this component. Shape:
//   { cycle, computedAt, jobs: [{ id, name, type, serverName, marketSlot,
//     marketId, rewardCredits, eligible, skipReason }] }
// `eligible` is null until CHECK_JOBS_CONDITION runs, then a bool.
//
// Exposes attach() on COR3.uiComponentsV2.jobList.

(function () {
    const root = window;
    if (!root.COR3 || !root.COR3.constants) return;
    const { Store, constants: C } = root.COR3;
    const SL = C.STORAGE_LOCAL;

    const SLOT_LABEL = { home: 'Home', dark: 'Dark', srm: 'SRM7-M' };

    function el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text !== undefined) e.textContent = text;
        return e;
    }

    // Remove a job from the v2 bugged registry. The Job List subscribes to the
    // key, so the BUGGED flag clears the instant this resolves.
    async function unbugJob(jobId) {
        const reg = (await Store.local.getOne(C.STORAGE_LOCAL.AJV2_BUGGED_JOBS, {})) || {};
        if (reg[jobId]) {
            delete reg[jobId];
            await Store.local.setOne(C.STORAGE_LOCAL.AJV2_BUGGED_JOBS, reg);
        }
    }

    function jobRow(job, bugInfo) {
        const isBugged = !!bugInfo;
        const inProgress = !isBugged && job.status === 'TAKEN';
        const skipped = !isBugged && !inProgress && job.eligible === false;
        const pending = !isBugged && !inProgress && job.eligible == null;

        const row = el('div', 'ajv2-job'
            + (skipped ? ' is-skip' : '')
            + (inProgress ? ' is-active' : '')
            + (isBugged ? ' is-bugged' : ''));

        const head = el('div', 'ajv2-job-head');
        head.appendChild(el('span', 'job-name', job.name || 'Unknown'));

        if (isBugged) {
            head.appendChild(el('span', 'pill ajv2-bugged', 'BUGGED'));
            const unbug = el('button', 'ajv2-unbug', '✕');
            unbug.title = 'Remove from bugged list';
            unbug.addEventListener('click', (e) => { e.stopPropagation(); unbugJob(job.id); });
            head.appendChild(unbug);
        } else if (inProgress) {
            head.appendChild(el('span', 'pill ok', 'in-progress'));
        } else if (skipped) {
            const skip = el('span', 'pill ajv2-skip', 'SKIP');
            if (job.skipReason) skip.title = job.skipReason;
            head.appendChild(skip);
        } else if (pending) {
            head.appendChild(el('span', 'pill idle', 'pending'));
        } else {
            head.appendChild(el('span', 'pill ok', 'eligible'));
        }
        row.appendChild(head);

        // Market is now the section header, so it's omitted from the row meta.
        const metaBits = [];
        if (job.type) metaBits.push(job.type);
        metaBits.push(job.serverName || 'no server');
        if (Number.isFinite(job.rewardCredits)) metaBits.push(job.rewardCredits + ' CR');
        row.appendChild(el('div', 'job-meta', metaBits.join(' · ')));

        if (isBugged && bugInfo.reason) {
            row.appendChild(el('div', 'ajv2-skip-reason xs', 'BUGGED: ' + bugInfo.reason));
        } else if (skipped && job.skipReason) {
            row.appendChild(el('div', 'ajv2-skip-reason xs', 'SKIP: ' + job.skipReason));
        }
        return row;
    }

    // One market block: a clickable header (caret + name + status + count) and a
    // collapsible body of its jobs. `collapsed` is a shared Set of slot keys, so
    // the expand/collapse state survives the component's frequent re-renders.
    function marketSection(market, jobs, bugged, collapsed) {
        const slot = market.slot;
        const isCollapsed = collapsed.has(slot);
        const sec = el('div', 'ajv2-market' + (market.reachable === false ? ' is-unreachable' : ''));

        const head = el('div', 'ajv2-market-head');
        const caret = el('span', 'ajv2-market-caret', isCollapsed ? '▸' : '▾');
        head.appendChild(caret);
        head.appendChild(el('span', 'ajv2-market-name', SLOT_LABEL[slot] || slot || '?'));
        if (market.reachable === false) {
            head.appendChild(el('span', 'pill warn', 'unreachable'));
        } else if (market.refreshed === false) {
            const stale = el('span', 'pill idle', 'stale');
            stale.title = 'Refresh timed out — showing the last-known board';
            head.appendChild(stale);
        }
        head.appendChild(el('span', 'muted xs ajv2-market-count', `${jobs.length} ${jobs.length === 1 ? 'job' : 'jobs'}`));
        sec.appendChild(head);

        const bodyWrap = el('div', 'ajv2-market-jobs' + (isCollapsed ? ' collapsed' : ''));
        if (!jobs.length) {
            const why = market.reachable === false ? (market.reason || 'unreachable') : 'No jobs.';
            bodyWrap.appendChild(el('div', 'muted xs ajv2-market-empty', why));
        } else {
            for (const job of jobs) bodyWrap.appendChild(jobRow(job, bugged && bugged[job.id]));
        }
        sec.appendChild(bodyWrap);

        // Click the header to collapse/expand this market.
        head.addEventListener('click', () => {
            const nowCollapsed = !bodyWrap.classList.contains('collapsed');
            bodyWrap.classList.toggle('collapsed', nowCollapsed);
            caret.textContent = nowCollapsed ? '▸' : '▾';
            if (nowCollapsed) collapsed.add(slot); else collapsed.delete(slot);
        });

        return sec;
    }

    // Ask the orchestrator (in the cor3.gg tab) to rebuild the saved job board
    // once from the current markets. No-op when no game tab is open.
    async function requestBoardRefresh() {
        if (!(typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.query)) return;
        const tabs = await chrome.tabs.query({ url: ['https://cor3.gg/*', 'https://os.cor3.gg/*'] });
        const tab = tabs && tabs[0];
        if (tab) { try { await chrome.tabs.sendMessage(tab.id, { action: C.MSG.AUTOJOBS_V2.REFRESH_BOARD }); } catch (_) { /* tab not ready */ } }
    }

    function attach(container) {
        container.classList.add('ajv2-jobs-host');
        container.innerHTML = '';

        // Latest of each input; render() combines them all.
        let lastQueue = null;
        let switches = {};
        let overrides = {};
        let bugged = {};

        // Expand/collapse state per market slot — survives the frequent
        // re-renders (lives in this closure; resets when the popup reopens).
        const collapsed = new Set();

        const wrap = el('div', 'ajv2-jobs');
        const head = el('div', 'ajv2-jobs-head');
        head.appendChild(el('span', 'card-label', 'Jobs'));
        const right = el('div', 'ajv2-jobs-head-right');
        const summary = el('span', 'muted xs ajv2-jobs-summary', '—');
        right.appendChild(summary);
        const refreshBtn = el('button', 'nm-hud-btn ajv2-jobs-refresh', '↻');
        refreshBtn.title = 'Refresh the job board from the markets (rebuilds the saved list). While Auto-Jobs v2 is running the board refreshes automatically each cycle.';
        refreshBtn.addEventListener('click', async () => {
            refreshBtn.disabled = true;
            refreshBtn.textContent = '…';
            try { await requestBoardRefresh(); } catch (_) { /* noop */ }
            // The rebuilt board arrives via the AJV2_JOB_QUEUE onChanged below
            // (which re-renders); just restore the button after a moment.
            setTimeout(() => { refreshBtn.disabled = false; refreshBtn.textContent = '↻'; }, 1200);
        });
        right.appendChild(refreshBtn);
        head.appendChild(right);
        wrap.appendChild(head);

        const list = el('div', 'ajv2-jobs-list');
        wrap.appendChild(list);
        container.appendChild(wrap);

        function render() {
            list.innerHTML = '';

            const queue = lastQueue;
            if (!queue) {
                summary.textContent = 'pipeline not run yet';
                list.appendChild(el('div', 'muted xs ajv2-jobs-empty', 'Press START to run the pipeline.'));
                return;
            }

            const jobs = Array.isArray(queue.jobs) ? queue.jobs : [];

            // Live eligibility: derive display rows from the pipeline's DATA
            // verdict (job.dataSkipReason) + the CONFIG verdict re-derived NOW
            // from the current switches/overrides (shared evaluator), so SKIP
            // flags track a toggle instantly without waiting for the next cycle.
            // Derive into NEW objects — never mutate lastQueue.jobs (the cached
            // storage value), which other readers treat as authoritative.
            const evalConfig = root.COR3.ajv2Eligibility && root.COR3.ajv2Eligibility.configSkipReason;
            const rows = jobs.map((job) => {
                if (!evalConfig || job.status === 'TAKEN') return job;
                const bug = bugged[job.id];
                const bugReason = bug ? `bugged: ${bug.reason || 'unknown'}` : null;
                // CONFIG skip (market / job-type / server toggles) is re-derived
                // LIVE so a Master-Switches or Network-Map change reflects
                // instantly, without waiting for the next pipeline cycle.
                const configSkip = evalConfig(job, switches, overrides);
                // DATA skip (K/D cooldown, server access) is only known once
                // CHECK_JOBS_CONDITION has stamped dataSkipReason onto the job.
                const dataKnown = 'dataSkipReason' in job;
                const dataSkip = dataKnown ? job.dataSkipReason : null;
                const skipReason = [bugReason, dataSkip, configSkip].filter(Boolean).join('; ') || null;
                // Any skip (config / bug / data) shows immediately. With NO skip,
                // only claim "eligible" once the DATA gates have actually run —
                // before that stay pending (eligible:null) rather than paint a
                // premature green on the CONFIG verdict alone (finding #8).
                if (skipReason) return Object.assign({}, job, { skipReason, eligible: false });
                return Object.assign({}, job, { skipReason: null, eligible: dataKnown ? true : null });
            });

            // Counts describe the acceptance board (available jobs); in-progress
            // (TAKEN) and bugged jobs are reported separately. Bugged jobs are
            // excluded from `skipped` so they are not tallied under both buckets.
            const avail = rows.filter((j) => j.status !== 'TAKEN');
            const inProgress = rows.length - avail.length;
            const evaluated = avail.filter((j) => j.eligible != null).length;
            const eligible = avail.filter((j) => j.eligible === true).length;
            const skipped = avail.filter((j) => j.eligible === false && !bugged[j.id]).length;
            const buggedN = rows.filter((j) => bugged[j.id]).length;
            const active = inProgress ? ` · ${inProgress} in-progress` : '';
            const buggedSuffix = buggedN ? ` · ${buggedN} bugged` : '';
            const cyc = `cycle ${queue.cycle || '—'}`;
            summary.textContent = !jobs.length
                ? `0 jobs · ${cyc}`
                : evaluated
                    ? `${avail.length} available · ${eligible} eligible · ${skipped} skip${active}${buggedSuffix} · ${cyc}`
                    : `${avail.length} available${active}${buggedSuffix} · pending · ${cyc}`;

            // Group the derived rows by their market slot.
            const bySlot = {};
            for (const j of rows) (bySlot[j.marketSlot] = bySlot[j.marketSlot] || []).push(j);

            // Render one section per market. Prefer the pipeline's market
            // summary (covers reachable-but-empty + unreachable markets in a
            // stable order); fall back to the slots present in the jobs.
            const markets = (Array.isArray(queue.markets) && queue.markets.length)
                ? queue.markets
                : Object.keys(bySlot).map((slot) => ({ slot, reachable: true, refreshed: true, jobCount: bySlot[slot].length }));

            for (const m of markets) list.appendChild(marketSection(m, bySlot[m.slot] || [], bugged, collapsed));
        }

        // The display re-renders when the job board OR the switches/overrides
        // change — so a Master-Switches toggle or a Network-Map server skip is
        // reflected here immediately.
        const unsub = Store.local.onChanged((changes) => {
            let dirty = false;
            if (changes[SL.AJV2_JOB_QUEUE]) { lastQueue = changes[SL.AJV2_JOB_QUEUE].newValue; dirty = true; }
            if (changes[SL.AJV2_MASTER_SWITCHES]) { switches = changes[SL.AJV2_MASTER_SWITCHES].newValue || {}; dirty = true; }
            if (changes[SL.AJV2_SERVER_OVERRIDES]) { overrides = changes[SL.AJV2_SERVER_OVERRIDES].newValue || {}; dirty = true; }
            if (changes[SL.AJV2_BUGGED_JOBS]) { bugged = changes[SL.AJV2_BUGGED_JOBS].newValue || {}; dirty = true; }
            if (dirty) render();
        });
        Promise.all([
            Store.local.getOne(SL.AJV2_JOB_QUEUE, null),
            Store.local.getOne(SL.AJV2_MASTER_SWITCHES, {}),
            Store.local.getOne(SL.AJV2_SERVER_OVERRIDES, {}),
            Store.local.getOne(SL.AJV2_BUGGED_JOBS, {}),
        ]).then(([q, s, o, b]) => { lastQueue = q; switches = s || {}; overrides = o || {}; bugged = b || {}; render(); });

        return {
            destroy() {
                if (typeof unsub === 'function') unsub();
                container.innerHTML = '';
            },
            render,
        };
    }

    root.COR3.uiComponentsV2 = root.COR3.uiComponentsV2 || {};
    root.COR3.uiComponentsV2.jobList = { attach };
})();
