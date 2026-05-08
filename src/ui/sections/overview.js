// src/ui/sections/overview.js
// Daily Ops + Markets + Active Expedition + Decisions

(function () {
    const root = window;
    root.COR3.ui = root.COR3.ui || {};
    const { Store, constants: C, uiComponents } = root.COR3;

    let unsubs = [];
    let timerInstances = [];

    function clearTimers() {
        for (const t of timerInstances) try { t.stop(); } catch (_) {}
        timerInstances = [];
    }

    function el(tag, cls, html) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (html !== undefined) e.innerHTML = html;
        return e;
    }

    async function render(container) {
        clearTimers();
        container.innerHTML = '';

        const [daily, market, dark, darkAvail, exps, decisions, web, sys] = await Promise.all([
            Store.local.getOne(C.STORAGE_LOCAL.DAILY_OPS),
            Store.local.getOne(C.STORAGE_LOCAL.MARKET),
            Store.local.getOne(C.STORAGE_LOCAL.DARK_MARKET),
            Store.local.getOne(C.STORAGE_LOCAL.DARK_MARKET_AVAILABLE, true),
            Store.local.getOne(C.STORAGE_LOCAL.EXPEDITIONS, []),
            Store.local.getOne(C.STORAGE_LOCAL.DECISIONS, []),
            Store.local.getOne(C.STORAGE_LOCAL.WEB_VERSION, '?'),
            Store.local.getOne(C.STORAGE_LOCAL.SYSTEM_VERSION, '?'),
        ]);

        // ─── Daily Ops ────────────────────────────────────────────────
        container.appendChild(el('div', 'section-title', 'Daily Ops'));
        const dailyCard = el('div', 'card');
        if (daily && daily.nextTaskTime) {
            const t = uiComponents.timer.create(daily.nextTaskTime);
            timerInstances.push(t);
            const row = el('div', 'card-row');
            row.appendChild(el('span', 'card-label', `Next reset · streak ${daily.streak || 0}`));
            row.appendChild(t.el);
            dailyCard.appendChild(row);
        } else {
            dailyCard.innerHTML = '<div class="muted sm">No daily ops data yet.</div>';
        }
        const refreshBtn = el('button', 'btn small mt-sm', 'Refresh');
        refreshBtn.addEventListener('click', () => sendToContent('fetchDailyOps'));
        dailyCard.appendChild(refreshBtn);
        container.appendChild(dailyCard);

        // ─── Markets ──────────────────────────────────────────────────
        container.appendChild(el('div', 'section-title', 'Markets'));

        function marketCard(label, data, available, isDark) {
            const card = el('div', 'card');
            const head = el('div', 'card-row');
            head.appendChild(el('span', 'card-label', `${label}${(isDark && available === false) ? ' · unreachable' : ''}`));
            if (data && data.nextJobsResetAt && (!isDark || available !== false)) {
                const t = uiComponents.timer.create(data.nextJobsResetAt);
                timerInstances.push(t);
                head.appendChild(t.el);
            } else {
                head.appendChild(el('span', 'muted sm', '—'));
            }
            card.appendChild(head);

            const jobs = (data && Array.isArray(data.jobs)) ? data.jobs : [];
            const meta = el('div', 'sm muted mt-sm', `${jobs.length} job(s) on the board`);
            card.appendChild(meta);

            const btnRow = el('div', 'row gap-sm mt-sm');
            const refresh = el('button', 'btn small', 'Refresh');
            refresh.addEventListener('click', () => sendToContent(isDark ? 'refreshDarkMarket' : 'refreshMarket'));
            btnRow.appendChild(refresh);
            card.appendChild(btnRow);
            return card;
        }
        container.appendChild(marketCard('Home Market', market, true, false));
        container.appendChild(marketCard('Dark Market', dark, darkAvail, true));

        // ─── Active expedition + decisions ────────────────────────────
        container.appendChild(el('div', 'section-title', 'Expeditions'));
        if (!exps || exps.length === 0) {
            container.appendChild(el('div', 'empty', 'No active expeditions.'));
        } else {
            for (const exp of exps) {
                const card = el('div', 'card');
                const head = el('div', 'card-row');
                head.appendChild(el('span', 'card-label', `${exp.locationName || ''}${exp.zoneName ? ' · ' + exp.zoneName : ''}`));
                head.appendChild(el('span', 'pill ' + (exp.status === 'COMPLETED' ? 'ok' : 'active'), exp.status || ''));
                card.appendChild(head);
                if (exp.endTime) {
                    const tRow = el('div', 'card-row mt-sm');
                    tRow.appendChild(el('span', 'sm muted', 'ETA'));
                    const t = uiComponents.timer.create(exp.endTime);
                    timerInstances.push(t);
                    tRow.appendChild(t.el);
                    card.appendChild(tRow);
                }
                container.appendChild(card);
            }
        }

        // Decisions
        const pending = (decisions || []).filter((d) => !d.isResolved);
        if (pending.length > 0) {
            container.appendChild(el('div', 'section-title', 'Pending decisions'));
            for (const d of pending) {
                const card = el('div', 'card');
                card.appendChild(el('div', 'sm', `<strong>${d.mercenaryCallsign || '?'}</strong> · ${d.locationName || ''}`));
                card.appendChild(el('div', 'sm muted mt-sm', d.content || ''));
                if (d.decisionDeadline) {
                    const tRow = el('div', 'card-row mt-sm');
                    tRow.appendChild(el('span', 'sm muted', 'Decide in'));
                    const t = uiComponents.timer.create(d.decisionDeadline);
                    timerInstances.push(t);
                    tRow.appendChild(t.el);
                    card.appendChild(tRow);
                }
                if (Array.isArray(d.decisionOptions)) {
                    for (const opt of d.decisionOptions) {
                        const btn = el('button', 'btn small mt-sm btn-block', escape(opt.label || opt.id));
                        btn.addEventListener('click', () => sendToContent('respondDecision', {
                            expeditionId: d.expeditionId, messageId: d.messageId, selectedOption: opt.id,
                        }));
                        card.appendChild(btn);
                    }
                }
                container.appendChild(card);
            }
        }

        // ─── Versions footer ──────────────────────────────────────────
        const ver = el('div', 'muted xs mt-md', `web: ${web} · system: ${sys}`);
        container.appendChild(ver);
    }

    function escape(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

    async function sendToContent(action, extra = {}) {
        const tab = await getCor3Tab();
        if (!tab) return;
        chrome.tabs.sendMessage(tab.id, Object.assign({ action }, extra)).catch(() => {});
    }
    async function getCor3Tab() {
        const [t] = await chrome.tabs.query({ url: ['https://cor3.gg/*', 'https://os.cor3.gg/*'] });
        return t || null;
    }

    root.COR3.ui.overview = {
        mount(container) {
            // re-render on relevant storage changes
            unsubs.push(Store.local.onChanged((changes) => {
                if (changes[C.STORAGE_LOCAL.DAILY_OPS] || changes[C.STORAGE_LOCAL.MARKET] ||
                    changes[C.STORAGE_LOCAL.DARK_MARKET] || changes[C.STORAGE_LOCAL.EXPEDITIONS] ||
                    changes[C.STORAGE_LOCAL.DECISIONS]) {
                    if (container.classList.contains('active')) render(container);
                }
            }));
            render(container);
        },
        activate(container) { render(container); },
        deactivate() { clearTimers(); },
    };
})();
