// Auto Jobs — Job List.
//
// Sits between the Network Map and the Flow Map. Renders the job board the
// pipeline produced (MODULE:JOB_QUEUE), with the detail of each job and a
// SKIP flag (+ reason) for jobs that CHECK_JOBS_CONDITION ruled out.
//
// Pure read of the Auto-Jobs-owned AJ_JOB_QUEUE key — written by the pipeline,
// never by this component. Shape:
//   { cycle, computedAt, jobs: [{ id, name, type, serverName, marketSlot,
//     marketId, rewardCredits, eligible, skipReason }] }
// `eligible` is null until CHECK_JOBS_CONDITION runs, then a bool.
//
// Also reads AJ_PIPELINE_STATE.batch (the live JOB_FLOW batch:
//   { label, serverId, serverName, jobIds, total, index, currentJobId, oneLogin })
// to render a "running N jobs in one batch on <server>" banner and light up the
// rows being executed together — so the user sees the per-server batching live.
//
// Exposes attach() on COR3.uiComponents.jobList.

(function () {
    const root = window;
    if (!root.COR3 || !root.COR3.constants) return;
    const { Store, constants: C } = root.COR3;
    const SL = C.STORAGE_LOCAL;
    const t = (k, vars) => root.COR3.i18n.t(k, vars);

    // Friendly market-slot label (home/dark/srm/usol) — falls back to the raw slot
    // for any unexpected slot key.
    function marketLabel(slot) {
        const k = 'autojobs.market.' + slot;
        const lbl = t(k);
        return lbl === k ? (slot || '?') : lbl;
    }

    // Friendly job-type label — localised when the type is a known FLOW value,
    // else the raw snake_case type rendered with spaces (covers 'unrecognised').
    function jobTypeLabel(type) {
        if (!type) return type;
        const k = 'autojobs.jobType.' + type;
        const lbl = t(k);
        return lbl === k ? String(type).replace(/_/g, ' ') : lbl;
    }

    function el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text !== undefined) e.textContent = text;
        return e;
    }

    // Stable signature of a live-batch descriptor — used to skip re-renders on
    // pipeline-state writes that don't change the batch (most node transitions).
    function batchSig(b) {
        return b ? `${b.serverId}|${b.currentJobId}|${b.index}|${b.total}|${(b.jobIds || []).join(',')}` : '';
    }

    // Remove a job from the bugged registry. The Job List subscribes to the
    // key, so the BUGGED flag clears the instant this resolves.
    async function unbugJob(jobId) {
        const reg = (await Store.local.getOne(C.STORAGE_LOCAL.AJ_BUGGED_JOBS, {})) || {};
        if (reg[jobId]) {
            delete reg[jobId];
            await Store.local.setOne(C.STORAGE_LOCAL.AJ_BUGGED_JOBS, reg);
        }
    }

    function jobRow(job, bugInfo, batch, opts) {
        const isBugged = !!bugInfo;
        // FAILED (from the market's recentJobs) — a terminal state the game won't
        // clear on its own; surfaced here with a ✕ to dismiss it.
        const isFailed = !isBugged && job.status === 'FAILED';
        const inProgress = !isBugged && !isFailed && job.status === 'TAKEN';
        const skipped = !isBugged && !isFailed && !inProgress && job.eligible === false;
        const pending = !isBugged && !isFailed && !inProgress && job.eligible == null;
        // Live-batch membership (from AJ_PIPELINE_STATE.batch): these TAKEN
        // jobs are being run together this cycle; one is dispatching right now.
        const inBatch = !!(batch && Array.isArray(batch.jobIds) && batch.jobIds.indexOf(job.id) !== -1);
        const isRunning = !!(batch && batch.currentJobId === job.id);

        const row = el('div', 'aj-job'
            + (skipped ? ' is-skip' : '')
            + (inProgress ? ' is-active' : '')
            + (inBatch ? ' is-batch' : '')
            + (isRunning ? ' is-running' : '')
            + (isFailed ? ' is-failed' : '')
            + (isBugged ? ' is-bugged' : ''));

        const head = el('div', 'aj-job-head');
        head.appendChild(el('span', 'job-name', job.name || t('autojobs.jobUnknown')));

        // Server · CR moved up here as thin secondary text (was the duplicated
        // second meta line). Built from whatever the job carries — file_decryption
        // jobs have no server, so the server bit is simply omitted.
        const locBits = [];
        if (job.serverName) locBits.push(job.serverName);
        if (Number.isFinite(job.rewardCredits)) locBits.push(t('autojobs.rewardCr', { n: job.rewardCredits }));
        if (locBits.length) head.appendChild(el('span', 'aj-job-loc muted xs', locBits.join(' · ')));

        // 🔍 Locate — highlight + centre this job's server on the Network Map.
        // Only meaningful when the job is wired to a server.
        if (job.serverName) {
            const locate = el('button', 'aj-job-icon aj-locate', '🔍');
            locate.title = t('autojobs.locateTip');
            locate.addEventListener('click', (e) => {
                e.stopPropagation();
                const nm = root.COR3.uiComponents && root.COR3.uiComponents.networkMap;
                if (nm && typeof nm.focusServer === 'function') nm.focusServer(job.serverName);
            });
            head.appendChild(locate);
        }

        // ⋯ Details — toggle a panel listing every field the job carries.
        const detailsBtn = el('button', 'aj-job-icon aj-details', '⋯');
        detailsBtn.title = t('autojobs.detailsTip');
        head.appendChild(detailsBtn);

        if (isBugged) {
            head.appendChild(el('span', 'pill aj-bugged', t('autojobs.pillBugged')));
            const unbug = el('button', 'aj-unbug', '✕');
            unbug.title = t('autojobs.removeFromBugged');
            unbug.addEventListener('click', (e) => { e.stopPropagation(); unbugJob(job.id); });
            head.appendChild(unbug);
        } else if (isFailed) {
            head.appendChild(el('span', 'pill aj-failed', t('autojobs.pillFailed')));
            const running = !!(opts && opts.running);
            const dismiss = el('button', 'aj-unbug aj-dismiss', '✕');
            dismiss.disabled = running;
            dismiss.title = running
                ? t('autojobs.dismissBlockedTip')
                : t('autojobs.dismissTip');
            dismiss.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!running && opts && typeof opts.onDismiss === 'function') opts.onDismiss(job);
            });
            head.appendChild(dismiss);
        } else if (inProgress) {
            if (isRunning) {
                head.appendChild(el('span', 'pill aj-batch-run', t('autojobs.pillRunning', { index: batch.index, total: batch.total })));
            } else {
                head.appendChild(el('span', 'pill ok', t('autojobs.pillInProgress')));
                if (inBatch) head.appendChild(el('span', 'pill aj-batch', t('autojobs.pillBatch')));
            }
        } else if (skipped) {
            const skip = el('span', 'pill aj-skip', t('autojobs.jobSkip'));
            if (job.skipReason) skip.title = job.skipReason;
            head.appendChild(skip);
        } else if (pending) {
            head.appendChild(el('span', 'pill idle', t('autojobs.pillPending')));
        } else {
            head.appendChild(el('span', 'pill ok', t('autojobs.pillEligible')));
        }
        row.appendChild(head);

        // Server · CR + market now live in the head / section header, and the
        // job-type label duplicated the name, so the second meta line is gone.

        if (isBugged && bugInfo.reason) {
            row.appendChild(el('div', 'aj-skip-reason xs', t('autojobs.buggedPrefix', { reason: bugInfo.reason })));
        } else if (skipped && job.skipReason) {
            row.appendChild(el('div', 'aj-skip-reason xs', t('autojobs.skipPrefix', { reason: job.skipReason })));
        }

        // ⋯ Details panel — every field the job carries (type localised, the
        // rest raw), built lazily on first toggle. Skip-reason / node-name style
        // values intentionally stay raw English (matches the debug bundle).
        const details = el('div', 'aj-job-details collapsed');
        details.appendChild(detailRow(t('autojobs.detailsTitle'), '', true));
        details.appendChild(detailRow('type', jobTypeLabel(job.type) || '—'));
        for (const key of Object.keys(job)) {
            if (key === 'type') continue;
            details.appendChild(detailRow(key, fmtVal(job[key])));
        }
        if (bugInfo && bugInfo.reason) details.appendChild(detailRow('buggedReason', String(bugInfo.reason)));
        row.appendChild(details);
        detailsBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const open = details.classList.toggle('collapsed') === false;
            detailsBtn.classList.toggle('is-open', open);
            detailsBtn.title = open ? t('autojobs.detailsHideTip') : t('autojobs.detailsTip');
        });

        return row;
    }

    // Render one key/value line for the details panel. `heading` makes it a bold
    // title row (no value column).
    function detailRow(key, value, heading) {
        const r = el('div', 'aj-detail' + (heading ? ' aj-detail-title' : ''));
        r.appendChild(el('span', 'aj-detail-k', key));
        if (!heading) r.appendChild(el('span', 'aj-detail-v', value));
        return r;
    }

    // Stringify a job field for display: null/undefined → em-dash, objects →
    // compact JSON, everything else → its String form.
    function fmtVal(v) {
        if (v === null || v === undefined) return '—';
        if (typeof v === 'object') { try { return JSON.stringify(v); } catch (_) { return String(v); } }
        return String(v);
    }

    // One market block: a clickable header (caret + name + status + count) and a
    // collapsible body of its jobs. `collapsed` is a shared Set of slot keys, so
    // the expand/collapse state survives the component's frequent re-renders.
    function marketSection(market, jobs, bugged, collapsed, batch, opts) {
        const slot = market.slot;
        const isCollapsed = collapsed.has(slot);
        const sec = el('div', 'aj-market' + (market.reachable === false ? ' is-unreachable' : ''));

        const head = el('div', 'aj-market-head');
        const caret = el('span', 'aj-market-caret', isCollapsed ? '▸' : '▾');
        head.appendChild(caret);
        head.appendChild(el('span', 'aj-market-name', marketLabel(slot)));
        if (market.reachable === false) {
            head.appendChild(el('span', 'pill warn', t('autojobs.unreachable')));
        } else if (market.refreshed === false) {
            const stale = el('span', 'pill idle', t('autojobs.stale'));
            stale.title = t('autojobs.staleTip');
            head.appendChild(stale);
        }
        head.appendChild(el('span', 'muted xs aj-market-count',
            jobs.length === 1 ? t('autojobs.oneJob') : t('autojobs.nJobs', { n: jobs.length })));
        sec.appendChild(head);

        const bodyWrap = el('div', 'aj-market-jobs' + (isCollapsed ? ' collapsed' : ''));
        if (!jobs.length) {
            const why = market.reachable === false ? (market.reason || t('autojobs.unreachable')) : t('autojobs.marketNoJobs');
            bodyWrap.appendChild(el('div', 'muted xs aj-market-empty', why));
        } else {
            for (const job of jobs) bodyWrap.appendChild(jobRow(job, bugged && bugged[job.id], batch, opts));
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
        if (tab) { try { await chrome.tabs.sendMessage(tab.id, { action: C.MSG.AUTOJOBS.REFRESH_BOARD }); } catch (_) { /* tab not ready */ } }
    }

    // Ask the orchestrator to dismiss one FAILED job now (market.job.dismiss).
    // Refused orchestrator-side while the loop runs. No-op when no game tab open.
    async function sendDismissFailed(jobId, marketId) {
        if (!(typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.query)) return;
        const tabs = await chrome.tabs.query({ url: ['https://cor3.gg/*', 'https://os.cor3.gg/*'] });
        const tab = tabs && tabs[0];
        if (tab) { try { await chrome.tabs.sendMessage(tab.id, { action: C.MSG.AUTOJOBS.DISMISS_FAILED, jobId, marketId }); } catch (_) { /* tab not ready */ } }
    }

    function attach(container) {
        container.classList.add('aj-jobs-host');
        container.innerHTML = '';

        // Latest of each input; render() combines them all.
        let lastQueue = null;
        let switches = {};
        let overrides = {};
        let bugged = {};
        let batch = null;   // AJ_PIPELINE_STATE.batch — the live JOB_FLOW batch
        let running = false; // AJ_PIPELINE_STATE.running — gates the manual ✕

        // Expand/collapse state per market slot — survives the frequent
        // re-renders (lives in this closure; resets when the popup reopens).
        const collapsed = new Set();

        // Optimistically-dismissed FAILED job ids: hide the row the instant the
        // user clicks ✕ (the dismiss WS round-trip + board rebuild lag a beat).
        // Cleared whenever a fresh board arrives, so a dismiss that didn't take
        // re-shows on the next rebuild rather than vanishing forever.
        const dismissedIds = new Set();
        function onDismiss(job) {
            if (!job || !job.marketId) return;
            dismissedIds.add(job.id);
            sendDismissFailed(job.id, job.marketId);
            render();
        }

        const wrap = el('div', 'aj-jobs');
        const head = el('div', 'aj-jobs-head');
        head.appendChild(el('span', 'card-label', t('autojobs.jobs')));
        const right = el('div', 'aj-jobs-head-right');
        const summary = el('span', 'muted xs aj-jobs-summary', '—');
        right.appendChild(summary);
        const refreshBtn = el('button', 'nm-hud-btn aj-jobs-refresh', '↻');
        refreshBtn.title = t('autojobs.jobsRefreshTip');
        refreshBtn.addEventListener('click', async () => {
            refreshBtn.disabled = true;
            refreshBtn.textContent = '…';
            try { await requestBoardRefresh(); } catch (_) { /* noop */ }
            // The rebuilt board arrives via the AJ_JOB_QUEUE onChanged below
            // (which re-renders); just restore the button after a moment.
            setTimeout(() => { refreshBtn.disabled = false; refreshBtn.textContent = '↻'; }, 1200);
        });
        right.appendChild(refreshBtn);
        head.appendChild(right);
        wrap.appendChild(head);

        const list = el('div', 'aj-jobs-list');
        wrap.appendChild(list);
        container.appendChild(wrap);

        function render() {
            list.innerHTML = '';

            const queue = lastQueue;
            if (!queue) {
                summary.textContent = t('autojobs.pipelineNotRun');
                list.appendChild(el('div', 'muted xs aj-jobs-empty', t('autojobs.pressStart')));
                return;
            }

            // Hide rows the user just dismissed with ✕ (optimistic removal).
            const jobs = (Array.isArray(queue.jobs) ? queue.jobs : []).filter((j) => !dismissedIds.has(j.id));

            // Live eligibility: derive display rows from the pipeline's DATA
            // verdict (job.dataSkipReason) + the CONFIG verdict re-derived NOW
            // from the current switches/overrides (shared evaluator), so SKIP
            // flags track a toggle instantly without waiting for the next cycle.
            // Derive into NEW objects — never mutate lastQueue.jobs (the cached
            // storage value), which other readers treat as authoritative.
            const evalConfig = root.COR3.ajEligibility && root.COR3.ajEligibility.configSkipReason;
            const rows = jobs.map((job) => {
                // Eligibility only applies to AVAILABLE board jobs; TAKEN /
                // FAILED rows pass through untouched (eligible:null), matching
                // CHECK_JOBS_CONDITION which skips non-AVAILABLE jobs.
                if (!evalConfig || job.status !== 'AVAILABLE') return job;
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
            // (TAKEN), failed (FAILED) and bugged jobs are reported separately.
            // Bugged jobs are excluded from `skipped`/`failed` so they are not
            // tallied under two buckets at once.
            const avail = rows.filter((j) => j.status === 'AVAILABLE');
            const inProgress = rows.filter((j) => j.status === 'TAKEN').length;
            const failedN = rows.filter((j) => j.status === 'FAILED' && !bugged[j.id]).length;
            const evaluated = avail.filter((j) => j.eligible != null).length;
            const eligible = avail.filter((j) => j.eligible === true).length;
            const skipped = avail.filter((j) => j.eligible === false && !bugged[j.id]).length;
            const buggedN = rows.filter((j) => bugged[j.id]).length;
            const active = inProgress ? ' · ' + t('autojobs.sumInProgress', { n: inProgress }) : '';
            const failedSuffix = failedN ? ' · ' + t('autojobs.sumFailedN', { n: failedN }) : '';
            const buggedSuffix = buggedN ? ' · ' + t('autojobs.sumBuggedN', { n: buggedN }) : '';
            const cyc = t('autojobs.cycleN', { n: queue.cycle || '—' });
            summary.textContent = !jobs.length
                ? `${t('autojobs.sumZeroJobs')} · ${cyc}`
                : evaluated
                    ? `${t('autojobs.sumAvailable', { n: avail.length })} · ${t('autojobs.sumEligible', { n: eligible })} · ${t('autojobs.sumSkip', { n: skipped })}${active}${failedSuffix}${buggedSuffix} · ${cyc}`
                    : `${t('autojobs.sumAvailable', { n: avail.length })}${active}${failedSuffix}${buggedSuffix} · ${t('autojobs.sumPending')} · ${cyc}`;

            // Live-batch banner — only while JOB_FLOW is actively running a
            // batch (the orchestrator clears AJ_PIPELINE_STATE.batch at cycle
            // start / on STOP). Shows the server + "one login" for SAI batches.
            if (batch && batch.total) {
                const banner = el('div', 'aj-batch-banner');
                banner.appendChild(el('span', 'aj-batch-dot'));
                const server = batch.serverName || t('autojobs.serverFallback');
                const text = batch.serverId
                    ? (batch.total === 1
                        ? t('autojobs.batchOnOne', { server })
                        : t('autojobs.batchOnMany', { n: batch.total, server }))
                    : t('autojobs.runningLabel', { label: batch.label || t('autojobs.jobFallback') });
                banner.appendChild(el('span', 'aj-batch-text', text));
                const metaBits = [];
                if (batch.oneLogin) metaBits.push(t('autojobs.oneLogin'));
                if (batch.index) metaBits.push(`${batch.index}/${batch.total}`);
                if (metaBits.length) banner.appendChild(el('span', 'aj-batch-meta', metaBits.join(' · ')));
                list.appendChild(banner);
            }

            // Group the derived rows by their market slot.
            const bySlot = {};
            for (const j of rows) (bySlot[j.marketSlot] = bySlot[j.marketSlot] || []).push(j);

            // Render one section per market. Prefer the pipeline's market
            // summary (covers reachable-but-empty + unreachable markets in a
            // stable order); fall back to the slots present in the jobs.
            const markets = (Array.isArray(queue.markets) && queue.markets.length)
                ? queue.markets
                : Object.keys(bySlot).map((slot) => ({ slot, reachable: true, refreshed: true, jobCount: bySlot[slot].length }));

            const opts = { running, onDismiss };
            for (const m of markets) list.appendChild(marketSection(m, bySlot[m.slot] || [], bugged, collapsed, batch, opts));
        }

        // The display re-renders when the job board OR the switches/overrides
        // change — so a Master-Switches toggle or a Network-Map server skip is
        // reflected here immediately.
        const unsub = Store.local.onChanged((changes) => {
            let dirty = false;
            if (changes[SL.AJ_JOB_QUEUE]) {
                lastQueue = changes[SL.AJ_JOB_QUEUE].newValue;
                // A fresh board reflects reality — drop the optimistic-dismiss
                // veil so any FAILED job that wasn't actually cleared re-appears.
                dismissedIds.clear();
                dirty = true;
            }
            if (changes[SL.AJ_MASTER_SWITCHES]) { switches = changes[SL.AJ_MASTER_SWITCHES].newValue || {}; dirty = true; }
            if (changes[SL.AJ_SERVER_OVERRIDES]) { overrides = changes[SL.AJ_SERVER_OVERRIDES].newValue || {}; dirty = true; }
            if (changes[SL.AJ_BUGGED_JOBS]) { bugged = changes[SL.AJ_BUGGED_JOBS].newValue || {}; dirty = true; }
            // The live batch + running flag ride on the pipeline state (written
            // every node transition); pull just `batch` and `running`. Re-render
            // ONLY when the batch identity/progress or running state actually
            // changes — the state is written on every node transition, but these
            // fields change far less often, so the gate avoids a re-render storm.
            if (changes[SL.AJ_PIPELINE_STATE]) {
                const ps = changes[SL.AJ_PIPELINE_STATE].newValue || {};
                const nb = ps.batch || null;
                if (batchSig(nb) !== batchSig(batch)) { batch = nb; dirty = true; }
                if (!!ps.running !== running) { running = !!ps.running; dirty = true; }
            }
            if (dirty) render();
        });
        Promise.all([
            Store.local.getOne(SL.AJ_JOB_QUEUE, null),
            Store.local.getOne(SL.AJ_MASTER_SWITCHES, {}),
            Store.local.getOne(SL.AJ_SERVER_OVERRIDES, {}),
            Store.local.getOne(SL.AJ_BUGGED_JOBS, {}),
            Store.local.getOne(SL.AJ_PIPELINE_STATE, null),
        ]).then(([q, s, o, b, ps]) => { lastQueue = q; switches = s || {}; overrides = o || {}; bugged = b || {}; batch = (ps || {}).batch || null; running = !!((ps || {}).running); render(); });

        return {
            destroy() {
                if (typeof unsub === 'function') unsub();
                container.innerHTML = '';
            },
            render,
        };
    }

    root.COR3.uiComponents = root.COR3.uiComponents || {};
    root.COR3.uiComponents.jobList = { attach };
})();
