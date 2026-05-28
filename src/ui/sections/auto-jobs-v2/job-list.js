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

        const metaBits = [];
        if (job.type) metaBits.push(job.type);
        metaBits.push(job.serverName || 'no server');
        metaBits.push(SLOT_LABEL[job.marketSlot] || job.marketSlot || '?');
        if (Number.isFinite(job.rewardCredits)) metaBits.push(job.rewardCredits + ' CR');
        row.appendChild(el('div', 'job-meta', metaBits.join(' · ')));

        if (skipped && job.skipReason) {
            row.appendChild(el('div', 'ajv2-skip-reason xs', 'SKIP: ' + job.skipReason));
        }
        return row;
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
            const jobs = (queue && Array.isArray(queue.jobs)) ? queue.jobs : [];

            if (!jobs.length) {
                summary.textContent = queue ? `0 jobs · cycle ${queue.cycle || '—'}` : 'pipeline not run yet';
                list.appendChild(el('div', 'muted xs ajv2-jobs-empty', queue ? 'No jobs on the board this cycle.' : 'Press START to run the pipeline.'));
                return;
            }

            const evaluated = jobs.filter((j) => j.eligible != null).length;
            const eligible = jobs.filter((j) => j.eligible === true).length;
            const skipped = jobs.filter((j) => j.eligible === false).length;
            summary.textContent = evaluated
                ? `${jobs.length} jobs · ${eligible} eligible · ${skipped} skip · cycle ${queue.cycle || '—'}`
                : `${jobs.length} jobs · pending · cycle ${queue.cycle || '—'}`;

            for (const job of jobs) list.appendChild(jobRow(job));
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
