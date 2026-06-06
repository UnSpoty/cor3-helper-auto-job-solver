// src/ui/sections/expeditions.js
// "Everything about running expeditions" tab (reworked).
//
// Layout (top → bottom):
//   • Master switch            — gates ALL expedition automation (#2)
//   • Auto-send mercenary       — toggle + Money Min/Max + live status (#1,3,4,5)
//   • Auto-choose decision      — toggle + risk threshold slider (#10)
//   • Active expedition          — status, merc, loot/decision actions
//   • Pending decisions          — interactive option buttons
//   • Mercenary roster           — rich cards + "Send now" + Refresh (#6)
//   • Stash                      — rich item cards + Sell/Throw away + Refresh (#7)
//   • Recent runs                — full per-run detail + pagination + Refresh (#9)
//
// Settings model: STORAGE_SYNC.EXPEDITIONS_SETTINGS
//   { masterEnabled, autoSend:{ enabled, moneyMin, moneyMax }, disabledReason }
// Auto-choose keeps its own keys (AUTO_CHOOSE_ENABLED / RISK_THRESHOLD), gated
// by masterEnabled in the automation module.
//
// Render: skeleton built once per activate(); each storage key drives the
// narrowest refresh. Lists use replaceChildren (atomic).

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
    function num(n) {
        return (typeof n === 'number' && isFinite(n)) ? n.toLocaleString('en-US') : '?';
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

    const DEFAULT_SETTINGS = { masterEnabled: false, autoSend: { enabled: false, moneyMin: 0, moneyMax: 0 }, disabledReason: null };
    async function getSettings() {
        const s = await Store.sync.getOne(C.STORAGE_SYNC.EXPEDITIONS_SETTINGS, null);
        if (!s) return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
        if (!s.autoSend) s.autoSend = { enabled: false, moneyMin: 0, moneyMax: 0 };
        return s;
    }
    // Serialise the read-modify-write of EXPEDITIONS_SETTINGS — rapid edits
    // (toggle + type Min + type Max in quick succession) would otherwise
    // interleave their read-then-write and clobber each other's fields.
    let settingsWriteChain = Promise.resolve();
    function queueSettingsWrite(mutate) {
        settingsWriteChain = settingsWriteChain.then(async () => {
            const s = await getSettings();
            mutate(s);
            await Store.sync.setOne(C.STORAGE_SYNC.EXPEDITIONS_SETTINGS, s);
        }).catch(() => {});
        return settingsWriteChain;
    }
    function patchSettings(patch) {
        return queueSettingsWrite((s) => Object.assign(s, patch));
    }
    function patchAutoSend(patch) {
        return queueSettingsWrite((s) => {
            s.autoSend = Object.assign({ enabled: false, moneyMin: 0, moneyMax: 0 }, s.autoSend, patch);
        });
    }

    function outcomePill(outcome) {
        if (/full_success/i.test(outcome)) return 'ok';
        if (/partial/i.test(outcome)) return 'warn';
        if (/fail|lost|dead|death/i.test(outcome)) return 'err';
        return 'idle';
    }
    function statusPill(status) {
        if (/complet/i.test(status)) return 'ok';
        if (/event/i.test(status)) return 'warn';
        if (/run|return|prepar/i.test(status)) return 'active';
        return 'idle';
    }
    function tierClass(tier) {
        return 'exp-tier exp-tier-' + String(tier || 'common').toLowerCase();
    }
    // Real expedition end time (ms epoch). The server sends startTime/endTime as
    // null even while RUNNING, but the expedition `id` is a UUIDv7 whose first
    // 48 bits are the launch unix-ms — so end = launch + runDuration.
    function expEndMs(exp) {
        if (exp.endTime) { const t = Date.parse(exp.endTime); if (!isNaN(t)) return t; }
        if (exp.id && exp.runDuration) {
            const start = parseInt(String(exp.id).replace(/-/g, '').slice(0, 12), 16);
            if (isFinite(start) && start > 1e12) return start + exp.runDuration;
        }
        return null;
    }

    // ─── Panel state ──────────────────────────────────────────────────────
    let panel = null;

    function tearDown() {
        if (!panel) return;
        for (const tm of panel.timers) try { tm.stop(); } catch (_) {}
        panel = null;
    }
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
            container, timers: [],
            master: { input: null, hint: null },
            autoSend: { input: null, minMaxRow: null, minInput: null, maxInput: null, status: null, warn: null },
            autoChoose: { enabledInput: null, sliderInput: null, label: null },
            active: { listHost: null, timers: [] },
            pending: { title: null, listHost: null, timers: [] },
            roster: { listHost: null },
            stash: { capacityText: null, bar: null, itemsTitle: null, itemsHost: null },
            recent: { listHost: null, showAll: false, collapsed: true, caret: null },
        };

        // ─── Master switch ────────────────────────────────────────────
        container.appendChild(el('div', 'section-title', 'Expeditions automation'));
        const mCard = el('div', 'card');
        const mRow = el('div', 'card-row');
        mRow.appendChild(el('span', 'card-label', 'Master switch'));
        const mSw = el('label', 'switch');
        const mInput = document.createElement('input');
        mInput.type = 'checkbox';
        mSw.appendChild(mInput); mSw.appendChild(el('span', 'switch-slider'));
        mRow.appendChild(mSw);
        mCard.appendChild(mRow);
        container.appendChild(mCard);
        mInput.addEventListener('change', (e) => patchSettings({ masterEnabled: e.target.checked }));
        panel.master = { input: mInput };

        // ─── Auto-send mercenary ──────────────────────────────────────
        container.appendChild(el('div', 'section-title', 'Auto-send mercenary'));
        const asCard = el('div', 'card');
        const asRow = el('div', 'card-row');
        asRow.appendChild(el('span', 'card-label', 'Auto-send by balance'));
        const asSw = el('label', 'switch');
        const asInput = document.createElement('input');
        asInput.type = 'checkbox';
        asSw.appendChild(asInput); asSw.appendChild(el('span', 'switch-slider'));
        asRow.appendChild(asSw);
        asCard.appendChild(asRow);

        // Money Min / Max inputs (hidden until enabled)
        const mmRow = el('div', 'exp-minmax mt-sm');
        const minWrap = el('label', 'exp-minmax-field');
        minWrap.appendChild(el('span', 'card-label', 'Money: Min (CR)'));
        const minInput = document.createElement('input');
        minInput.type = 'number'; minInput.min = '0'; minInput.className = 'exp-num'; minInput.placeholder = '0';
        minWrap.appendChild(minInput);
        const maxWrap = el('label', 'exp-minmax-field');
        maxWrap.appendChild(el('span', 'card-label', 'Money: Max (CR)'));
        const maxInput = document.createElement('input');
        maxInput.type = 'number'; maxInput.min = '0'; maxInput.className = 'exp-num'; maxInput.placeholder = '0';
        maxWrap.appendChild(maxInput);
        mmRow.appendChild(minWrap); mmRow.appendChild(maxWrap);
        asCard.appendChild(mmRow);

        const asStatus = el('div', 'exp-status mt-sm', '');
        asCard.appendChild(asStatus);
        const asWarn = el('div', 'warn sm mt-sm', '');
        asWarn.style.display = 'none';
        asCard.appendChild(asWarn);
        container.appendChild(asCard);

        asInput.addEventListener('change', (e) => patchAutoSend({ enabled: e.target.checked }));
        const commitMin = () => patchAutoSend({ moneyMin: Math.max(0, Math.floor(Number(minInput.value) || 0)) });
        const commitMax = () => patchAutoSend({ moneyMax: Math.max(0, Math.floor(Number(maxInput.value) || 0)) });
        minInput.addEventListener('change', commitMin);
        maxInput.addEventListener('change', commitMax);
        panel.autoSend = { input: asInput, minMaxRow: mmRow, minInput, maxInput, status: asStatus, warn: asWarn };

        // ─── Auto-choose decision ─────────────────────────────────────
        container.appendChild(el('div', 'section-title', 'Auto-choose decision'));
        const acCard = el('div', 'card');
        const acRow = el('div', 'card-row');
        acRow.appendChild(el('span', 'card-label', 'Enabled'));
        const acSw = el('label', 'switch');
        const acInput = document.createElement('input');
        acInput.type = 'checkbox';
        acSw.appendChild(acInput); acSw.appendChild(el('span', 'switch-slider'));
        acRow.appendChild(acSw);
        acCard.appendChild(acRow);
        const rtRow = el('div', 'card-row mt-sm');
        rtRow.appendChild(el('span', 'card-label', 'Risk threshold'));
        const rtLabel = el('span', 'mono', '5');
        rtRow.appendChild(rtLabel);
        acCard.appendChild(rtRow);
        const rtSlider = document.createElement('input');
        rtSlider.type = 'range'; rtSlider.min = '0'; rtSlider.max = '10'; rtSlider.step = '1'; rtSlider.className = 'mt-sm';
        acCard.appendChild(rtSlider);
        acCard.appendChild(el('div', 'muted xs mt-sm', '0 = strong risk penalty · 10 = ignore risk'));
        container.appendChild(acCard);
        acInput.addEventListener('change', (e) => Store.sync.setOne(C.STORAGE_SYNC.AUTO_CHOOSE_ENABLED, e.target.checked));
        rtSlider.addEventListener('input', (e) => { rtLabel.textContent = e.target.value; });
        rtSlider.addEventListener('change', (e) => Store.sync.setOne(C.STORAGE_SYNC.RISK_THRESHOLD, Number(e.target.value)));
        panel.autoChoose = { enabledInput: acInput, sliderInput: rtSlider, label: rtLabel };

        // ─── Active expedition ────────────────────────────────────────
        const aHead = el('div', 'row between mt-md');
        aHead.appendChild(el('div', 'section-title', 'Active expedition'));
        const aRefresh = el('button', 'btn small', 'Refresh');
        aRefresh.addEventListener('click', () => sendToContent('requestExpeditions'));
        aHead.appendChild(aRefresh);
        container.appendChild(aHead);
        const aHost = el('div');
        container.appendChild(aHost);
        // delegated clicks: open container / collect
        aHost.addEventListener('click', (e) => {
            const b = e.target.closest('button[data-act]');
            if (!b) return;
            const id = b.dataset.exp;
            if (b.dataset.act === 'open') sendToContent('openContainer', { expeditionId: id });
            else if (b.dataset.act === 'collect') sendToContent('collectAll', { expeditionId: id });
        });
        panel.active.listHost = aHost;

        // ─── Pending decisions ────────────────────────────────────────
        const pTitle = el('div', 'section-title', 'Pending decisions');
        pTitle.style.display = 'none';
        container.appendChild(pTitle);
        const pHost = el('div');
        container.appendChild(pHost);
        panel.pending.title = pTitle;
        panel.pending.listHost = pHost;

        // ─── Mercenary roster ─────────────────────────────────────────
        const rHead = el('div', 'row between mt-md');
        rHead.appendChild(el('div', 'section-title', 'Mercenary roster'));
        const rRefresh = el('button', 'btn small', 'Refresh');
        rRefresh.addEventListener('click', () => { sendToContent('requestMercenaries'); sendToContent('requestExpeditionConfig'); });
        rHead.appendChild(rRefresh);
        container.appendChild(rHead);
        const rHost = el('div');
        container.appendChild(rHost);
        rHost.addEventListener('click', (e) => {
            const b = e.target.closest('button[data-send]');
            if (!b || b.disabled) return;
            sendToContent('sendMercNow', { mercenaryId: b.dataset.send });
            b.disabled = true; b.textContent = 'Sending…';
        });
        panel.roster.listHost = rHost;

        // ─── Stash ────────────────────────────────────────────────────
        const sHead = el('div', 'row between mt-md');
        sHead.appendChild(el('div', 'section-title', 'Stash'));
        const sRefresh = el('button', 'btn small', 'Refresh');
        sRefresh.addEventListener('click', () => sendToContent('requestStash'));
        sHead.appendChild(sRefresh);
        container.appendChild(sHead);
        const sCard = el('div', 'card');
        const sCapRow = el('div', 'card-row');
        sCapRow.appendChild(el('span', 'card-label', 'Capacity'));
        const sCapText = el('span', '', '');
        sCapRow.appendChild(sCapText);
        sCard.appendChild(sCapRow);
        const sBarOuter = el('div', 'exp-bar mt-sm');
        const sBar = el('div', 'exp-bar-fill');
        sBarOuter.appendChild(sBar);
        sCard.appendChild(sBarOuter);
        container.appendChild(sCard);
        const itemsTitle = el('div', 'section-title', '');
        itemsTitle.style.display = 'none';
        container.appendChild(itemsTitle);
        const itemsHost = el('div', 'exp-item-grid');
        container.appendChild(itemsHost);
        itemsHost.addEventListener('click', (e) => {
            const b = e.target.closest('button[data-item-act]');
            if (!b || b.disabled) return;
            const itemId = b.dataset.item;
            const name = b.dataset.name || 'this item';
            if (b.dataset.itemAct === 'sell') {
                sendToContent('sellItem', { itemId, quantity: 1 });
                b.disabled = true;
            } else if (b.dataset.itemAct === 'delete') {
                if (window.confirm(`Throw away "${name}"? This is permanent.`)) {
                    sendToContent('deleteItem', { itemId, quantity: 1 });
                    b.disabled = true;
                }
            }
        });
        panel.stash = { capacityText: sCapText, bar: sBar, itemsTitle, itemsHost };

        // ─── Recent runs (collapsible — collapsed by default) ─────────
        const recHead = el('div', 'row between mt-md');
        const recTitle = el('div', 'section-title exp-collapsible');
        const recCaret = el('span', 'exp-caret', '▸');
        recTitle.appendChild(recCaret);
        recTitle.appendChild(document.createTextNode(' Recent runs'));
        recTitle.addEventListener('click', () => setRecentCollapsed(!panel.recent.collapsed));
        recHead.appendChild(recTitle);
        const recRefresh = el('button', 'btn small', 'Refresh');
        recRefresh.addEventListener('click', (e) => { e.stopPropagation(); sendToContent('requestArchivedExpeditions'); });
        recHead.appendChild(recRefresh);
        container.appendChild(recHead);
        const recHost = el('div');
        recHost.style.display = 'none'; // collapsed by default
        container.appendChild(recHost);
        recHost.addEventListener('click', (e) => {
            const d = e.target.closest('button[data-toggle-run]');
            if (d) { const det = d.closest('.exp-run-card').querySelector('.exp-run-detail'); if (det) det.classList.toggle('open'); return; }
            const more = e.target.closest('button[data-show-all]');
            if (more) { panel.recent.showAll = true; refreshRecent(); }
        });
        panel.recent.listHost = recHost;
        panel.recent.caret = recCaret;
        panel.recent.collapsed = true;
    }

    function setRecentCollapsed(collapsed) {
        if (!panel) return;
        panel.recent.collapsed = collapsed;
        panel.recent.listHost.style.display = collapsed ? 'none' : '';
        panel.recent.caret.textContent = collapsed ? '▸' : '▾';
    }

    // ─── Refreshers ───────────────────────────────────────────────────────
    async function refreshMaster() {
        if (!panel) return;
        const s = await getSettings();
        if (panel.master.input.checked !== !!s.masterEnabled) panel.master.input.checked = !!s.masterEnabled;
    }

    async function refreshAutoSend() {
        if (!panel) return;
        const [s, state, profile] = await Promise.all([
            getSettings(),
            Store.local.getOne(C.STORAGE_LOCAL.EXP_AUTOSEND_STATE, {}),
            Store.local.getOne(C.STORAGE_LOCAL.PROFILE, {}),
        ]);
        const n = panel.autoSend;
        const enabled = !!(s.autoSend && s.autoSend.enabled);
        if (n.input.checked !== enabled) n.input.checked = enabled;
        n.minMaxRow.style.display = enabled ? '' : 'none';
        if (document.activeElement !== n.minInput) n.minInput.value = (s.autoSend.moneyMin || 0) || '';
        if (document.activeElement !== n.maxInput) n.maxInput.value = (s.autoSend.moneyMax || 0) || '';

        const bal = profile && typeof profile.balance === 'number' ? profile.balance : null;
        const balTxt = bal != null ? `${num(bal)} CR` : '—';
        if (enabled) {
            const armed = state && state.armed;
            const st = (state && state.status) || 'starting…';
            n.status.innerHTML = `Balance: <span class="mono">${balTxt}</span> · `
                + `<span class="${armed ? 'exp-armed' : 'muted'}">${escape(st)}</span>`;
            n.status.style.display = '';
        } else {
            n.status.style.display = 'none';
        }
        if (s.disabledReason) {
            n.warn.textContent = `Paused: ${s.disabledReason.replace(/_/g, ' ')}`;
            n.warn.style.display = '';
        } else {
            n.warn.style.display = 'none';
        }
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

    async function refreshActive() {
        if (!panel) return;
        const exps = (await Store.local.getOne(C.STORAGE_LOCAL.EXPEDITIONS, [])) || [];
        dropSectionTimers(panel.active);
        if (!exps.length) {
            panel.active.listHost.replaceChildren(el('div', 'empty', 'No active expedition.'));
            return;
        }
        const cards = [];
        for (const exp of exps) {
            const card = el('div', 'card');
            const head = el('div', 'card-row');
            const merc = exp.mercenary && exp.mercenary.callsign;
            head.appendChild(el('span', 'card-label',
                `${merc ? escape(merc) + ' · ' : ''}${escape(exp.locationName || '')}${exp.zoneName ? ' · ' + escape(exp.zoneName) : ''}`));
            head.appendChild(el('span', `pill ${statusPill(exp.status)}`, escape(exp.status || '?')));
            card.appendChild(head);

            const meta = [];
            if (exp.objectiveName) meta.push(escape(exp.objectiveName));
            if (exp.riskScore != null) meta.push(`risk ${exp.riskScore}`);
            if (exp.totalCost != null) meta.push(`${num(exp.totalCost)} CR`);
            if (meta.length) card.appendChild(el('div', 'muted xs mt-sm', meta.join(' · ')));

            if (exp.status !== 'COMPLETED' && exp._timerPreparing) {
                card.appendChild(el('div', 'muted xs mt-sm', 'Preparing for deployment…'));
            } else if (exp.status !== 'COMPLETED') {
                // _timerFrozenMs/_timerEndMs are stamped by the expeditions data
                // module (run clock starts at departure + accrues EVENT-pause, so
                // it matches the in-game countdown).
                const frozen = (typeof exp._timerFrozenMs === 'number') ? exp._timerFrozenMs : null;
                const endMs = (typeof exp._timerEndMs === 'number') ? exp._timerEndMs : expEndMs(exp);
                if (frozen != null || endMs) {
                    const tRow = el('div', 'card-row mt-sm');
                    tRow.appendChild(el('span', 'sm muted', frozen != null ? 'Paused (decision)' : 'ETA'));
                    if (frozen != null) {
                        tRow.appendChild(el('span', 'timer warn', uiComponents.timer.fmt(Math.floor(frozen / 1000))));
                    } else {
                        const inst = uiComponents.timer.create(endMs);
                        adoptTimer(panel.active, inst);
                        tRow.appendChild(inst.el);
                    }
                    card.appendChild(tRow);
                }
            }

            // COMPLETED → loot actions
            if (exp.status === 'COMPLETED') {
                const opened = Array.isArray(exp.containerData);
                const uncollected = opened && exp.containerData.some((i) => !i.isCollected);
                const actRow = el('div', 'mt-sm');
                if (!opened) {
                    const b = el('button', 'btn small btn-success', 'Open container');
                    b.dataset.act = 'open'; b.dataset.exp = exp.id;
                    actRow.appendChild(b);
                } else if (uncollected) {
                    const b = el('button', 'btn small btn-success', 'Collect all');
                    b.dataset.act = 'collect'; b.dataset.exp = exp.id;
                    actRow.appendChild(b);
                } else if (opened) {
                    actRow.appendChild(el('span', 'pill ok', 'Collected'));
                }
                card.appendChild(actRow);
            }
            cards.push(card);
        }
        panel.active.listHost.replaceChildren(...cards);
    }

    async function refreshPending() {
        if (!panel) return;
        const decisions = (await Store.local.getOne(C.STORAGE_LOCAL.DECISIONS, [])) || [];
        const pending = decisions.filter((d) => !d.isResolved && Array.isArray(d.decisionOptions));
        dropSectionTimers(panel.pending);
        if (!pending.length) {
            panel.pending.title.style.display = 'none';
            panel.pending.listHost.replaceChildren();
            return;
        }
        panel.pending.title.style.display = '';
        const cards = [];
        for (const d of pending) {
            const card = el('div', 'card');
            card.appendChild(el('div', 'sm', `<strong>${escape(d.mercenaryCallsign || '?')}</strong>${d.locationName ? ' · ' + escape(d.locationName) : ''}`));
            if (d.content) card.appendChild(el('div', 'sm muted mt-sm', escape(d.content)));
            for (const opt of d.decisionOptions) {
                const parts = [];
                if (opt.riskModifier) parts.push(`risk ${opt.riskModifier > 0 ? '+' : ''}${opt.riskModifier}`);
                if (opt.lootModifier) parts.push(`loot ${opt.lootModifier > 0 ? '+' : ''}${opt.lootModifier}`);
                const btn = el('button', 'btn small mt-sm btn-block',
                    `${escape(opt.label || opt.id)}${parts.length ? ' — ' + parts.join(', ') : ''}`);
                btn.addEventListener('click', () => sendToContent('respondDecision', {
                    expeditionId: d.expeditionId, messageId: d.messageId, selectedOption: opt.id,
                }));
                card.appendChild(btn);
            }
            cards.push(card);
        }
        panel.pending.listHost.replaceChildren(...cards);
    }

    async function refreshRoster() {
        if (!panel) return;
        const [mercsRaw, configs, exps] = await Promise.all([
            Store.local.getOne(C.STORAGE_LOCAL.MERCENARIES),
            Store.local.getOne(C.STORAGE_LOCAL.MERC_CONFIG, {}),
            Store.local.getOne(C.STORAGE_LOCAL.EXPEDITIONS, []),
        ]);
        // Only one expedition can run at a time — block "Send now" while any is active.
        const hasActive = (exps || []).some((e) => e.status && e.status !== 'COMPLETED');
        const mercs = (mercsRaw && (Array.isArray(mercsRaw) ? mercsRaw : mercsRaw.mercenaries)) || [];
        if (!mercs.length) {
            panel.roster.listHost.replaceChildren(el('div', 'empty', 'No mercenary data — click Refresh.'));
            return;
        }
        const cards = [];
        for (const m of mercs) {
            const cfg = (configs || {})[m.id] || {};
            const avail = m.status === 'AVAILABLE';
            const card = el('div', 'exp-merc-card' + (avail ? '' : ' unavail'));

            const av = document.createElement('img');
            av.className = 'exp-avatar'; av.src = m.avatarSeed || ''; av.alt = m.callsign || '';
            av.referrerPolicy = 'no-referrer'; av.loading = 'lazy';
            card.appendChild(av);

            const body = el('div', 'exp-merc-body');
            const nameRow = el('div', 'exp-merc-namerow');
            nameRow.appendChild(el('span', 'exp-merc-name', escape(m.callsign || m.id)));
            nameRow.appendChild(el('span', `pill ${avail ? 'ok' : (/contract|run/i.test(m.status) ? 'active' : 'idle')}`, escape(m.status || '')));
            body.appendChild(nameRow);

            body.appendChild(el('div', 'sm muted',
                `${escape(m.specializationName || m.specialization || '')} · ${escape(m.rank || '')} · ${m.missionsCompleted || 0} raids`));
            const traits = [];
            if (m.specializationDescription) traits.push(escape(m.specializationDescription));
            if (m.traitName) traits.push(`<strong>${escape(m.traitName)}</strong>: ${escape(m.traitDescription || '')}`);
            if (traits.length) body.appendChild(el('div', 'xs muted mt-sm', traits.join(' · ')));

            // configure preview
            if (cfg.totalCost != null || cfg.riskScore != null) {
                const stat = [];
                if (cfg.totalCost != null) stat.push(`💸 ${num(cfg.totalCost)} (dep ${num(cfg.prepaymentAmount)})`);
                if (cfg.riskScore != null) stat.push(`⚠ risk ${cfg.riskScore}${cfg.riskLevel ? ' (' + escape(cfg.riskLevel) + ')' : ''}`);
                if (cfg.outcomeChances && cfg.outcomeChances.fullSuccessChance != null) stat.push(`✓ ${cfg.outcomeChances.fullSuccessChance}%`);
                body.appendChild(el('div', 'xs mt-sm', stat.join(' · ')));
            }
            if (m.reputationRequirement != null) body.appendChild(el('div', 'xs muted mt-sm', `rep req ${m.reputationRequirement}`));
            card.appendChild(body);

            const canSend = avail && !hasActive;
            const label = !avail ? (m.status === 'RESTING' ? 'Resting' : 'Busy')
                : (hasActive ? 'Busy' : 'Send now');
            const btn = el('button', 'btn small', label);
            btn.dataset.send = m.id;
            if (!canSend) btn.disabled = true;
            if (avail && hasActive) btn.title = 'An expedition is already running (max 1 at a time)';
            card.appendChild(btn);
            cards.push(card);
        }
        panel.roster.listHost.replaceChildren(...cards);
    }

    async function refreshStash() {
        if (!panel) return;
        const stash = await Store.local.getOne(C.STORAGE_LOCAL.STASH);
        const n = panel.stash;
        if (stash && stash.maxCapacity !== undefined) {
            const used = stash.currentUsage || 0;
            const max = stash.maxCapacity || 0;
            const pct = max > 0 ? Math.round((used / max) * 100) : 0;
            const cls = pct > 90 ? 'err' : pct > 70 ? 'warn' : 'ok';
            n.capacityText.className = cls;
            n.capacityText.textContent = `${used} / ${max} (${pct}%)`;
            n.bar.style.width = pct + '%';
            n.bar.className = 'exp-bar-fill ' + cls;
        } else {
            n.capacityText.className = 'muted sm';
            n.capacityText.textContent = 'No stash data.';
            n.bar.style.width = '0%';
        }
        const items = (stash && Array.isArray(stash.items)) ? stash.items : [];
        if (!items.length) {
            n.itemsTitle.style.display = 'none';
            n.itemsHost.replaceChildren();
            return;
        }
        n.itemsTitle.style.display = '';
        n.itemsTitle.textContent = `Items (${items.length})`;
        const cards = [];
        for (const item of items) {
            // Compact single-line row: [thumb][name + tier/cat/value][actions].
            // Full description goes to the tooltip to keep the row short.
            const c = el('div', 'exp-item-card');
            if (item.description) c.title = item.description;

            const img = document.createElement('img');
            img.className = 'exp-thumb'; img.src = item.imageUrl || ''; img.alt = item.name || '';
            img.referrerPolicy = 'no-referrer'; img.loading = 'lazy';
            c.appendChild(img);

            const info = el('div', 'exp-item-info');
            info.appendChild(el('div', 'exp-item-name', escape(item.name || '?')));
            const sub = el('div', 'exp-item-sub');
            if (item.tier) sub.appendChild(el('span', tierClass(item.tier), escape(item.tier)));
            if (item.category) sub.appendChild(el('span', 'exp-cat', escape(String(item.category).replace(/_/g, ' '))));
            if ((item.quantity || 1) > 1) sub.appendChild(el('span', 'exp-cat', `x${item.quantity}`));
            const value = item.sellPrice || item.baseValue;
            if (value) sub.appendChild(el('span', 'exp-val', num(value)));
            info.appendChild(sub);
            c.appendChild(info);

            const acts = el('div', 'exp-item-acts');
            if (item.canSell) {
                const b = el('button', 'btn small', 'Sell');
                b.title = item.sellPrice ? `Sell for ${num(item.sellPrice)} CR` : 'Sell';
                b.dataset.itemAct = 'sell'; b.dataset.item = item.id; b.dataset.name = item.name || '';
                acts.appendChild(b);
            }
            if (item.canDelete) {
                const b = el('button', 'btn small btn-danger', '✕');
                b.title = 'Throw away';
                b.dataset.itemAct = 'delete'; b.dataset.item = item.id; b.dataset.name = item.name || '';
                acts.appendChild(b);
            }
            if (acts.childNodes.length) c.appendChild(acts);
            cards.push(c);
        }
        n.itemsHost.replaceChildren(...cards);
    }

    async function refreshRecent() {
        if (!panel) return;
        const archived = (await Store.local.getOne(C.STORAGE_LOCAL.ARCHIVED_EXPEDITIONS, [])) || [];
        const list = Array.isArray(archived) ? archived : [];
        if (!list.length) {
            panel.recent.listHost.replaceChildren(el('div', 'empty', 'No archived runs yet — click Refresh.'));
            return;
        }
        const PAGE = 8;
        const shown = panel.recent.showAll ? list : list.slice(0, PAGE);
        const cards = [];
        for (const run of shown) {
            const card = el('div', 'card compact exp-run-card');
            const head = el('div', 'card-row');
            const merc = run.mercenary && run.mercenary.callsign;
            head.appendChild(el('span', 'card-label',
                `${merc ? escape(merc) + ' · ' : ''}${escape(run.locationName || '')}${run.zoneName ? ' · ' + escape(run.zoneName) : ''}`));
            head.appendChild(el('span', `pill ${outcomePill(run.outcome || run.status)}`, escape(run.outcome || run.status || '?')));
            card.appendChild(head);

            const meta = [];
            if (run.objectiveName) meta.push(escape(run.objectiveName));
            if (run.riskScore != null) meta.push(`risk ${run.riskScore}`);
            if (run.totalCost != null) meta.push(`${num(run.totalCost)} CR`);
            const lootCount = Array.isArray(run.containerData) ? run.containerData.length : 0;
            if (lootCount) meta.push(`📦 ${lootCount}`);
            if (meta.length) card.appendChild(el('div', 'muted xs mt-sm', meta.join(' · ')));

            const toggle = el('button', 'btn small mt-sm', 'Details');
            toggle.dataset.toggleRun = '1';
            card.appendChild(toggle);

            const detail = el('div', 'exp-run-detail');
            // costs
            const costs = [];
            if (run.prepaymentAmount != null) costs.push(`deposit ${num(run.prepaymentAmount)}`);
            if (run.remainingAmount != null) costs.push(`postpay ${num(run.remainingAmount)}`);
            if (run.reputationDelta != null) costs.push(`rep ${run.reputationDelta > 0 ? '+' : ''}${run.reputationDelta}`);
            if (costs.length) detail.appendChild(el('div', 'xs muted mt-sm', costs.join(' · ')));
            // loot
            if (lootCount) {
                detail.appendChild(el('div', 'xs mt-sm', '<strong>Loot</strong>'));
                for (const it of run.containerData) {
                    detail.appendChild(el('div', 'xs muted', `• ${escape(it.name || '?')} (${escape(it.tier || '')}) x${it.quantity || 1}`));
                }
            }
            // timeline / decisions
            const tl = Array.isArray(run.timelineEvents) ? run.timelineEvents
                : (Array.isArray(run.messages) ? run.messages.map((m) => ({ type: m.messageType, content: m.content, selectedOption: m.selectedOption, isAutoResolved: m.isAutoResolved })) : []);
            if (tl.length) {
                detail.appendChild(el('div', 'xs mt-sm', '<strong>Timeline</strong>'));
                for (const ev of tl) {
                    const dec = ev.selectedOption ? ` → ${escape(ev.selectedOption)}${ev.isAutoResolved ? ' (auto)' : ''}` : '';
                    detail.appendChild(el('div', 'xs muted', `• [${escape(ev.type || '')}] ${escape((ev.content || '').slice(0, 90))}${dec}`));
                }
            }
            card.appendChild(detail);
            cards.push(card);
        }
        if (!panel.recent.showAll && list.length > PAGE) {
            const more = el('button', 'btn small btn-block mt-sm', `Show all (${list.length})`);
            more.dataset.showAll = '1';
            cards.push(more);
        }
        panel.recent.listHost.replaceChildren(...cards);
    }

    async function refreshAll() {
        await Promise.all([
            refreshMaster(), refreshAutoSend(), refreshAutoChoose(),
            refreshActive(), refreshPending(), refreshRoster(), refreshStash(), refreshRecent(),
        ]);
    }

    // ─── Lifecycle ────────────────────────────────────────────────────────
    let unsubLocal = null, unsubSync = null;

    root.COR3.ui.expeditions = {
        mount(container) {
            unsubLocal = Store.local.onChanged((changes) => {
                if (!container.classList.contains('active')) return;
                if (changes[C.STORAGE_LOCAL.EXPEDITIONS]) { refreshActive(); refreshAutoSend(); refreshRoster(); }
                if (changes[C.STORAGE_LOCAL.ARCHIVED_EXPEDITIONS]) refreshRecent();
                if (changes[C.STORAGE_LOCAL.DECISIONS]) refreshPending();
                if (changes[C.STORAGE_LOCAL.MERCENARIES] || changes[C.STORAGE_LOCAL.MERC_CONFIG]) refreshRoster();
                if (changes[C.STORAGE_LOCAL.STASH]) refreshStash();
                if (changes[C.STORAGE_LOCAL.PROFILE] || changes[C.STORAGE_LOCAL.EXP_AUTOSEND_STATE]) refreshAutoSend();
            });
            unsubSync = Store.sync.onChanged((changes) => {
                if (!container.classList.contains('active')) return;
                if (changes[C.STORAGE_SYNC.EXPEDITIONS_SETTINGS]) { refreshMaster(); refreshAutoSend(); }
                if (changes[C.STORAGE_SYNC.AUTO_CHOOSE_ENABLED] || changes[C.STORAGE_SYNC.RISK_THRESHOLD]) refreshAutoChoose();
            });
        },
        async activate(container) {
            build(container);
            await refreshAll();
            // seed a fresh profile balance + mercenary/config snapshot on open.
            sendToContent('requestProfile');
            sendToContent('requestExpeditions');
        },
        deactivate() { tearDown(); },
    };
})();
