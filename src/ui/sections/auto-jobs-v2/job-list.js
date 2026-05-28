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

    function jobRow(job) {
        const skipped = job.eligible === false;
        const pending = job.eligible == null;

        const row = el('div', 'ajv2-job' + (skipped ? ' is-skip' : ''));

        const head = el('div', 'ajv2-job-head');
        const name = el('span', 'job-name', job.name || 'Unknown');
        head.appendChild(name);

        if (skipped) {
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

        if (skipped && job.skipReason) {
            row.appendChild(el('div', 'ajv2-skip-reason xs', 'SKIP: ' + job.skipReason));
        }
        return row;
    }

    // One market block: header (name + status + count) then its jobs.
    function marketSection(market, jobs) {
        const sec = el('div', 'ajv2-market' + (market.reachable === false ? ' is-unreachable' : ''));

        const head = el('div', 'ajv2-market-head');
        head.appendChild(el('span', 'ajv2-market-name', SLOT_LABEL[market.slot] || market.slot || '?'));
        if (market.reachable === false) {
            head.appendChild(el('span', 'pill warn', 'unreachable'));
        } else if (market.refreshed === false) {
            const stale = el('span', 'pill idle', 'stale');
            stale.title = 'Refresh timed out — showing the last-known board';
            head.appendChild(stale);
        }
        head.appendChild(el('span', 'muted xs ajv2-market-count', `${jobs.length} ${jobs.length === 1 ? 'job' : 'jobs'}`));
        sec.appendChild(head);

        if (!jobs.length) {
            const why = market.reachable === false ? (market.reason || 'unreachable') : 'No jobs.';
            sec.appendChild(el('div', 'muted xs ajv2-market-empty', why));
        } else {
            for (const job of jobs) sec.appendChild(jobRow(job));
        }
        return sec;
    }

    function attach(container) {
        container.classList.add('ajv2-jobs-host');
        container.innerHTML = '';

        const wrap = el('div', 'ajv2-jobs');
        const head = el('div', 'ajv2-jobs-head');
        head.appendChild(el('span', 'card-label', 'Jobs'));
        const summary = el('span', 'muted xs ajv2-jobs-summary', '—');
        head.appendChild(summary);
        wrap.appendChild(head);

        const list = el('div', 'ajv2-jobs-list');
        wrap.appendChild(list);
        container.appendChild(wrap);

        function render(queue) {
            list.innerHTML = '';

            if (!queue) {
                summary.textContent = 'pipeline not run yet';
                list.appendChild(el('div', 'muted xs ajv2-jobs-empty', 'Press START to run the pipeline.'));
                return;
            }

            const jobs = Array.isArray(queue.jobs) ? queue.jobs : [];
            const evaluated = jobs.filter((j) => j.eligible != null).length;
            const eligible = jobs.filter((j) => j.eligible === true).length;
            const skipped = jobs.filter((j) => j.eligible === false).length;
            const cyc = `cycle ${queue.cycle || '—'}`;
            summary.textContent = !jobs.length
                ? `0 jobs · ${cyc}`
                : evaluated
                    ? `${jobs.length} jobs · ${eligible} eligible · ${skipped} skip · ${cyc}`
                    : `${jobs.length} jobs · pending · ${cyc}`;

            // Group jobs by their market slot.
            const bySlot = {};
            for (const j of jobs) (bySlot[j.marketSlot] = bySlot[j.marketSlot] || []).push(j);

            // Render one section per market. Prefer the pipeline's market
            // summary (covers reachable-but-empty + unreachable markets in a
            // stable order); fall back to the slots present in the jobs.
            const markets = (Array.isArray(queue.markets) && queue.markets.length)
                ? queue.markets
                : Object.keys(bySlot).map((slot) => ({ slot, reachable: true, refreshed: true, jobCount: bySlot[slot].length }));

            for (const m of markets) list.appendChild(marketSection(m, bySlot[m.slot] || []));
        }

        const unsub = Store.local.onChanged((changes) => {
            if (changes[SL.AJV2_JOB_QUEUE]) render(changes[SL.AJV2_JOB_QUEUE].newValue);
        });
        Store.local.getOne(SL.AJV2_JOB_QUEUE, null).then(render);

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
