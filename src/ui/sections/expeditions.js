// src/ui/sections/expeditions.js
// Combined "everything about running expeditions" tab. Merges what used to
// be Stash + Mercs + Overview's expedition/decision blocks, plus the
// auto-choose-decision controls that lived in Settings.
//
// Layout:
//   • Active expeditions (timers + status pills)
//   • Pending decisions (interactive — click an option to send response)
//   • Auto-choose decision (toggle + risk threshold slider)
//   • Auto-send mercenary (toggle + auto-pick toggle + disabled reason)
//   • Mercenary roster (status, cost, risk, "pick" → autoSendMerc.mercenaryId)
//   • Stash (capacity bar + item list)

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
    function escape(s) {
        return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    function el(tag, cls, html) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (html !== undefined) e.innerHTML = html;
        return e;
    }
    async function getCor3Tab() {
        const [t] = await chrome.tabs.query({ url: ['https://cor3.gg/*', 'https://os.cor3.gg/*'] });
        return t || null;
    }
    async function sendToContent(action, extra = {}) {
        const tab = await getCor3Tab();
        if (!tab) return;
        chrome.tabs.sendMessage(tab.id, Object.assign({ action }, extra)).catch(() => {});
    }

    async function render(container) {
        clearTimers();
        container.innerHTML = '';

        const [exps, archived, decisions, mercs, mercConfigs, autoSend, stash, autoChooseEnabled, riskThreshold] = await Promise.all([
            Store.local.getOne(C.STORAGE_LOCAL.EXPEDITIONS, []),
            Store.local.getOne(C.STORAGE_LOCAL.ARCHIVED_EXPEDITIONS, []),
            Store.local.getOne(C.STORAGE_LOCAL.DECISIONS, []),
            Store.local.getOne(C.STORAGE_LOCAL.MERCENARIES),
            Store.local.getOne(C.STORAGE_LOCAL.MERC_CONFIG, {}),
            Store.sync.getOne(C.STORAGE_SYNC.AUTO_SEND_MERC, { enabled: false, autoChooseMerc: true }),
            Store.local.getOne(C.STORAGE_LOCAL.STASH),
            Store.sync.getOne(C.STORAGE_SYNC.AUTO_CHOOSE_ENABLED, false),
            Store.sync.getOne(C.STORAGE_SYNC.RISK_THRESHOLD, 5),
        ]);

        // ─── Active expeditions ───────────────────────────────────────
        const activeHeader = el('div', 'row between');
        activeHeader.appendChild(el('div', 'section-title', 'Active expeditions'));
        const activeRefresh = el('button', 'btn small', 'Refresh');
        activeRefresh.addEventListener('click', () => sendToContent('requestExpeditions'));
        activeHeader.appendChild(activeRefresh);
        container.appendChild(activeHeader);
        if (!exps || exps.length === 0) {
            container.appendChild(el('div', 'empty', 'No active expeditions.'));
        } else {
            for (const exp of exps) {
                const card = el('div', 'card');
                const head = el('div', 'card-row');
                head.appendChild(el('span', 'card-label',
                    `${exp.locationName || ''}${exp.zoneName ? ' · ' + exp.zoneName : ''}`));
                head.appendChild(el('span',
                    'pill ' + (exp.status === 'COMPLETED' ? 'ok' : 'active'),
                    exp.status || ''));
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

        // ─── Recent runs (archived) ───────────────────────────────────
        // Pulled via expeditions:get.archived. The list is paginated — we
        // show the most recent 8 entries with status/loot/cost. Refresh
        // button re-issues the WS request via runtime-bridge.
        const archivedHeader = el('div', 'row between mt-md');
        archivedHeader.appendChild(el('div', 'section-title', 'Recent runs'));
        const archivedRefresh = el('button', 'btn small', 'Refresh');
        archivedRefresh.addEventListener('click', () =>
            sendToContent('requestArchivedExpeditions'));
        archivedHeader.appendChild(archivedRefresh);
        container.appendChild(archivedHeader);

        const archList = Array.isArray(archived) ? archived : [];
        if (archList.length === 0) {
            container.appendChild(el('div', 'empty', 'No archived runs yet — click Refresh.'));
        } else {
            for (const run of archList.slice(0, 8)) {
                const status = run.status || run.outcome || '';
                const loc = run.locationName || run.location || '';
                const zone = run.zoneName || run.zone || '';
                const merc = run.mercenaryCallsign || run.mercenaryName || '';
                const card = el('div', 'card compact');
                const head = el('div', 'card-row');
                head.appendChild(el('span', 'card-label',
                    `${escape(loc)}${zone ? ' · ' + escape(zone) : ''}`));
                const pillCls = /complet|success|return|won/i.test(status) ? 'ok'
                    : /fail|lost|dead|killed/i.test(status) ? 'err'
                    : 'idle';
                head.appendChild(el('span', `pill ${pillCls}`, escape(status || '?')));
                card.appendChild(head);

                const meta = [];
                if (merc) meta.push(`👤 ${escape(merc)}`);
                if (run.totalCost != null) meta.push(`💸 ${run.totalCost}`);
                // cor3.gg shapes loot in many forms — handle the common ones.
                const loot = run.rewards || run.loot || run.payout;
                if (loot && typeof loot === 'object') {
                    if (loot.credits) meta.push(`💰 ${loot.credits}`);
                    if (loot.reputation) meta.push(`⭐ ${loot.reputation}`);
                    if (loot.renown) meta.push(`🏅 ${loot.renown}`);
                    if (Array.isArray(loot.items) && loot.items.length) meta.push(`📦 ${loot.items.length}`);
                }
                if (run.completedAt || run.endedAt) {
                    const ts = new Date(run.completedAt || run.endedAt);
                    if (!isNaN(ts.getTime())) meta.push(ts.toLocaleString());
                }
                if (meta.length) card.appendChild(el('div', 'muted xs mt-sm', meta.join(' · ')));
                container.appendChild(card);
            }
        }

        // ─── Pending decisions ────────────────────────────────────────
        const pending = (decisions || []).filter((d) => !d.isResolved);
        if (pending.length > 0) {
            container.appendChild(el('div', 'section-title', 'Pending decisions'));
            for (const d of pending) {
                const card = el('div', 'card');
                card.appendChild(el('div', 'sm',
                    `<strong>${escape(d.mercenaryCallsign || '?')}</strong> · ${escape(d.locationName || '')}`));
                if (d.content) card.appendChild(el('div', 'sm muted mt-sm', escape(d.content)));
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

        // ─── Auto-choose decision ─────────────────────────────────────
        container.appendChild(el('div', 'section-title', 'Auto-choose decision'));
        const ac = el('div', 'card');
        const threshold = Number(riskThreshold ?? 5);
        ac.innerHTML = `
            <div class="card-row">
                <span class="card-label">Enabled</span>
                <label class="switch"><input type="checkbox" id="ac-en" ${autoChooseEnabled ? 'checked' : ''}><span class="switch-slider"></span></label>
            </div>
            <div class="card-row mt-sm">
                <span class="card-label">Risk threshold</span>
                <span class="mono" id="rt-label">${threshold}</span>
            </div>
            <input type="range" id="rt-slider" min="0" max="10" step="1" value="${threshold}" class="mt-sm">
            <div class="muted xs mt-sm">0 = strong risk penalty · 10 = ignore risk</div>
        `;
        ac.querySelector('#ac-en').addEventListener('change', (e) =>
            Store.sync.setOne(C.STORAGE_SYNC.AUTO_CHOOSE_ENABLED, e.target.checked));
        const rtSlider = ac.querySelector('#rt-slider');
        const rtLabel = ac.querySelector('#rt-label');
        rtSlider.addEventListener('input', (e) => { rtLabel.textContent = e.target.value; });
        rtSlider.addEventListener('change', (e) =>
            Store.sync.setOne(C.STORAGE_SYNC.RISK_THRESHOLD, Number(e.target.value)));
        container.appendChild(ac);

        // ─── Auto-send mercenary ──────────────────────────────────────
        container.appendChild(el('div', 'section-title', 'Auto-send mercenary'));
        const ctrl = el('div', 'card');
        ctrl.innerHTML = `
            <div class="card-row">
                <span class="card-label">Enabled</span>
                <label class="switch"><input type="checkbox" data-k="enabled" ${autoSend && autoSend.enabled ? 'checked' : ''}><span class="switch-slider"></span></label>
            </div>
            <div class="card-row mt-sm">
                <span class="card-label">Auto-choose cheapest</span>
                <label class="switch"><input type="checkbox" data-k="autoChooseMerc" ${autoSend && autoSend.autoChooseMerc !== false ? 'checked' : ''}><span class="switch-slider"></span></label>
            </div>
            ${autoSend && autoSend.disabledReason
                ? `<div class="warn sm mt-sm">Disabled: ${escape(autoSend.disabledReason)}</div>` : ''}
        `;
        ctrl.querySelectorAll('input[data-k]').forEach((inp) => {
            inp.addEventListener('change', async (e) => {
                const cur = (await Store.sync.getOne(C.STORAGE_SYNC.AUTO_SEND_MERC, {})) || {};
                cur[e.target.dataset.k] = e.target.checked;
                if (e.target.dataset.k === 'enabled' && e.target.checked) cur.disabledReason = null;
                await Store.sync.setOne(C.STORAGE_SYNC.AUTO_SEND_MERC, cur);
            });
        });
        container.appendChild(ctrl);

        // ─── Mercenary roster ─────────────────────────────────────────
        container.appendChild(el('div', 'section-title', 'Mercenary roster'));
        const mercList = mercs && (Array.isArray(mercs) ? mercs : mercs.mercenaries) || [];
        if (mercList.length === 0) {
            container.appendChild(el('div', 'empty', 'No mercenary data yet.'));
        } else {
            for (const m of mercList) {
                const cfg = mercConfigs[m.id] || {};
                const isPicked = autoSend && autoSend.mercenaryId === m.id;
                const card = el('div', 'merc-card'
                    + (m.status !== 'AVAILABLE' ? ' unavail' : '')
                    + (isPicked ? ' selected' : ''));
                card.innerHTML = `
                    <div>
                        <div><strong>${escape(m.callsign || m.id)}</strong></div>
                        <div class="sm muted">${escape(m.status || '')}${cfg.totalCost ? ` · cost ${cfg.totalCost}` : ''}${cfg.riskScore != null ? ` · risk ${cfg.riskScore}` : ''}</div>
                    </div>
                    <button class="btn small">${isPicked ? 'Selected' : 'Pick'}</button>
                `;
                card.querySelector('button').addEventListener('click', async () => {
                    const cur = (await Store.sync.getOne(C.STORAGE_SYNC.AUTO_SEND_MERC, {})) || {};
                    cur.mercenaryId = m.id;
                    cur.mercenaryName = m.callsign || m.id;
                    await Store.sync.setOne(C.STORAGE_SYNC.AUTO_SEND_MERC, cur);
                });
                container.appendChild(card);
            }
        }

        // ─── Stash ────────────────────────────────────────────────────
        container.appendChild(el('div', 'section-title', 'Stash'));
        const stashCard = el('div', 'card');
        if (stash && stash.maxCapacity !== undefined) {
            const used = stash.currentUsage || 0;
            const max = stash.maxCapacity || 0;
            const pct = max > 0 ? Math.round((used / max) * 100) : 0;
            const pctCls = pct > 90 ? 'err' : pct > 70 ? 'warn' : 'ok';
            stashCard.innerHTML = `<div class="card-row"><span class="card-label">Capacity</span><span class="${pctCls}">${used} / ${max} (${pct}%)</span></div>`;
        } else {
            stashCard.innerHTML = '<div class="muted sm">No stash data.</div>';
        }
        const refresh = el('button', 'btn small mt-sm', 'Refresh');
        refresh.addEventListener('click', () => sendToContent('requestStash'));
        stashCard.appendChild(refresh);
        container.appendChild(stashCard);

        const items = (stash && Array.isArray(stash.items)) ? stash.items : [];
        if (items.length > 0) {
            container.appendChild(el('div', 'section-title', `Items (${items.length})`));
            for (const item of items) {
                const c = el('div', 'card compact');
                c.innerHTML = `<div class="card-row"><span>${escape(item.name || item.itemName || '?')}</span><span class="sm muted">x${item.quantity || 1}</span></div>`;
                container.appendChild(c);
            }
        }
    }

    root.COR3.ui.expeditions = {
        // Subscribe-only mount; render runs from activate() to avoid the dup-render
        // race (see overview.js for the same pattern).
        mount(container) {
            unsubs.push(Store.local.onChanged((changes) => {
                if (!container.classList.contains('active')) return;
                if (changes[C.STORAGE_LOCAL.EXPEDITIONS] || changes[C.STORAGE_LOCAL.DECISIONS]
                    || changes[C.STORAGE_LOCAL.ARCHIVED_EXPEDITIONS]
                    || changes[C.STORAGE_LOCAL.MERCENARIES] || changes[C.STORAGE_LOCAL.MERC_CONFIG]
                    || changes[C.STORAGE_LOCAL.STASH]) {
                    render(container);
                }
            }));
            unsubs.push(Store.sync.onChanged((changes) => {
                if (!container.classList.contains('active')) return;
                if (changes[C.STORAGE_SYNC.AUTO_SEND_MERC]
                    || changes[C.STORAGE_SYNC.AUTO_CHOOSE_ENABLED]
                    || changes[C.STORAGE_SYNC.RISK_THRESHOLD]) {
                    render(container);
                }
            }));
        },
        activate(container) { render(container); },
        deactivate() { clearTimers(); },
    };
})();
