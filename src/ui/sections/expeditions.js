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
    const t = (k, vars) => root.COR3.i18n.t(k, vars);

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

    const DEFAULT_AUTOSEND = { enabled: false, moneyMin: 0, moneyMax: 0, minCost: 0, maxCost: 0, insurance: false, includeElite: true, marketsDisabled: [] };
    const DEFAULT_SETTINGS = { masterEnabled: false, autoSend: { ...DEFAULT_AUTOSEND }, disabledReason: null };
    async function getSettings() {
        const s = await Store.sync.getOne(C.STORAGE_SYNC.EXPEDITIONS_SETTINGS, null);
        if (!s) return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
        s.autoSend = Object.assign({ ...DEFAULT_AUTOSEND }, s.autoSend);
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
            s.autoSend = Object.assign({ ...DEFAULT_AUTOSEND }, s.autoSend, patch);
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

    // ─── Stash item sorting ───────────────────────────────────────────────
    // Preference lives in STORAGE_SYNC.EXP_STASH_SORT: { by, dir }. Every
    // sorter compares ASCENDING; `dir` flips the result. 'default' is the
    // identity comparator — Array.sort is stable, so it keeps server order.
    const STASH_SORT_FIELDS = ['default', 'name', 'price', 'tier', 'qty', 'category', 'flags', 'newest'];
    // Direction applied when the user switches TO a field (what you most
    // likely want first: expensive/rare/fresh on top, names A→Z).
    const STASH_SORT_NATURAL_DIR = {
        default: 'asc', name: 'asc', category: 'asc',
        price: 'desc', tier: 'desc', qty: 'desc', flags: 'desc', newest: 'desc',
    };
    const TIER_RANK = { COMMON: 0, UNCOMMON: 1, RARE: 2, EPIC: 3, LEGENDARY: 4, MYTHIC: 5, QUEST: 6 };
    function tierRank(item) {
        const r = TIER_RANK[String(item.tier || '').toUpperCase()];
        return r === undefined ? -1 : r;
    }
    function itemValue(item) {
        return (typeof item.sellPrice === 'number' && item.sellPrice > 0) ? item.sellPrice : (item.baseValue || 0);
    }
    // Flags weight: craftable > usable > sellable — craft is the rarest
    // and most interesting bit, so it dominates the ordering.
    function flagsRank(item) {
        return (item.canCraft ? 4 : 0) + (item.canUse ? 2 : 0) + (item.canSell ? 1 : 0);
    }
    function createdMs(item) {
        const ts = Date.parse(item.createdAt || '');
        return isNaN(ts) ? 0 : ts;
    }
    const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''));
    const STASH_SORTERS = {
        default: () => 0,
        name: byName,
        price: (a, b) => (itemValue(a) - itemValue(b)) || byName(a, b),
        tier: (a, b) => (tierRank(a) - tierRank(b)) || byName(a, b),
        qty: (a, b) => ((a.quantity || 1) - (b.quantity || 1)) || byName(a, b),
        category: (a, b) => String(a.category || '').localeCompare(String(b.category || '')) || byName(a, b),
        flags: (a, b) => (flagsRank(a) - flagsRank(b)) || byName(a, b),
        newest: (a, b) => (createdMs(a) - createdMs(b)) || byName(a, b),
    };
    // The stored object also carries view flags (hideCraft — drop items
    // usable in crafting from the list) alongside the sort: ONE storage
    // key holds all Items-list view preferences.
    async function getStashView() {
        const s = await Store.sync.getOne(C.STORAGE_SYNC.EXP_STASH_SORT, null);
        const hideCraft = !!(s && s.hideCraft);
        if (!s || !STASH_SORT_FIELDS.includes(s.by)) return { by: 'default', dir: 'asc', hideCraft };
        return { by: s.by, dir: s.dir === 'asc' ? 'asc' : 'desc', hideCraft };
    }
    function sortStashItems(items, sort) {
        const cmp = STASH_SORTERS[sort.by];
        const mul = sort.dir === 'desc' ? -1 : 1;
        return items.slice().sort((a, b) => mul * cmp(a, b));
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
            autoSend: { input: null, minMaxRow: null, minInput: null, maxInput: null, maxCostRow: null, minCostInput: null, maxCostInput: null, insuranceRow: null, insuranceHint: null, insuranceInput: null, eliteRow: null, eliteInput: null, marketsRow: null, marketToggles: {}, status: null, warn: null },
            autoChoose: { enabledInput: null, sliderInput: null, label: null },
            active: { listHost: null, timers: [] },
            pending: { title: null, listHost: null, timers: [] },
            markets: { host: null },
            stash: { capacityText: null, bar: null, itemsHead: null, itemsTitle: null, sortSelect: null, sortDir: null, hideCraft: null, itemsHost: null },
            recent: { listHost: null, showAll: false, collapsed: true, caret: null },
        };

        // ─── Master switch ────────────────────────────────────────────
        container.appendChild(el('div', 'section-title', t('expeditions.section.automation')));
        const mCard = el('div', 'card');
        const mRow = el('div', 'card-row');
        mRow.appendChild(el('span', 'card-label', t('expeditions.master.label')));
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
        container.appendChild(el('div', 'section-title', t('expeditions.section.autoSend')));
        const asCard = el('div', 'card');
        const asRow = el('div', 'card-row');
        asRow.appendChild(el('span', 'card-label', t('expeditions.autoSend.byBalance')));
        const asSw = el('label', 'switch');
        const asInput = document.createElement('input');
        asInput.type = 'checkbox';
        asSw.appendChild(asInput); asSw.appendChild(el('span', 'switch-slider'));
        asRow.appendChild(asSw);
        asCard.appendChild(asRow);

        // Money Min / Max inputs (hidden until enabled)
        const mmRow = el('div', 'exp-minmax mt-sm');
        const minWrap = el('label', 'exp-minmax-field');
        minWrap.appendChild(el('span', 'card-label', t('expeditions.autoSend.moneyMin')));
        const minInput = document.createElement('input');
        minInput.type = 'number'; minInput.min = '0'; minInput.className = 'exp-num'; minInput.placeholder = '0';
        minWrap.appendChild(minInput);
        const maxWrap = el('label', 'exp-minmax-field');
        maxWrap.appendChild(el('span', 'card-label', t('expeditions.autoSend.moneyMax')));
        const maxInput = document.createElement('input');
        maxInput.type = 'number'; maxInput.min = '0'; maxInput.className = 'exp-num'; maxInput.placeholder = '0';
        maxWrap.appendChild(maxInput);
        mmRow.appendChild(minWrap); mmRow.appendChild(maxWrap);
        asCard.appendChild(mmRow);

        // Min/Max cost per merc (skip a merc whose totalCost is outside the
        // band; 0/empty = that side of the band is off). Hint stacks below.
        const mcRow = el('div', 'mt-sm');
        const mcPair = el('div', 'exp-minmax');
        const minCostWrap = el('label', 'exp-minmax-field');
        minCostWrap.appendChild(el('span', 'card-label', t('expeditions.autoSend.minCost')));
        const minCostInput = document.createElement('input');
        minCostInput.type = 'number'; minCostInput.min = '0'; minCostInput.className = 'exp-num'; minCostInput.placeholder = '0';
        minCostWrap.appendChild(minCostInput);
        const mcWrap = el('label', 'exp-minmax-field');
        mcWrap.appendChild(el('span', 'card-label', t('expeditions.autoSend.maxCost')));
        const maxCostInput = document.createElement('input');
        maxCostInput.type = 'number'; maxCostInput.min = '0'; maxCostInput.className = 'exp-num'; maxCostInput.placeholder = '0';
        mcWrap.appendChild(maxCostInput);
        mcPair.appendChild(minCostWrap); mcPair.appendChild(mcWrap);
        mcRow.appendChild(mcPair);
        asCard.appendChild(mcRow);
        const mcHint = el('div', 'muted xs mt-sm', t('expeditions.autoSend.costHint'));
        mcRow.appendChild(mcHint);

        // Insurance + elite-pool switches.
        const insRow = el('div', 'card-row mt-sm');
        insRow.appendChild(el('span', 'card-label', t('expeditions.autoSend.insurance')));
        const insSw = el('label', 'switch');
        const insInput = document.createElement('input');
        insInput.type = 'checkbox';
        insSw.appendChild(insInput); insSw.appendChild(el('span', 'switch-slider'));
        insRow.appendChild(insSw);
        asCard.appendChild(insRow);
        const insHint = el('div', 'muted xs mt-sm', t('expeditions.autoSend.insuranceHint'));
        asCard.appendChild(insHint);

        const elRow = el('div', 'card-row mt-sm');
        elRow.appendChild(el('span', 'card-label', t('expeditions.autoSend.includeElite')));
        const elSw = el('label', 'switch');
        const elInput = document.createElement('input');
        elInput.type = 'checkbox';
        elSw.appendChild(elInput); elSw.appendChild(el('span', 'switch-slider'));
        elRow.appendChild(elSw);
        asCard.appendChild(elRow);

        // Per-market on/off — which markets auto-send may draw mercs from.
        const mkRow = el('div', 'mt-sm');
        mkRow.appendChild(el('span', 'card-label', t('expeditions.autoSend.markets')));
        const mkChips = el('div', 'exp-market-toggles mt-sm');
        const marketToggles = {};
        const commitMarkets = () => {
            const disabled = [];
            for (const m of MARKETS) {
                const cb = marketToggles[m.id];
                if (cb && !cb.checked) disabled.push(m.id);
            }
            patchAutoSend({ marketsDisabled: disabled });
        };
        for (const m of MARKETS) {
            const lab = el('label', 'exp-market-chip');
            const cb = document.createElement('input');
            cb.type = 'checkbox'; cb.dataset.market = m.id;
            cb.addEventListener('change', commitMarkets);
            lab.appendChild(cb);
            lab.appendChild(el('span', '', escape(m.label)));
            mkChips.appendChild(lab);
            marketToggles[m.id] = cb;
        }
        mkRow.appendChild(mkChips);
        asCard.appendChild(mkRow);

        const asStatus = el('div', 'exp-status mt-sm', '');
        asCard.appendChild(asStatus);
        const asWarn = el('div', 'warn sm mt-sm', '');
        asWarn.style.display = 'none';
        asCard.appendChild(asWarn);
        container.appendChild(asCard);

        asInput.addEventListener('change', (e) => patchAutoSend({ enabled: e.target.checked }));
        const commitNum = (input, field) => () => patchAutoSend({ [field]: Math.max(0, Math.floor(Number(input.value) || 0)) });
        minInput.addEventListener('change', commitNum(minInput, 'moneyMin'));
        maxInput.addEventListener('change', commitNum(maxInput, 'moneyMax'));
        minCostInput.addEventListener('change', commitNum(minCostInput, 'minCost'));
        maxCostInput.addEventListener('change', commitNum(maxCostInput, 'maxCost'));
        insInput.addEventListener('change', (e) => patchAutoSend({ insurance: e.target.checked }));
        elInput.addEventListener('change', (e) => patchAutoSend({ includeElite: e.target.checked }));
        panel.autoSend = {
            input: asInput, minMaxRow: mmRow, minInput, maxInput,
            maxCostRow: mcRow, minCostInput, maxCostInput,
            insuranceRow: insRow, insuranceHint: insHint, insuranceInput: insInput,
            eliteRow: elRow, eliteInput: elInput,
            marketsRow: mkRow, marketToggles, status: asStatus, warn: asWarn,
        };

        // ─── Auto-choose decision ─────────────────────────────────────
        container.appendChild(el('div', 'section-title', t('expeditions.section.autoChoose')));
        const acCard = el('div', 'card');
        const acRow = el('div', 'card-row');
        acRow.appendChild(el('span', 'card-label', t('expeditions.autoChoose.enabled')));
        const acSw = el('label', 'switch');
        const acInput = document.createElement('input');
        acInput.type = 'checkbox';
        acSw.appendChild(acInput); acSw.appendChild(el('span', 'switch-slider'));
        acRow.appendChild(acSw);
        acCard.appendChild(acRow);
        const rtRow = el('div', 'card-row mt-sm');
        rtRow.appendChild(el('span', 'card-label', t('expeditions.autoChoose.riskThreshold')));
        const rtLabel = el('span', 'mono', '5');
        rtRow.appendChild(rtLabel);
        acCard.appendChild(rtRow);
        const rtSlider = document.createElement('input');
        rtSlider.type = 'range'; rtSlider.min = '0'; rtSlider.max = '10'; rtSlider.step = '1'; rtSlider.className = 'mt-sm';
        acCard.appendChild(rtSlider);
        acCard.appendChild(el('div', 'muted xs mt-sm', t('expeditions.autoChoose.riskHint')));
        container.appendChild(acCard);
        acInput.addEventListener('change', (e) => Store.sync.setOne(C.STORAGE_SYNC.AUTO_CHOOSE_ENABLED, e.target.checked));
        rtSlider.addEventListener('input', (e) => { rtLabel.textContent = e.target.value; });
        rtSlider.addEventListener('change', (e) => Store.sync.setOne(C.STORAGE_SYNC.RISK_THRESHOLD, Number(e.target.value)));
        panel.autoChoose = { enabledInput: acInput, sliderInput: rtSlider, label: rtLabel };

        // ─── Active expedition ────────────────────────────────────────
        const aHead = el('div', 'row between mt-md');
        aHead.appendChild(el('div', 'section-title', t('expeditions.section.active')));
        const aRefresh = el('button', 'btn small', t('common.refresh'));
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
        const pTitle = el('div', 'section-title', t('expeditions.section.pending'));
        pTitle.style.display = 'none';
        container.appendChild(pTitle);
        const pHost = el('div');
        container.appendChild(pHost);
        panel.pending.title = pTitle;
        panel.pending.listHost = pHost;

        // ─── Markets & mercenaries ────────────────────────────────────
        // One block per market — each market is its own faction with distinct
        // reputation, regular + elite mercs, and hire slots (verified live).
        const mHead = el('div', 'row between mt-md');
        mHead.appendChild(el('div', 'section-title', t('expeditions.section.markets')));
        const mRefresh = el('button', 'btn small', t('common.refresh'));
        mRefresh.addEventListener('click', () => {
            sendToContent('requestAllMercenaries');
            sendToContent('requestAllExpeditionConfigs');
            sendToContent('requestProfile');
        });
        mHead.appendChild(mRefresh);
        container.appendChild(mHead);
        const mHost = el('div');
        container.appendChild(mHost);
        mHost.addEventListener('click', (e) => {
            const b = e.target.closest('button[data-send]');
            if (!b || b.disabled) return;
            sendToContent('sendMercNow', { mercenaryId: b.dataset.send, marketId: b.dataset.market });
            b.disabled = true; b.textContent = t('expeditions.markets.sending');
        });
        panel.markets = { host: mHost };

        // ─── Stash ────────────────────────────────────────────────────
        const sHead = el('div', 'row between mt-md');
        sHead.appendChild(el('div', 'section-title', t('expeditions.section.stash')));
        const sRefresh = el('button', 'btn small', t('common.refresh'));
        sRefresh.addEventListener('click', () => sendToContent('requestStash'));
        sHead.appendChild(sRefresh);
        container.appendChild(sHead);
        const sCard = el('div', 'card');
        const sCapRow = el('div', 'card-row');
        sCapRow.appendChild(el('span', 'card-label', t('expeditions.stash.capacity')));
        const sCapText = el('span', '', '');
        sCapRow.appendChild(sCapText);
        sCard.appendChild(sCapRow);
        const sBarOuter = el('div', 'exp-bar mt-sm');
        const sBar = el('div', 'exp-bar-fill');
        sBarOuter.appendChild(sBar);
        sCard.appendChild(sBarOuter);
        container.appendChild(sCard);
        // Items header: title + sort controls. Hidden as a whole while the
        // stash is empty (mirrors the old single-title behaviour).
        const itemsHead = el('div', 'row between mt-md');
        itemsHead.style.display = 'none';
        const itemsTitle = el('div', 'section-title', '');
        itemsHead.appendChild(itemsTitle);
        const sortWrap = el('div', 'exp-sort');
        sortWrap.title = t('expeditions.stash.sortLabel');
        const sortSelect = document.createElement('select');
        sortSelect.className = 'exp-sort-select';
        for (const field of STASH_SORT_FIELDS) {
            const opt = document.createElement('option');
            opt.value = field;
            opt.textContent = t('expeditions.stash.sort.' + field);
            sortSelect.appendChild(opt);
        }
        const sortDir = el('button', 'btn small exp-sort-dir', '▼');
        sortDir.title = t('expeditions.stash.sortDirTip');
        const hideCraftLab = el('label', 'exp-sort-hide');
        hideCraftLab.title = t('expeditions.stash.hideCraft');
        const hideCraftCb = document.createElement('input');
        hideCraftCb.type = 'checkbox';
        hideCraftLab.appendChild(hideCraftCb);
        hideCraftLab.appendChild(el('span', '', escape(t('expeditions.stash.hideCraftShort'))));
        sortWrap.appendChild(sortSelect);
        sortWrap.appendChild(sortDir);
        sortWrap.appendChild(hideCraftLab);
        itemsHead.appendChild(sortWrap);
        container.appendChild(itemsHead);
        // Writes go through storage (read-modify-write — each control only
        // touches its own fields); the sync onChanged listener re-renders,
        // so popout + popup stay in lockstep.
        const patchStashView = async (patch) => {
            const v = await getStashView();
            Store.sync.setOne(C.STORAGE_SYNC.EXP_STASH_SORT, Object.assign(v, patch));
        };
        sortSelect.addEventListener('change', () => {
            const by = sortSelect.value;
            patchStashView({ by, dir: STASH_SORT_NATURAL_DIR[by] });
        });
        sortDir.addEventListener('click', async () => {
            const v = await getStashView();
            patchStashView({ dir: v.dir === 'asc' ? 'desc' : 'asc' });
        });
        hideCraftCb.addEventListener('change', (e) => patchStashView({ hideCraft: e.target.checked }));
        const itemsHost = el('div', 'exp-item-grid');
        container.appendChild(itemsHost);
        itemsHost.addEventListener('click', (e) => {
            const b = e.target.closest('button[data-item-act]');
            if (!b || b.disabled) return;
            const itemId = b.dataset.item;
            const name = b.dataset.name || t('expeditions.stash.thisItem');
            if (b.dataset.itemAct === 'sell') {
                sendToContent('sellItem', { itemId, quantity: 1 });
                b.disabled = true;
            } else if (b.dataset.itemAct === 'delete') {
                if (window.confirm(t('expeditions.stash.throwConfirm', { name }))) {
                    sendToContent('deleteItem', { itemId, quantity: 1 });
                    b.disabled = true;
                }
            }
        });
        panel.stash = { capacityText: sCapText, bar: sBar, itemsHead, itemsTitle, sortSelect, sortDir, hideCraft: hideCraftCb, itemsHost };

        // ─── Recent runs (collapsible — collapsed by default) ─────────
        const recHead = el('div', 'row between mt-md');
        const recTitle = el('div', 'section-title exp-collapsible');
        const recCaret = el('span', 'exp-caret', '▸');
        recTitle.appendChild(recCaret);
        recTitle.appendChild(document.createTextNode(' ' + t('expeditions.section.recent')));
        recTitle.addEventListener('click', () => setRecentCollapsed(!panel.recent.collapsed));
        recHead.appendChild(recTitle);
        const recRefresh = el('button', 'btn small', t('common.refresh'));
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
        n.maxCostRow.style.display = enabled ? '' : 'none';
        n.eliteRow.style.display = enabled ? '' : 'none';
        n.marketsRow.style.display = enabled ? '' : 'none';
        // Insurance governs EVERY plugin launch (auto-send AND the manual
        // "Send now" buttons), so it stays visible even with auto-send off.
        if (document.activeElement !== n.minInput) n.minInput.value = (s.autoSend.moneyMin || 0) || '';
        if (document.activeElement !== n.maxInput) n.maxInput.value = (s.autoSend.moneyMax || 0) || '';
        if (document.activeElement !== n.minCostInput) n.minCostInput.value = (s.autoSend.minCost || 0) || '';
        if (document.activeElement !== n.maxCostInput) n.maxCostInput.value = (s.autoSend.maxCost || 0) || '';
        const insured = !!s.autoSend.insurance;
        if (n.insuranceInput.checked !== insured) n.insuranceInput.checked = insured;
        const eliteOn = s.autoSend.includeElite !== false;
        if (n.eliteInput.checked !== eliteOn) n.eliteInput.checked = eliteOn;
        // Per-market toggles: checked === enabled (absent from marketsDisabled).
        const disabledSet = new Set(Array.isArray(s.autoSend.marketsDisabled) ? s.autoSend.marketsDisabled : []);
        for (const id of Object.keys(n.marketToggles)) {
            const cb = n.marketToggles[id];
            const on = !disabledSet.has(id);
            if (cb.checked !== on) cb.checked = on;
        }

        const bal = profile && typeof profile.balance === 'number' ? profile.balance : null;
        const balTxt = bal != null ? `${num(bal)} CR` : '—';
        if (enabled) {
            const armed = state && state.armed;
            const st = (state && state.status) || t('expeditions.autoSend.starting');
            n.status.innerHTML = `${escape(t('expeditions.autoSend.balance'))}: <span class="mono">${balTxt}</span> · `
                + `<span class="${armed ? 'exp-armed' : 'muted'}">${escape(st)}</span>`;
            n.status.style.display = '';
        } else {
            n.status.style.display = 'none';
        }
        if (s.disabledReason) {
            n.warn.textContent = t('expeditions.autoSend.paused', { reason: s.disabledReason.replace(/_/g, ' ') });
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
            panel.active.listHost.replaceChildren(el('div', 'empty', t('expeditions.active.empty')));
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
            const goalNm = exp.goalName || exp.objectiveName;
            if (goalNm) meta.push(escape(goalNm));
            if (exp.riskScore != null) meta.push(t('expeditions.active.risk', { n: exp.riskScore }));
            if (exp.totalCost != null) meta.push(`${num(exp.totalCost)} CR`);
            if (meta.length) card.appendChild(el('div', 'muted xs mt-sm', meta.join(' · ')));

            if (exp.status !== 'COMPLETED' && exp._timerPreparing) {
                card.appendChild(el('div', 'muted xs mt-sm', t('expeditions.active.preparing')));
            } else if (exp.status !== 'COMPLETED') {
                // _timerFrozenMs/_timerEndMs are stamped by the expeditions data
                // module (run clock starts at departure + accrues EVENT-pause, so
                // it matches the in-game countdown).
                const frozen = (typeof exp._timerFrozenMs === 'number') ? exp._timerFrozenMs : null;
                const endMs = (typeof exp._timerEndMs === 'number') ? exp._timerEndMs : expEndMs(exp);
                if (frozen != null || endMs) {
                    const tRow = el('div', 'card-row mt-sm');
                    tRow.appendChild(el('span', 'sm muted', frozen != null ? t('expeditions.active.pausedDecision') : t('expeditions.active.eta')));
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
                    const b = el('button', 'btn small btn-success', t('expeditions.active.openContainer'));
                    b.dataset.act = 'open'; b.dataset.exp = exp.id;
                    actRow.appendChild(b);
                } else if (uncollected) {
                    const b = el('button', 'btn small btn-success', t('expeditions.active.collectAll'));
                    b.dataset.act = 'collect'; b.dataset.exp = exp.id;
                    actRow.appendChild(b);
                } else if (opened) {
                    actRow.appendChild(el('span', 'pill ok', t('expeditions.active.collected')));
                }
                card.appendChild(actRow);
            }
            cards.push(card);
        }
        panel.active.listHost.replaceChildren(...cards);
    }

    async function refreshPending() {
        if (!panel) return;
        const [decisions, threshold] = await Promise.all([
            Store.local.getOne(C.STORAGE_LOCAL.DECISIONS, []),
            Store.sync.getOne(C.STORAGE_SYNC.RISK_THRESHOLD, 5),
        ]);
        const pending = (decisions || []).filter((d) => !d.isResolved && Array.isArray(d.decisionOptions));
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
            // Per-option score from the SHARED formula (exp-decision-score.js) —
            // the ✓-highlighted option is EXACTLY what auto-choose would answer
            // at the current Risk-threshold slider position.
            const { best, scores } = root.COR3.expDecision.pick(d.decisionOptions, threshold);
            d.decisionOptions.forEach((opt, i) => {
                const parts = [];
                if (opt.riskModifier) parts.push(t('expeditions.pending.risk', { n: `${opt.riskModifier > 0 ? '+' : ''}${opt.riskModifier}` }));
                if (opt.lootModifier) parts.push(t('expeditions.pending.loot', { n: `${opt.lootModifier > 0 ? '+' : ''}${opt.lootModifier}` }));
                parts.push(t('expeditions.pending.score', { n: `${scores[i] > 0 ? '+' : ''}${scores[i]}` }));
                const isBest = opt === best;
                const btn = el('button', 'btn small mt-sm btn-block' + (isBest ? ' btn-success' : ''),
                    `${escape(opt.label || opt.id)} — ${parts.join(', ')}${isBest ? ' ✓' : ''}`);
                if (isBest) btn.title = t('expeditions.pending.autoPick');
                btn.addEventListener('click', () => sendToContent('respondDecision', {
                    expeditionId: d.expeditionId, messageId: d.messageId, selectedOption: opt.id,
                }));
                card.appendChild(btn);
            });
            cards.push(card);
        }
        panel.pending.listHost.replaceChildren(...cards);
    }

    // Markets, in registry order, from the shared C.MARKETS source of truth.
    // Each is its own faction (distinct rep + elite mercs). Future/unknown
    // markets present in the data map are appended after these.
    const MARKETS = (C.MARKETS || []).map((m) => ({ id: m.id, label: `${m.key.toUpperCase()} · ${m.label}` }));

    // Shared cost/risk stat line for merc cards. When the cost preview was
    // priced WITH insurance (cfg._insured), the total already includes the
    // premium — surface it with a 🛡 chip.
    function costRiskStat(cfg) {
        const stat = [];
        if (cfg.totalCost != null) stat.push(`💸 ${num(cfg.totalCost)} (${t('expeditions.markets.deposit', { n: num(cfg.prepaymentAmount) })})`);
        if (cfg._insured && cfg.insuranceCost != null) stat.push(`🛡 ${t('expeditions.markets.insured', { n: num(cfg.insuranceCost) })}`);
        if (cfg.riskScore != null) stat.push(`⚠ ${t('expeditions.markets.risk', { n: cfg.riskScore })}${cfg.riskLevel ? ' (' + escape(cfg.riskLevel) + ')' : ''}`);
        if (cfg.outcomeChances && cfg.outcomeChances.fullSuccessChance != null) stat.push(`✓ ${cfg.outcomeChances.fullSuccessChance}%`);
        return stat.join(' · ');
    }

    // A regular (hireable) mercenary card. `hasActive` disables "Send now" while
    // an expedition is already running (max 1 at a time).
    function mercCardEl(m, cfg, hasActive, marketId) {
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
            `${escape(m.specializationName || m.specialization || '')} · ${escape(m.rank || '')} · ${t('expeditions.markets.raids', { n: m.missionsCompleted || 0 })}`));
        const traits = [];
        if (m.specializationDescription) traits.push(escape(m.specializationDescription));
        if (m.traitName) traits.push(`<strong>${escape(m.traitName)}</strong>: ${escape(m.traitDescription || '')}`);
        if (traits.length) body.appendChild(el('div', 'xs muted mt-sm', traits.join(' · ')));
        if (cfg && (cfg.totalCost != null || cfg.riskScore != null)) {
            body.appendChild(el('div', 'xs mt-sm', costRiskStat(cfg)));
        }
        if (m.reputationRequirement != null) body.appendChild(el('div', 'xs muted mt-sm', t('expeditions.markets.repReq', { n: m.reputationRequirement })));
        card.appendChild(body);
        const canSend = avail && !hasActive;
        const label = !avail ? (m.status === 'RESTING' ? t('expeditions.markets.resting') : t('expeditions.markets.busy')) : (hasActive ? t('expeditions.markets.busy') : t('expeditions.markets.sendNow'));
        const btn = el('button', 'btn small', label);
        btn.dataset.send = m.id;
        if (marketId) btn.dataset.market = marketId;
        if (!canSend) btn.disabled = true;
        if (avail && hasActive) btn.title = t('expeditions.markets.alreadyRunning');
        card.appendChild(btn);
        return card;
    }

    // An ELITE mercenary card — eliteConfigId/state + unlock (faction-rep
    // level + side quest) and the player's current progress. An UNLOCKED slot
    // embeds a full standard `mercenary` object that hires/launches through
    // the ordinary configure/launch RPCs (verified live 2026-07-05), so it
    // gets the same cost/risk line + "Send now" button as a regular merc.
    function eliteCardEl(e, cfg, hasActive, marketId) {
        const info = e.info || {};
        const em = (e.state === 'UNLOCKED' && e.mercenary) ? e.mercenary : null;
        const avail = !!(em && em.status === 'AVAILABLE');
        const card = el('div', 'exp-merc-card' + (avail ? '' : ' unavail'));
        const av = document.createElement('img');
        av.className = 'exp-avatar'; av.src = e.avatarSeed || ''; av.alt = e.callsign || '';
        av.referrerPolicy = 'no-referrer'; av.loading = 'lazy';
        card.appendChild(av);
        const body = el('div', 'exp-merc-body');
        const nameRow = el('div', 'exp-merc-namerow');
        nameRow.appendChild(el('span', 'exp-merc-name', `★ ${escape(e.callsign || '?')}`));
        // The slot state stays UNLOCKED even while the elite is on a raid — the
        // embedded merc's status (AVAILABLE/CONTRACTED/RESTING) is the live one.
        const pillText = em ? em.status : String(e.state || 'ELITE');
        const pillCls = avail ? 'ok' : (em ? 'active' : (e.state === 'QUEST_IN_PROGRESS' ? 'warn' : 'idle'));
        nameRow.appendChild(el('span', `pill ${pillCls}`, escape(pillText.replace(/_/g, ' '))));
        body.appendChild(nameRow);
        const rankBits = [escape(info.specializationName || e.specialization || '')];
        if (em && em.rank) rankBits.push(escape(em.rank));
        if (em && em.missionsCompleted != null) rankBits.push(t('expeditions.markets.raids', { n: em.missionsCompleted }));
        else if (info.traitName || e.trait) rankBits.push(escape(info.traitName || e.trait));
        body.appendChild(el('div', 'sm muted', rankBits.filter(Boolean).join(' · ')));
        const traits = [];
        if (info.specializationDescription) traits.push(escape(info.specializationDescription));
        if (info.traitName) traits.push(`<strong>${escape(info.traitName)}</strong>: ${escape(info.traitDescription || '')}`);
        if (traits.length) body.appendChild(el('div', 'xs muted mt-sm', traits.join(' · ')));
        if (em && cfg && (cfg.totalCost != null || cfg.riskScore != null)) {
            body.appendChild(el('div', 'xs mt-sm', costRiskStat(cfg)));
        }
        if (!em) {
            const u = e.unlock || {}, p = e.progress || {};
            const reqs = [];
            if (u.requiredFactionReputationLevel != null) {
                const have = p.factionReputationLevel;
                const ok = (have != null && have >= u.requiredFactionReputationLevel);
                reqs.push(t('expeditions.markets.factionRep', { n: u.requiredFactionReputationLevel }) + `${have != null ? ` (${have}${ok ? ' ✓' : ' ✗'})` : ''}`);
            }
            if (u.sideQuestId != null) reqs.push(`${t('expeditions.markets.sideQuest')} ${p.sideQuestCompleted ? t('expeditions.markets.questDone') + ' ✓' : t('expeditions.markets.questInProgress') + ' ✗'}`);
            if (reqs.length) body.appendChild(el('div', 'xs mt-sm', t('expeditions.markets.unlock') + reqs.join(' · ')));
        }
        card.appendChild(body);
        if (em) {
            const canSend = avail && !hasActive;
            const label = !avail ? (em.status === 'RESTING' ? t('expeditions.markets.resting') : t('expeditions.markets.busy')) : (hasActive ? t('expeditions.markets.busy') : t('expeditions.markets.sendNow'));
            const btn = el('button', 'btn small', label);
            btn.dataset.send = em.id;
            if (marketId) btn.dataset.market = marketId;
            if (!canSend) btn.disabled = true;
            if (avail && hasActive) btn.title = t('expeditions.markets.alreadyRunning');
            card.appendChild(btn);
        }
        return card;
    }

    // One market block: header (faction rep + trust), a stats line + score
    // breakdown (the "history of reputation"), then regular + elite merc cards.
    function marketBlockEl(market, data, configs, hasActive) {
        const userRep = data && data.userReputation;
        const mercRep = data && data.mercenaryReputation;
        const slots = data && data.hireSlots;
        const regulars = (data && Array.isArray(data.mercenaries)) ? data.mercenaries : [];
        const elites = (data && Array.isArray(data.eliteSlots)) ? data.eliteSlots : [];

        const block = el('div', 'card mt-sm');
        const head = el('div', 'card-row');
        head.appendChild(el('span', 'card-label', escape(market.label)));
        if (userRep && userRep.level != null) head.appendChild(el('span', 'pill active', t('expeditions.markets.rep', { n: num(userRep.level) })));
        if (mercRep && mercRep.trustLevel) head.appendChild(el('span', 'pill ok', escape(String(mercRep.trustLevel).replace(/_/g, ' '))));
        block.appendChild(head);

        const bits = [];
        if (userRep && userRep.score != null) bits.push(t('expeditions.markets.faction', { n: userRep.score }));
        if (mercRep && mercRep.score != null) bits.push(t('expeditions.markets.trust', { n: mercRep.score }));
        if (mercRep && mercRep.hireCostMultiplier != null) bits.push(t('expeditions.markets.hire', { n: mercRep.hireCostMultiplier }));
        if (mercRep && mercRep.successfulRuns != null) bits.push(t('expeditions.markets.runs', { n: mercRep.successfulRuns }));
        if (slots && slots.maxMercenaries != null) bits.push(t('expeditions.markets.slots', { n: slots.maxMercenaries }));
        if (bits.length) block.appendChild(el('div', 'xs muted mt-sm', bits.join(' · ')));

        const b = mercRep && mercRep.breakdown;
        if (b && typeof b === 'object') {
            const LBL = {
                factionReputationComponent: t('expeditions.markets.bdFaction'),
                successfulRunsBonus: t('expeditions.markets.bdRuns'),
                deathPenalty: t('expeditions.markets.bdDeaths'),
                peakScore: t('expeditions.markets.bdPeak'),
                floor: t('expeditions.markets.bdFloor'),
            };
            const parts = [];
            for (const k of Object.keys(b)) if (typeof b[k] === 'number' && LBL[k]) parts.push(`${LBL[k]} ${b[k] > 0 ? '+' : ''}${b[k]}`);
            if (parts.length) block.appendChild(el('div', 'xs muted mt-sm', t('expeditions.markets.breakdown') + ' ' + parts.join(' · ')));
        }

        // buyable hire-slot pools (gated by mercenary reputation)
        const pools = (slots && Array.isArray(slots.pools)) ? slots.pools.filter((p) => !p.isPurchased) : [];
        for (const p of pools) {
            const req = p.unlockConditions && p.unlockConditions.requiredMercenaryReputation;
            const parts = [t('expeditions.markets.slotPlus', { n: p.slots })];
            if (p.price != null) parts.push(`${num(p.price)} CR`);
            if (req != null) parts.push(t('expeditions.markets.reqRep', { n: req }));
            parts.push(p.canPurchase ? t('expeditions.markets.available') : t('expeditions.markets.locked'));
            block.appendChild(el('div', 'xs ' + (p.canPurchase ? '' : 'muted'), `• ${t('expeditions.markets.slotPool')}: ${parts.join(' · ')}`));
        }

        if (regulars.length) {
            const wrap = el('div', 'mt-sm');
            for (const m of regulars) wrap.appendChild(mercCardEl(m, (configs || {})[m.id] || {}, hasActive, market.id));
            block.appendChild(wrap);
        }
        if (elites.length) {
            block.appendChild(el('div', 'xs mt-sm', `<strong>${escape(t('expeditions.markets.eliteMercs'))}</strong>`));
            const wrap = el('div');
            for (const e of elites) {
                const cfg = (e.mercenary && (configs || {})[e.mercenary.id]) || {};
                wrap.appendChild(eliteCardEl(e, cfg, hasActive, market.id));
            }
            block.appendChild(wrap);
        }
        if (!regulars.length && !elites.length) {
            block.appendChild(el('div', 'xs muted mt-sm', t('expeditions.markets.noMercs')));
        }
        return block;
    }

    async function refreshMarkets() {
        if (!panel || !panel.markets) return;
        const [map, configs, exps] = await Promise.all([
            Store.local.getOne(C.STORAGE_LOCAL.MERC_MARKETS, {}),
            Store.local.getOne(C.STORAGE_LOCAL.MERC_CONFIG, {}),
            Store.local.getOne(C.STORAGE_LOCAL.EXPEDITIONS, []),
        ]);
        const hasActive = (exps || []).some((e) => e.status && e.status !== 'COMPLETED');
        const host = panel.markets.host;
        const m = map || {};
        if (!Object.keys(m).length) {
            host.replaceChildren(el('div', 'empty', t('expeditions.markets.empty')));
            return;
        }
        const blocks = [];
        for (const market of MARKETS) {
            if (m[market.id]) blocks.push(marketBlockEl(market, m[market.id], configs, hasActive));
        }
        for (const id of Object.keys(m)) {
            if (MARKETS.some((x) => x.id === id)) continue;
            blocks.push(marketBlockEl({ id, label: id }, m[id], configs, hasActive));
        }
        host.replaceChildren(...blocks);
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
            n.capacityText.textContent = t('expeditions.stash.noData');
            n.bar.style.width = '0%';
        }
        const items = (stash && Array.isArray(stash.items)) ? stash.items : [];
        if (!items.length) {
            n.itemsHead.style.display = 'none';
            n.itemsHost.replaceChildren();
            return;
        }
        n.itemsHead.style.display = '';
        const view = await getStashView();
        n.sortSelect.value = view.by;
        n.sortDir.textContent = view.dir === 'asc' ? '▲' : '▼';
        // Direction is meaningless for server order — hide (not remove) the
        // toggle so the controls don't jump around.
        n.sortDir.style.visibility = view.by === 'default' ? 'hidden' : 'visible';
        if (n.hideCraft.checked !== view.hideCraft) n.hideCraft.checked = view.hideCraft;
        const visible = view.hideCraft ? items.filter((i) => !i.canCraft) : items;
        n.itemsTitle.textContent = view.hideCraft
            ? t('expeditions.stash.itemsFiltered', { shown: visible.length, total: items.length })
            : t('expeditions.stash.items', { n: items.length });
        const cards = [];
        for (const item of sortStashItems(visible, view)) {
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
            if (item.canCraft) {
                const f = el('span', 'exp-flag exp-flag-craft', '⚒ ' + escape(t('expeditions.stash.flagCraft')));
                f.title = t('expeditions.stash.flagCraftTip');
                sub.appendChild(f);
            }
            if (item.canUse) {
                const f = el('span', 'exp-flag exp-flag-use', '▶ ' + escape(t('expeditions.stash.flagUse')));
                f.title = t('expeditions.stash.flagUseTip');
                sub.appendChild(f);
            }
            info.appendChild(sub);
            c.appendChild(info);

            const acts = el('div', 'exp-item-acts');
            if (item.canSell) {
                const b = el('button', 'btn small', t('expeditions.stash.sell'));
                b.title = item.sellPrice ? t('expeditions.stash.sellFor', { n: num(item.sellPrice) }) : t('expeditions.stash.sell');
                b.dataset.itemAct = 'sell'; b.dataset.item = item.id; b.dataset.name = item.name || '';
                acts.appendChild(b);
            }
            if (item.canDelete) {
                const b = el('button', 'btn small btn-danger', '✕');
                b.title = t('expeditions.stash.throwAway');
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
            panel.recent.listHost.replaceChildren(el('div', 'empty', t('expeditions.recent.empty')));
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
            const goalNm = run.goalName || run.objectiveName;
            if (goalNm) meta.push(escape(goalNm));
            if (run.riskScore != null) meta.push(t('expeditions.recent.risk', { n: run.riskScore }));
            if (run.totalCost != null) meta.push(`${num(run.totalCost)} CR`);
            const lootCount = Array.isArray(run.containerData) ? run.containerData.length : 0;
            if (lootCount) meta.push(`📦 ${lootCount}`);
            if (meta.length) card.appendChild(el('div', 'muted xs mt-sm', meta.join(' · ')));

            const toggle = el('button', 'btn small mt-sm', t('expeditions.recent.details'));
            toggle.dataset.toggleRun = '1';
            card.appendChild(toggle);

            const detail = el('div', 'exp-run-detail');
            // costs
            const costs = [];
            if (run.prepaymentAmount != null) costs.push(t('expeditions.recent.deposit', { n: num(run.prepaymentAmount) }));
            if (run.remainingAmount != null) costs.push(t('expeditions.recent.postpay', { n: num(run.remainingAmount) }));
            if (run.reputationDelta != null) costs.push(t('expeditions.recent.rep', { n: `${run.reputationDelta > 0 ? '+' : ''}${run.reputationDelta}` }));
            if (costs.length) detail.appendChild(el('div', 'xs muted mt-sm', costs.join(' · ')));
            // loot
            if (lootCount) {
                detail.appendChild(el('div', 'xs mt-sm', `<strong>${escape(t('expeditions.recent.loot'))}</strong>`));
                for (const it of run.containerData) {
                    detail.appendChild(el('div', 'xs muted', `• ${escape(it.name || '?')} (${escape(it.tier || '')}) x${it.quantity || 1}`));
                }
            }
            // timeline / decisions
            const tl = Array.isArray(run.timelineEvents) ? run.timelineEvents
                : (Array.isArray(run.messages) ? run.messages.map((m) => ({ type: m.messageType, content: m.content, selectedOption: m.selectedOption, isAutoResolved: m.isAutoResolved })) : []);
            if (tl.length) {
                detail.appendChild(el('div', 'xs mt-sm', `<strong>${escape(t('expeditions.recent.timeline'))}</strong>`));
                for (const ev of tl) {
                    const dec = ev.selectedOption ? ` → ${escape(ev.selectedOption)}${ev.isAutoResolved ? ' ' + t('expeditions.recent.auto') : ''}` : '';
                    detail.appendChild(el('div', 'xs muted', `• [${escape(ev.type || '')}] ${escape((ev.content || '').slice(0, 90))}${dec}`));
                }
            }
            card.appendChild(detail);
            cards.push(card);
        }
        if (!panel.recent.showAll && list.length > PAGE) {
            const more = el('button', 'btn small btn-block mt-sm', t('expeditions.recent.showAll', { n: list.length }));
            more.dataset.showAll = '1';
            cards.push(more);
        }
        panel.recent.listHost.replaceChildren(...cards);
    }

    async function refreshAll() {
        await Promise.all([
            refreshMaster(), refreshAutoSend(), refreshAutoChoose(),
            refreshActive(), refreshPending(), refreshMarkets(), refreshStash(), refreshRecent(),
        ]);
    }

    // ─── Lifecycle ────────────────────────────────────────────────────────
    let unsubLocal = null, unsubSync = null;

    root.COR3.ui.expeditions = {
        mount(container) {
            unsubLocal = Store.local.onChanged((changes) => {
                if (!container.classList.contains('active')) return;
                if (changes[C.STORAGE_LOCAL.EXPEDITIONS]) { refreshActive(); refreshAutoSend(); refreshMarkets(); }
                if (changes[C.STORAGE_LOCAL.ARCHIVED_EXPEDITIONS]) refreshRecent();
                if (changes[C.STORAGE_LOCAL.DECISIONS]) refreshPending();
                if (changes[C.STORAGE_LOCAL.MERC_MARKETS] || changes[C.STORAGE_LOCAL.MERCENARIES] || changes[C.STORAGE_LOCAL.MERC_CONFIG]) refreshMarkets();
                if (changes[C.STORAGE_LOCAL.STASH]) refreshStash();
                if (changes[C.STORAGE_LOCAL.PROFILE] || changes[C.STORAGE_LOCAL.EXP_AUTOSEND_STATE]) refreshAutoSend();
            });
            unsubSync = Store.sync.onChanged((changes) => {
                if (!container.classList.contains('active')) return;
                if (changes[C.STORAGE_SYNC.EXPEDITIONS_SETTINGS]) { refreshMaster(); refreshAutoSend(); }
                // Threshold moves also re-score the Pending list (per-option
                // score badges + the ✓ auto-pick highlight track the slider).
                if (changes[C.STORAGE_SYNC.AUTO_CHOOSE_ENABLED] || changes[C.STORAGE_SYNC.RISK_THRESHOLD]) { refreshAutoChoose(); refreshPending(); }
                if (changes[C.STORAGE_SYNC.EXP_STASH_SORT]) refreshStash();
            });
        },
        async activate(container) {
            build(container);
            await refreshAll();
            // seed fresh profile + all-market mercenaries/configs + expeditions on open.
            sendToContent('requestProfile');
            sendToContent('requestAllMercenaries');
            sendToContent('requestAllExpeditionConfigs');
            sendToContent('requestExpeditions');
        },
        deactivate() { tearDown(); },
    };
})();
