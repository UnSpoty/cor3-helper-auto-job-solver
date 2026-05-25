// src/ui/sections/expeditions.js
// Combined "everything about running expeditions" tab. Merges what used to
// be Stash + Mercs + Overview's expedition/decision blocks, plus the
// auto-choose-decision controls that lived in Settings.
//
// Layout:
//   • Active expeditions (timers + status pills)
//   • Recent runs (archived list — paginated to 8 entries)
//   • Pending decisions (interactive — click an option to send response)
//   • Auto-choose decision (toggle + risk threshold slider)
//   • Auto-send mercenary (toggle + auto-pick toggle + disabled reason)
//   • Mercenary roster (status, cost, risk, "pick" → autoSendMerc.mercenaryId)
//   • Stash (capacity bar + item list)
//
// Render architecture: the DOM skeleton is built ONCE per activate(); each
// chrome.storage key drives the narrowest refresh that depends on it.
// List sections use replaceChildren (atomic) instead of innerHTML='' +
// appendChild (which paints an empty intermediate state). See
// overview.js / auto-jobs.js for the same pattern.

(function () {
    const root = window;
    root.COR3.ui = root.COR3.ui || {};
    const { Store, constants: C, uiComponents } = root.COR3;

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

    // ─── Panel state ──────────────────────────────────────────────────────
    let panel = null;

    function tearDown() {
        if (!panel) return;
        for (const tm of panel.timers) try { tm.stop(); } catch (_) {}
        panel = null;
    }

    // Each list section owns its own timer instances — when the list is
    // replaced, we stop just those, not the entire panel's pool. Keeps
    // `panel.timers` accurate without forcing per-card tracking.
    function dropSectionTimers(section) {
        for (const tm of section.timers) {
            try { tm.stop(); } catch (_) {}
            const i = panel.timers.indexOf(tm);
            if (i !== -1) panel.timers.splice(i, 1);
        }
        section.timers = [];
    }
    function adoptTimer(section, inst) {
        section.timers.push(inst);
        panel.timers.push(inst);
    }

    // ─── Build (one-time skeleton) ────────────────────────────────────────
    function build(container) {
        tearDown();
        container.innerHTML = '';

        panel = {
            container,
            timers: [],
            active:    { titleRow: null, listHost: null, timers: [] },
            archived:  { titleRow: null, listHost: null, timers: [] },
            pending:   { title: null,    listHost: null, timers: [] },
            autoChoose:{ enabledInput: null, sliderInput: null, label: null },
            autoSend:  { enabledInput: null, autoChooseMercInput: null, warning: null },
            mercList:  { titleRow: null, listHost: null },
            stash:     { card: null, capacityText: null, refreshBtn: null,
                         itemsTitle: null, itemsHost: null },
        };

        // ─── Active expeditions ───────────────────────────────────────
        const activeHeader = el('div', 'row between');
        activeHeader.appendChild(el('div', 'section-title', 'Active expeditions'));
        const activeRefresh = el('button', 'btn small', 'Refresh');
        activeRefresh.addEventListener('click', () => sendToContent('requestExpeditions'));
        activeHeader.appendChild(activeRefresh);
        container.appendChild(activeHeader);

        const activeListHost = el('div');
        container.appendChild(activeListHost);
        panel.active.listHost = activeListHost;

        // ─── Recent runs ──────────────────────────────────────────────
        const archivedHeader = el('div', 'row between mt-md');
        archivedHeader.appendChild(el('div', 'section-title', 'Recent runs'));
        const archivedRefresh = el('button', 'btn small', 'Refresh');
        archivedRefresh.addEventListener('click', () => sendToContent('requestArchivedExpeditions'));
        archivedHeader.appendChild(archivedRefresh);
        container.appendChild(archivedHeader);

        const archivedListHost = el('div');
        container.appendChild(archivedListHost);
        panel.archived.listHost = archivedListHost;

        // ─── Pending decisions ────────────────────────────────────────
        // Title is part of the skeleton but hidden when no pending exists.
        const pendingTitle = el('div', 'section-title', 'Pending decisions');
        pendingTitle.style.display = 'none';
        container.appendChild(pendingTitle);
        const pendingListHost = el('div');
        container.appendChild(pendingListHost);
        panel.pending.title = pendingTitle;
        panel.pending.listHost = pendingListHost;

        // ─── Auto-choose decision ─────────────────────────────────────
        container.appendChild(el('div', 'section-title', 'Auto-choose decision'));
        const acCard = el('div', 'card');
        const acRow = el('div', 'card-row');
        acRow.appendChild(el('span', 'card-label', 'Enabled'));
        const acSw = el('label', 'switch');
        const acInput = document.createElement('input');
        acInput.type = 'checkbox';
        acSw.appendChild(acInput);
        acSw.appendChild(el('span', 'switch-slider'));
        acRow.appendChild(acSw);
        acCard.appendChild(acRow);

        const rtRow = el('div', 'card-row mt-sm');
        rtRow.appendChild(el('span', 'card-label', 'Risk threshold'));
        const rtLabel = el('span', 'mono', '5');
        rtRow.appendChild(rtLabel);
        acCard.appendChild(rtRow);

        const rtSlider = document.createElement('input');
        rtSlider.type = 'range';
        rtSlider.min = '0';
        rtSlider.max = '10';
        rtSlider.step = '1';
        rtSlider.className = 'mt-sm';
        acCard.appendChild(rtSlider);
        acCard.appendChild(el('div', 'muted xs mt-sm', '0 = strong risk penalty · 10 = ignore risk'));
        container.appendChild(acCard);

        acInput.addEventListener('change', (e) =>
            Store.sync.setOne(C.STORAGE_SYNC.AUTO_CHOOSE_ENABLED, e.target.checked));
        rtSlider.addEventListener('input', (e) => { rtLabel.textContent = e.target.value; });
        rtSlider.addEventListener('change', (e) =>
            Store.sync.setOne(C.STORAGE_SYNC.RISK_THRESHOLD, Number(e.target.value)));

        panel.autoChoose = { enabledInput: acInput, sliderInput: rtSlider, label: rtLabel };

        // ─── Auto-send mercenary ──────────────────────────────────────
        container.appendChild(el('div', 'section-title', 'Auto-send mercenary'));
        const asCard = el('div', 'card');

        const asRow1 = el('div', 'card-row');
        asRow1.appendChild(el('span', 'card-label', 'Enabled'));
        const asSw1 = el('label', 'switch');
        const asEnabled = document.createElement('input');
        asEnabled.type = 'checkbox';
        asEnabled.dataset.k = 'enabled';
        asSw1.appendChild(asEnabled);
        asSw1.appendChild(el('span', 'switch-slider'));
        asRow1.appendChild(asSw1);
        asCard.appendChild(asRow1);

        const asRow2 = el('div', 'card-row mt-sm');
        asRow2.appendChild(el('span', 'card-label', 'Auto-choose cheapest'));
        const asSw2 = el('label', 'switch');
        const asAuto = document.createElement('input');
        asAuto.type = 'checkbox';
        asAuto.dataset.k = 'autoChooseMerc';
        asSw2.appendChild(asAuto);
        asSw2.appendChild(el('span', 'switch-slider'));
        asRow2.appendChild(asSw2);
        asCard.appendChild(asRow2);

        const asWarn = el('div', 'warn sm mt-sm', '');
        asWarn.style.display = 'none';
        asCard.appendChild(asWarn);

        container.appendChild(asCard);

        const onAutoSendChange = async (e) => {
            const cur = (await Store.sync.getOne(C.STORAGE_SYNC.AUTO_SEND_MERC, {})) || {};
            cur[e.target.dataset.k] = e.target.checked;
            if (e.target.dataset.k === 'enabled' && e.target.checked) cur.disabledReason = null;
            await Store.sync.setOne(C.STORAGE_SYNC.AUTO_SEND_MERC, cur);
        };
        asEnabled.addEventListener('change', onAutoSendChange);
        asAuto.addEventListener('change', onAutoSendChange);

        panel.autoSend = { enabledInput: asEnabled, autoChooseMercInput: asAuto, warning: asWarn };

        // ─── Mercenary roster ─────────────────────────────────────────
        container.appendChild(el('div', 'section-title', 'Mercenary roster'));
        const mercListHost = el('div');
        container.appendChild(mercListHost);

        // Delegated click for "Pick" buttons — survives replaceChildren.
        mercListHost.addEventListener('click', async (e) => {
            const btn = e.target.closest('button[data-pick]');
            if (!btn) return;
            const cur = (await Store.sync.getOne(C.STORAGE_SYNC.AUTO_SEND_MERC, {})) || {};
            cur.mercenaryId = btn.dataset.pick;
            cur.mercenaryName = btn.dataset.pickName || btn.dataset.pick;
            await Store.sync.setOne(C.STORAGE_SYNC.AUTO_SEND_MERC, cur);
        });

        panel.mercList = { listHost: mercListHost };

        // ─── Stash ────────────────────────────────────────────────────
        container.appendChild(el('div', 'section-title', 'Stash'));
        const stashCard = el('div', 'card');
        const stashCapRow = el('div', 'card-row');
        stashCapRow.appendChild(el('span', 'card-label', 'Capacity'));
        const stashCapText = el('span', '', '');
        stashCapRow.appendChild(stashCapText);
        stashCard.appendChild(stashCapRow);

        const stashRefresh = el('button', 'btn small mt-sm', 'Refresh');
        stashRefresh.addEventListener('click', () => sendToContent('requestStash'));
        stashCard.appendChild(stashRefresh);
        container.appendChild(stashCard);

        const itemsTitle = el('div', 'section-title', '');
        itemsTitle.style.display = 'none';
        container.appendChild(itemsTitle);
        const itemsHost = el('div');
        container.appendChild(itemsHost);

        panel.stash = {
            card: stashCard,
            capacityText: stashCapText,
            refreshBtn: stashRefresh,
            itemsTitle,
            itemsHost,
        };
    }

    // ─── Targeted refreshes ───────────────────────────────────────────────

    async function refreshActive() {
        if (!panel) return;
        const exps = await Store.local.getOne(C.STORAGE_LOCAL.EXPEDITIONS, []);
        dropSectionTimers(panel.active);
        if (!exps || exps.length === 0) {
            panel.active.listHost.replaceChildren(el('div', 'empty', 'No active expeditions.'));
            return;
        }
        const cards = [];
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
                const inst = uiComponents.timer.create(exp.endTime);
                adoptTimer(panel.active, inst);
                tRow.appendChild(inst.el);
                card.appendChild(tRow);
            }
            cards.push(card);
        }
        panel.active.listHost.replaceChildren(...cards);
    }

    async function refreshArchived() {
        if (!panel) return;
        const archived = await Store.local.getOne(C.STORAGE_LOCAL.ARCHIVED_EXPEDITIONS, []);
        const archList = Array.isArray(archived) ? archived : [];
        if (archList.length === 0) {
            panel.archived.listHost.replaceChildren(
                el('div', 'empty', 'No archived runs yet — click Refresh.'));
            return;
        }
        const cards = [];
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
            cards.push(card);
        }
        panel.archived.listHost.replaceChildren(...cards);
    }

    async function refreshPending() {
        if (!panel) return;
        const decisions = await Store.local.getOne(C.STORAGE_LOCAL.DECISIONS, []);
        const pending = (decisions || []).filter((d) => !d.isResolved);
        dropSectionTimers(panel.pending);
        if (pending.length === 0) {
            panel.pending.title.style.display = 'none';
            panel.pending.listHost.replaceChildren();
            return;
        }
        panel.pending.title.style.display = '';
        const cards = [];
        for (const d of pending) {
            const card = el('div', 'card');
            card.appendChild(el('div', 'sm',
                `<strong>${escape(d.mercenaryCallsign || '?')}</strong> · ${escape(d.locationName || '')}`));
            if (d.content) card.appendChild(el('div', 'sm muted mt-sm', escape(d.content)));
            if (d.decisionDeadline) {
                const tRow = el('div', 'card-row mt-sm');
                tRow.appendChild(el('span', 'sm muted', 'Decide in'));
                const inst = uiComponents.timer.create(d.decisionDeadline);
                adoptTimer(panel.pending, inst);
                tRow.appendChild(inst.el);
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
            cards.push(card);
        }
        panel.pending.listHost.replaceChildren(...cards);
    }

    async function refreshAutoChoose() {
        if (!panel) return;
        const [enabled, threshold] = await Promise.all([
            Store.sync.getOne(C.STORAGE_SYNC.AUTO_CHOOSE_ENABLED, false),
            Store.sync.getOne(C.STORAGE_SYNC.RISK_THRESHOLD, 5),
        ]);
        const n = panel.autoChoose;
        if (n.enabledInput.checked !== !!enabled) n.enabledInput.checked = !!enabled;
        const tv = String(Number(threshold ?? 5));
        if (n.sliderInput.value !== tv) n.sliderInput.value = tv;
        n.label.textContent = tv;
    }

    async function refreshAutoSend() {
        if (!panel) return;
        const autoSend = await Store.sync.getOne(C.STORAGE_SYNC.AUTO_SEND_MERC,
            { enabled: false, autoChooseMerc: true });
        const n = panel.autoSend;
        const enabled = !!(autoSend && autoSend.enabled);
        const acm = !!(autoSend && autoSend.autoChooseMerc !== false);
        if (n.enabledInput.checked !== enabled) n.enabledInput.checked = enabled;
        if (n.autoChooseMercInput.checked !== acm) n.autoChooseMercInput.checked = acm;
        if (autoSend && autoSend.disabledReason) {
            n.warning.textContent = `Disabled: ${autoSend.disabledReason}`;
            n.warning.style.display = '';
        } else {
            n.warning.style.display = 'none';
            n.warning.textContent = '';
        }
    }

    async function refreshMercList() {
        if (!panel) return;
        const [mercs, mercConfigs, autoSend] = await Promise.all([
            Store.local.getOne(C.STORAGE_LOCAL.MERCENARIES),
            Store.local.getOne(C.STORAGE_LOCAL.MERC_CONFIG, {}),
            Store.sync.getOne(C.STORAGE_SYNC.AUTO_SEND_MERC, {}),
        ]);
        const mercList = (mercs && (Array.isArray(mercs) ? mercs : mercs.mercenaries)) || [];
        if (mercList.length === 0) {
            panel.mercList.listHost.replaceChildren(el('div', 'empty', 'No mercenary data yet.'));
            return;
        }
        const cards = [];
        for (const m of mercList) {
            const cfg = (mercConfigs || {})[m.id] || {};
            const isPicked = autoSend && autoSend.mercenaryId === m.id;
            const card = el('div', 'merc-card'
                + (m.status !== 'AVAILABLE' ? ' unavail' : '')
                + (isPicked ? ' selected' : ''));
            const body = el('div');
            body.appendChild(el('div', '', `<strong>${escape(m.callsign || m.id)}</strong>`));
            body.appendChild(el('div', 'sm muted',
                `${escape(m.status || '')}${cfg.totalCost ? ` · cost ${cfg.totalCost}` : ''}${cfg.riskScore != null ? ` · risk ${cfg.riskScore}` : ''}`));
            card.appendChild(body);
            const btn = el('button', 'btn small', isPicked ? 'Selected' : 'Pick');
            btn.dataset.pick = m.id;
            btn.dataset.pickName = m.callsign || m.id;
            card.appendChild(btn);
            cards.push(card);
        }
        panel.mercList.listHost.replaceChildren(...cards);
    }

    async function refreshStash() {
        if (!panel) return;
        const stash = await Store.local.getOne(C.STORAGE_LOCAL.STASH);
        const n = panel.stash;
        if (stash && stash.maxCapacity !== undefined) {
            const used = stash.currentUsage || 0;
            const max = stash.maxCapacity || 0;
            const pct = max > 0 ? Math.round((used / max) * 100) : 0;
            const pctCls = pct > 90 ? 'err' : pct > 70 ? 'warn' : 'ok';
            n.capacityText.className = pctCls;
            n.capacityText.textContent = `${used} / ${max} (${pct}%)`;
        } else {
            n.capacityText.className = 'muted sm';
            n.capacityText.textContent = 'No stash data.';
        }

        const items = (stash && Array.isArray(stash.items)) ? stash.items : [];
        if (items.length === 0) {
            n.itemsTitle.style.display = 'none';
            n.itemsHost.replaceChildren();
            return;
        }
        n.itemsTitle.style.display = '';
        n.itemsTitle.textContent = `Items (${items.length})`;
        const cards = [];
        for (const item of items) {
            const c = el('div', 'card compact');
            const row = el('div', 'card-row');
            row.appendChild(el('span', '', escape(item.name || item.itemName || '?')));
            row.appendChild(el('span', 'sm muted', `x${item.quantity || 1}`));
            c.appendChild(row);
            cards.push(c);
        }
        n.itemsHost.replaceChildren(...cards);
    }

    async function refreshAll() {
        await Promise.all([
            refreshActive(),
            refreshArchived(),
            refreshPending(),
            refreshAutoChoose(),
            refreshAutoSend(),
            refreshMercList(),
            refreshStash(),
        ]);
    }

    // ─── Lifecycle ────────────────────────────────────────────────────────
    let unsubLocal = null;
    let unsubSync = null;

    root.COR3.ui.expeditions = {
        // Subscribe-only mount; first render runs from activate() to avoid
        // the dup-render race (see overview.js / logs-panel.js).
        mount(container) {
            unsubLocal = Store.local.onChanged((changes) => {
                if (!container.classList.contains('active')) return;
                if (changes[C.STORAGE_LOCAL.EXPEDITIONS])          refreshActive();
                if (changes[C.STORAGE_LOCAL.ARCHIVED_EXPEDITIONS]) refreshArchived();
                if (changes[C.STORAGE_LOCAL.DECISIONS])            refreshPending();
                if (changes[C.STORAGE_LOCAL.MERCENARIES] ||
                    changes[C.STORAGE_LOCAL.MERC_CONFIG])          refreshMercList();
                if (changes[C.STORAGE_LOCAL.STASH])                refreshStash();
            });
            unsubSync = Store.sync.onChanged((changes) => {
                if (!container.classList.contains('active')) return;
                // AUTO_SEND_MERC affects both the auto-send card AND the
                // mercenary roster's "selected" highlight on the picked
                // merc — both need refreshing on its change.
                if (changes[C.STORAGE_SYNC.AUTO_SEND_MERC]) {
                    refreshAutoSend();
                    refreshMercList();
                }
                if (changes[C.STORAGE_SYNC.AUTO_CHOOSE_ENABLED] ||
                    changes[C.STORAGE_SYNC.RISK_THRESHOLD]) {
                    refreshAutoChoose();
                }
            });
        },
        async activate(container) {
            build(container);
            await refreshAll();
        },
        deactivate() { tearDown(); },
    };
})();
