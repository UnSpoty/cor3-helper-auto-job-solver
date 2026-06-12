// src/ui/sections/overview.js
// Main dashboard. Aggregates everything that's "at-a-glance" useful:
//   • Daily Ops card — timer + one-shot "Solve" button + an "Auto" toggle on
//     the same row. Auto (AUTO_DAILY_OPS_ENABLED) hands off to the isolated
//     daily-ops watcher, which auto-solves whenever the reset timer reaches
//     00:00 or the current day is still unsolved.
//   • Markets cards (home + dark + srm + usol) — each card carries its own
//     Auto-refresh toggle
//   • Auto solvers — Auto-decrypt + Auto-ICE-Wall
//   • Game appearance — theme + system messages + background + network fog + map FX
//   • Alarms (collapsible <details>, default closed) — list + add form
//   • Versions footer (web / system)
//
// Render architecture: the DOM skeleton is built ONCE per activate() and
// kept alive while the tab is active. Sub-section refreshes mutate only the
// specific text / attribute / list nodes captured in `panel.nodes`, so a WS
// payload landing in chrome.storage doesn't cause a visible repaint of the
// whole tab. The old design did container.innerHTML='' on every Store.local
// change — with the Auto Jobs board (AJ_JOB_QUEUE) ticking each cycle, that
// produced visible flickering on a popup that nobody touched.
//
// Active expeditions and pending decisions live in the Expeditions tab.

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
    async function getCor3Tab() {
        const [t] = await chrome.tabs.query({ url: ['https://cor3.gg/*', 'https://os.cor3.gg/*'] });
        return t || null;
    }
    async function sendToContent(action, extra = {}) {
        const tab = await getCor3Tab();
        if (!tab) return;
        chrome.tabs.sendMessage(tab.id, Object.assign({ action }, extra)).catch(() => {});
    }
    function genAlarmId() { return 'alarm_' + Date.now() + '_' + Math.floor(Math.random() * 1000); }

    function alarmTimerLabels() {
        return {
            daily: t('overview.dailyOps'),
            home_jobs: `${t('overview.homeMarket')} — ${t('overview.nextReset')}`,
            dark_jobs: `${t('overview.darkMarket')} — ${t('overview.nextReset')}`,
            srm_jobs: `${t('overview.srm')} — ${t('overview.nextReset')}`,
            usol_jobs: `${t('overview.usol')} — ${t('overview.nextReset')}`,
        };
    }

    // ─── Panel state ──────────────────────────────────────────────────────
    // Holds refs to mutable DOM nodes (text spans, list hosts, checkboxes,
    // timer holders) that refresh*() functions update in place. `timers`
    // is the flat instance list for deactivate() teardown.
    let panel = null;

    function tearDown() {
        if (!panel) return;
        for (const tm of panel.timers) try { tm.stop(); } catch (_) {}
        panel = null;
    }

    function toMs(target) {
        if (target == null) return null;
        if (typeof target === 'number') return target;
        if (target instanceof Date) return target.getTime();
        const t = new Date(target).getTime();
        return Number.isFinite(t) ? t : null;
    }

    // Stable timer placement: each holder span owns at most one timer
    // instance, attached via `_cor3Timer`. IDEMPOTENT — if the holder already
    // runs a timer for the SAME target, we leave it ticking instead of
    // destroying + recreating it. This stops the market timers from visibly
    // resetting every time a background market write lands (the Auto Jobs
    // orchestrator rewrites market data each cycle with the SAME
    // nextJobsResetAt) regardless of the Overview Auto-refresh toggle. Passing
    // target=null clears the holder. `opts` (e.g. onExpire) is forwarded to the
    // timer component on (re)create.
    function placeTimer(holder, target, opts) {
        if (!holder) return;
        const ms = toMs(target);
        const old = holder._cor3Timer;
        // Already running for this exact target → keep it (no churn / flicker).
        if (old && holder._cor3Target === ms) return;
        if (old) {
            try { old.stop(); } catch (_) {}
            const i = panel.timers.indexOf(old);
            if (i !== -1) panel.timers.splice(i, 1);
            holder._cor3Timer = null;
        }
        while (holder.firstChild) holder.removeChild(holder.firstChild);
        holder._cor3Target = ms;
        if (!target) return;
        const inst = uiComponents.timer.create(target, opts || {});
        holder._cor3Timer = inst;
        panel.timers.push(inst);
        holder.appendChild(inst.el);
    }

    // ─── Build (one-time skeleton) ────────────────────────────────────────
    async function build(container) {
        tearDown();
        container.innerHTML = '';

        // Read everything once to seed the initial DOM. Subsequent updates
        // come through the targeted refresh*() functions below.
        const [
            autoRefresh, autoDailyOps, autoDecrypt, autoIceWall, autoSimpleDecrypt,
            disableSystemMessages, disableBackground, disableNetworkFog, disableMapFx,
            selectedTheme, showLoadoutWidget,
        ] = await Promise.all([
            Store.sync.getOne(C.STORAGE_SYNC.AUTO_REFRESH, { home_jobs: false, dark_jobs: false, srm_jobs: false, usol_jobs: false }),
            Store.sync.getOne(C.STORAGE_SYNC.AUTO_DAILY_OPS_ENABLED, false),
            Store.sync.getOne(C.STORAGE_SYNC.AUTO_DECRYPT_ENABLED, false),
            // ICE WALL defaults ON to MATCH the solver module (auto-ice-wall.js
            // reads `true`): the toggle was showing OFF while the solver actually
            // ran — the source of "Auto Jobs does not list ICE WALL as off".
            Store.sync.getOne(C.STORAGE_SYNC.AUTO_ICE_WALL_ENABLED, true),
            Store.sync.getOne(C.STORAGE_SYNC.AUTO_SIMPLE_DECRYPT_ENABLED, false),
            Store.sync.getOne(C.STORAGE_SYNC.DISABLE_SYSTEM_MESSAGES, false),
            Store.sync.getOne(C.STORAGE_SYNC.DISABLE_BACKGROUND, false),
            Store.sync.getOne(C.STORAGE_SYNC.DISABLE_NETWORK_FOG, false),
            Store.sync.getOne('disableMapFxEnabled', false),
            Store.sync.getOne(C.STORAGE_SYNC.SELECTED_THEME, 'cor3'),
            Store.sync.getOne(C.STORAGE_SYNC.SHOW_LOADOUT_WIDGET, false),
        ]);
        const ar = autoRefresh || { home_jobs: false, dark_jobs: false, srm_jobs: false, usol_jobs: false };

        panel = {
            container,
            timers: [],
            daily: null,
            markets: { home: null, dark: null, srm: null, usol: null },
            alarms: null,
            versions: null,
        };

        // ─── Daily Ops ────────────────────────────────────────────────
        container.appendChild(el('div', 'section-title', t('overview.dailyOps')));
        const dailyCard = el('div', 'card');
        const dailyHeadRow = el('div', 'card-row');
        const dailyHeadLabel = el('span', 'card-label', t('overview.nextReset'));
        const dailyTimerHolder = el('span', 'timer-holder');
        const dailyHeadDash = el('span', 'muted sm', '—');
        dailyHeadRow.appendChild(dailyHeadLabel);
        dailyHeadRow.appendChild(dailyTimerHolder);
        dailyHeadRow.appendChild(dailyHeadDash);
        dailyCard.appendChild(dailyHeadRow);

        const dailyMeta = el('div', 'muted sm', '');
        dailyCard.appendChild(dailyMeta);

        const dailyActions = el('div', 'row gap-sm mt-sm');
        const solveBtn = el('button', 'btn small', t('common.solve'));
        solveBtn.addEventListener('click', () => sendToContent('solveDailyOps'));
        dailyActions.appendChild(solveBtn);
        // "Auto" toggle (replaces the old Refresh button). When on, the
        // isolated daily-ops watcher auto-solves whenever the reset timer hits
        // 00:00 or the day is still unsolved — see modules/automation/daily-ops.js.
        const autoSw = el('label', 'switch');
        const autoInput = document.createElement('input');
        autoInput.type = 'checkbox';
        autoInput.checked = !!autoDailyOps;
        autoSw.appendChild(autoInput);
        autoSw.appendChild(el('span', 'switch-slider'));
        autoInput.addEventListener('change', async (e) => {
            const value = e.target.checked;
            await Store.sync.setOne(C.STORAGE_SYNC.AUTO_DAILY_OPS_ENABLED, value);
            sendToContent('settingChanged', { key: C.STORAGE_SYNC.AUTO_DAILY_OPS_ENABLED, value });
        });
        const autoRow = el('div', 'row gap-sm');
        autoRow.title = t('overview.dailyAutoTip');
        autoRow.appendChild(autoSw);
        autoRow.appendChild(el('span', 'muted xs', t('overview.dailyAuto')));
        dailyActions.appendChild(autoRow);
        dailyCard.appendChild(dailyActions);

        const dailyLogLine = el('div', 'muted xs mt-sm', '');
        dailyCard.appendChild(dailyLogLine);

        container.appendChild(dailyCard);

        panel.daily = {
            headLabel: dailyHeadLabel,
            timerHolder: dailyTimerHolder,
            headDash: dailyHeadDash,
            metaLine: dailyMeta,
            logLine: dailyLogLine,
        };

        // ─── Markets ──────────────────────────────────────────────────
        container.appendChild(el('div', 'section-title', t('overview.markets')));

        function buildMarketCard({ baseLabel, arKey, refreshAction }) {
            const card = el('div', 'card compact');

            const head = el('div', 'card-row');
            const breakdownLabel = el('span', 'card-label', baseLabel);
            const timerHolder = el('span', 'timer-holder');
            const timerDash = el('span', 'muted sm', '—');
            head.appendChild(breakdownLabel);
            head.appendChild(timerHolder);
            head.appendChild(timerDash);
            card.appendChild(head);

            const ctrls = el('div', 'card-row mt-sm');
            const sw = el('label', 'switch');
            const swInput = document.createElement('input');
            swInput.type = 'checkbox';
            swInput.checked = !!ar[arKey];
            sw.appendChild(swInput);
            const swSlider = el('span', 'switch-slider');
            sw.appendChild(swSlider);
            swInput.addEventListener('change', async (e) => {
                const cur = (await Store.sync.getOne(C.STORAGE_SYNC.AUTO_REFRESH, {})) || {};
                cur[arKey] = e.target.checked;
                await Store.sync.setOne(C.STORAGE_SYNC.AUTO_REFRESH, cur);
            });
            const swRow = el('div', 'row gap-sm');
            swRow.appendChild(sw);
            swRow.appendChild(el('span', 'muted xs', t('overview.autoRefresh')));
            ctrls.appendChild(swRow);
            const refreshBtn = el('button', 'btn small', t('common.refresh'));
            refreshBtn.addEventListener('click', () => sendToContent(refreshAction));
            ctrls.appendChild(refreshBtn);
            card.appendChild(ctrls);

            return { card, breakdownLabel, timerHolder, timerDash, swInput, baseLabel };
        }

        const home = buildMarketCard({
            baseLabel: t('overview.homeMarket'), arKey: 'home_jobs', refreshAction: 'refreshMarket',
        });
        const dark = buildMarketCard({
            baseLabel: t('overview.darkMarket'), arKey: 'dark_jobs', refreshAction: 'refreshDarkMarket',
        });
        const srm = buildMarketCard({
            baseLabel: t('overview.srm'), arKey: 'srm_jobs', refreshAction: 'refreshSrmMarket',
        });
        const usol = buildMarketCard({
            baseLabel: t('overview.usol'), arKey: 'usol_jobs', refreshAction: 'refreshUsolMarket',
        });
        container.appendChild(home.card);
        container.appendChild(dark.card);
        container.appendChild(srm.card);
        container.appendChild(usol.card);
        panel.markets.home = home;
        panel.markets.dark = dark;
        panel.markets.srm = srm;
        panel.markets.usol = usol;

        // ─── Auto solvers (build-once; user-driven toggles) ───────────
        container.appendChild(el('div', 'section-title', t('overview.autoSolvers')));
        container.appendChild(buildToggleCard(t('overview.autoDecrypt'), C.STORAGE_SYNC.AUTO_DECRYPT_ENABLED, autoDecrypt));
        container.appendChild(buildToggleCard(t('overview.autoIceWall'), C.STORAGE_SYNC.AUTO_ICE_WALL_ENABLED, autoIceWall, buildIceWallDbButton()));
        container.appendChild(buildToggleCard(t('overview.autoSimpleDecrypt'), C.STORAGE_SYNC.AUTO_SIMPLE_DECRYPT_ENABLED, autoSimpleDecrypt));

        // ─── Game appearance (build-once; user-driven toggles) ────────
        container.appendChild(el('div', 'section-title', t('overview.appearance')));

        const themeCard = el('div', 'card');
        const currentTheme = (selectedTheme === 'amber-console' || selectedTheme === 'neon') ? selectedTheme : 'cor3';
        themeCard.innerHTML = `
            <div class="card-row">
                <span class="card-label">${escape(t('overview.theme'))}</span>
                <select id="theme-select">
                    <option value="cor3" ${currentTheme === 'cor3' ? 'selected' : ''}>${escape(t('overview.themeCor3'))}</option>
                    <option value="amber-console" ${currentTheme === 'amber-console' ? 'selected' : ''}>${escape(t('overview.themeAmber'))}</option>
                    <option value="neon" ${currentTheme === 'neon' ? 'selected' : ''}>${escape(t('overview.themeNeon'))}</option>
                </select>
            </div>
        `;
        themeCard.querySelector('#theme-select').addEventListener('change', (e) => {
            Store.sync.setOne(C.STORAGE_SYNC.SELECTED_THEME, e.target.value);
        });
        container.appendChild(themeCard);

        container.appendChild(buildToggleCard(t('overview.hideSysMsg'), C.STORAGE_SYNC.DISABLE_SYSTEM_MESSAGES, disableSystemMessages));
        container.appendChild(buildToggleCard(t('overview.disableBg'), C.STORAGE_SYNC.DISABLE_BACKGROUND, disableBackground));
        container.appendChild(buildToggleCard(t('overview.disableNetFog'), C.STORAGE_SYNC.DISABLE_NETWORK_FOG, disableNetworkFog));
        container.appendChild(buildToggleCard(t('overview.disableMapFx'), 'disableMapFxEnabled', disableMapFx));
        // Site-embedded LOADOUT pill (MAIN-world loadout-panel module).
        // Default OFF — the appearance-loadout-widget bridge relays this key
        // to MAIN, which injects/removes the pill live (no reload needed).
        container.appendChild(buildToggleCard(t('overview.showLoadout'), C.STORAGE_SYNC.SHOW_LOADOUT_WIDGET, showLoadoutWidget));

        // ─── Alarms (collapsible) ─────────────────────────────────────
        const alarmsBlock = document.createElement('details');
        alarmsBlock.className = 'collapsible';
        alarmsBlock.open = false;
        const summary = document.createElement('summary');
        summary.className = 'section-title';
        alarmsBlock.appendChild(summary);

        const alarmsListHost = el('div');         // list OR empty-state line
        alarmsBlock.appendChild(alarmsListHost);

        alarmsBlock.appendChild(el('div', 'section-title', t('overview.addAlarm')));

        const form = el('div', 'card');
        // Build form skeleton with stable nodes. The timer-options <select>
        // is the only piece that depends on Expedition data — we'll
        // refresh just its <option> list when EXPEDITIONS changes.
        const timerSelect = document.createElement('select');
        timerSelect.id = 'al-timer';

        const threshInput = document.createElement('input');
        threshInput.type = 'number';
        threshInput.id = 'al-thresh';
        threshInput.min = '1';
        threshInput.value = '60';
        threshInput.style.width = '80px';

        const volInput = document.createElement('input');
        volInput.type = 'range';
        volInput.id = 'al-vol';
        volInput.min = '10';
        volInput.max = '100';
        volInput.value = '50';
        volInput.style.width = '120px';

        const contInput = document.createElement('input');
        contInput.type = 'checkbox';
        contInput.id = 'al-cont';

        const r1 = el('div', 'row gap-sm');
        r1.appendChild(el('span', 'card-label flex1', escape(t('overview.timer'))));
        r1.appendChild(timerSelect);
        form.appendChild(r1);

        const r2 = el('div', 'row gap-sm mt-sm');
        r2.appendChild(el('span', 'card-label flex1', escape(t('overview.threshold'))));
        r2.appendChild(threshInput);
        form.appendChild(r2);

        const r3 = el('div', 'row gap-sm mt-sm');
        r3.appendChild(el('span', 'card-label flex1', escape(t('overview.volume'))));
        r3.appendChild(volInput);
        form.appendChild(r3);

        const r4 = el('div', 'row gap-sm mt-sm');
        r4.appendChild(el('span', 'card-label flex1', escape(t('overview.continuous'))));
        const contLabel = el('label', 'switch');
        contLabel.appendChild(contInput);
        contLabel.appendChild(el('span', 'switch-slider'));
        r4.appendChild(contLabel);
        form.appendChild(r4);

        const r5 = el('div', 'row gap-sm mt-sm');
        const testBtn = el('button', 'btn small', escape(t('common.test')));
        const addBtn = el('button', 'btn small', escape(t('common.add')));
        const stopBtn = el('button', 'btn btn-danger small', escape(t('common.stopAll')));
        r5.appendChild(testBtn);
        r5.appendChild(addBtn);
        r5.appendChild(stopBtn);
        form.appendChild(r5);
        alarmsBlock.appendChild(form);

        testBtn.addEventListener('click', async () => {
            const tab = await getCor3Tab();
            if (tab) chrome.tabs.sendMessage(tab.id, {
                type: 'testAlarm',
                payload: { volume: Number(volInput.value), continuous: contInput.checked },
            }).catch(() => {});
        });
        stopBtn.addEventListener('click', async () => {
            const tab = await getCor3Tab();
            if (tab) chrome.tabs.sendMessage(tab.id, { type: 'stopAlarm' }).catch(() => {});
        });
        addBtn.addEventListener('click', async () => {
            const a = {
                id: genAlarmId(),
                timerSource: timerSelect.value,
                thresholdSeconds: Math.max(1, Number(threshInput.value) || 60),
                volume: Number(volInput.value),
                continuous: contInput.checked,
                enabled: true,
            };
            const cur = (await Store.sync.getOne(C.STORAGE_SYNC.ALARMS, [])) || [];
            cur.push(a);
            await Store.sync.setOne(C.STORAGE_SYNC.ALARMS, cur);
        });

        // Delegated listeners on the alarms list — survive replaceChildren
        // calls because they're bound on the stable host element.
        alarmsListHost.addEventListener('change', async (e) => {
            if (e.target.dataset.act !== 'toggle') return;
            const cur = (await Store.sync.getOne(C.STORAGE_SYNC.ALARMS, [])) || [];
            const idx = cur.findIndex((x) => x.id === e.target.dataset.id);
            if (idx === -1) return;
            cur[idx].enabled = e.target.checked;
            await Store.sync.setOne(C.STORAGE_SYNC.ALARMS, cur);
        });
        alarmsListHost.addEventListener('click', async (e) => {
            if (e.target.dataset.act !== 'del') return;
            const cur = (await Store.sync.getOne(C.STORAGE_SYNC.ALARMS, [])) || [];
            await Store.sync.setOne(C.STORAGE_SYNC.ALARMS, cur.filter((x) => x.id !== e.target.dataset.id));
        });

        container.appendChild(alarmsBlock);

        panel.alarms = {
            block: alarmsBlock,
            summary,
            listHost: alarmsListHost,
            timerSelect,
        };

        // ─── Versions footer ──────────────────────────────────────────
        const versionsLine = el('div', 'muted xs mt-md', '');
        container.appendChild(versionsLine);
        panel.versions = { line: versionsLine };
    }

    // Build-once toggle card. Storage subscriptions don't fire for
    // appearance / solver toggles (they're user-driven in this section),
    // so the checkbox state captured at build() time stays correct for
    // the popup's lifetime.
    function buildToggleCard(label, key, currentValue, extra) {
        const row = el('div', 'card');
        const cardRow = el('div', 'card-row');
        cardRow.appendChild(el('span', 'card-label', escape(label)));
        if (extra) cardRow.appendChild(extra);   // optional control (e.g. a button) before the switch
        const sw = el('label', 'switch');
        const inp = document.createElement('input');
        inp.type = 'checkbox';
        inp.checked = !!currentValue;
        sw.appendChild(inp);
        sw.appendChild(el('span', 'switch-slider'));
        cardRow.appendChild(sw);
        row.appendChild(cardRow);
        inp.addEventListener('change', async (e) => {
            const value = e.target.checked;
            await Store.sync.setOne(key, value);
            // Belt-and-suspenders: Firefox MV3 has known cross-context
            // delivery gaps for chrome.storage.sync.onChanged from popup →
            // isolated content script. The Store.sync.onSettingChange
            // helper in modules listens for both signals and dedupes.
            sendToContent('settingChanged', { key, value });
        });
        return row;
    }

    // ─── ICE WALL learned-shapes viewer (read-only) ──────────────────────
    // A small button next to the Auto ICE WALL toggle that opens a modal
    // listing the shapes the solver has learned a click-cell for (it builds
    // this DB live while solving). Read-only + a "clear base" action.
    function buildIceWallDbButton() {
        const btn = el('button', 'btn small', t('overview.iceWallShapesBtn'));
        btn.title = t('overview.iceWallShapesTip');
        btn.style.marginLeft = 'auto';
        btn.style.marginRight = '8px';
        btn.addEventListener('click', openIceWallDbModal);
        return btn;
    }

    // Mini SVG of a learned shape (reuses the game's triangle geometry). The
    // learned click cell is filled red; revealed cells cyan, placeholders dim.
    // When `onPick` is supplied, every cell becomes clickable — tapping one calls
    // onPick(cell) so the user can re-assign which glyph the solver clicks.
    function renderIceWallShape(entry, onPick) {
        const ns = 'http://www.w3.org/2000/svg';
        const COL = 31.5, ROW = 54;
        const TRI = 'M60.6914 53.0305 H1.73242 L31.21 1.99927 Z';
        const X0 = 1.73, X1 = 60.69, Y0 = 1.99, Y1 = 53.03;   // TRI path extents
        const cells = Array.isArray(entry.cells) ? entry.cells : [];
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const c of cells) {
            const tx = c.dc * COL, ty = c.dr * ROW;
            const yLo = c.mirror ? (ty - Y1) : (ty + Y0);
            const yHi = c.mirror ? (ty - Y0) : (ty + Y1);
            minX = Math.min(minX, tx + X0); maxX = Math.max(maxX, tx + X1);
            minY = Math.min(minY, yLo);     maxY = Math.max(maxY, yHi);
        }
        if (!isFinite(minX)) { minX = 0; minY = 0; maxX = X1; maxY = Y1; }
        const pad = 6;
        const svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('viewBox', `${minX - pad} ${minY - pad} ${(maxX - minX) + 2 * pad} ${(maxY - minY) + 2 * pad}`);
        svg.setAttribute('width', '116'); svg.setAttribute('height', '104');
        const click = entry.click || {};
        for (const c of cells) {
            const isClick = (c.dc === click.dc && c.dr === click.dr && (!!c.mirror === !!click.mirror));
            const p = document.createElementNS(ns, 'path');
            p.setAttribute('d', TRI);
            p.setAttribute('transform', `translate(${c.dc * COL}, ${c.dr * ROW})${c.mirror ? ' scale(1,-1)' : ''}`);
            p.setAttribute('fill', isClick ? '#FF3333' : (c.revealed ? '#76C1D1' : '#21505e'));
            p.setAttribute('fill-opacity', isClick ? '0.85' : (c.revealed ? '0.5' : '0.3'));
            p.setAttribute('stroke', isClick ? '#FFFFFF' : '#3a6b78');
            p.setAttribute('stroke-width', '2');
            if (typeof onPick === 'function') {
                p.style.cursor = 'pointer';
                p.setAttribute('pointer-events', 'all');   // fill-opacity<1 still needs explicit hit area
                p.addEventListener('click', (ev) => { ev.stopPropagation(); onPick(c); });
            }
            svg.appendChild(p);
        }
        return svg;
    }

    async function openIceWallDbModal() {
        const prev = document.getElementById('ice-wall-db-modal');
        if (prev) prev.remove();
        const overlay = el('div');
        overlay.id = 'ice-wall-db-modal';
        Object.assign(overlay.style, {
            position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.6)', zIndex: '9999',
            display: 'flex', alignItems: 'flex-start', justifyContent: 'center', overflow: 'auto', padding: '16px',
        });
        const panel = el('div', 'card');
        Object.assign(panel.style, { maxWidth: '540px', width: '100%', maxHeight: '90vh', overflow: 'auto' });
        const head = el('div', 'card-row');
        head.appendChild(el('span', 'card-label', t('overview.iceWallModalTitle')));
        const closeBtn = el('button', 'btn small', '✕');
        closeBtn.style.marginLeft = 'auto';
        head.appendChild(closeBtn);
        panel.appendChild(head);
        const body = el('div');
        panel.appendChild(body);
        const foot = el('div', 'card-row');
        const count = el('span', 'muted xs');
        const clearBtn = el('button', 'btn small', t('overview.iceWallClearBase'));
        clearBtn.style.marginLeft = 'auto';
        foot.appendChild(count);
        foot.appendChild(clearBtn);
        panel.appendChild(foot);
        overlay.appendChild(panel);
        document.body.appendChild(overlay);

        const close = () => overlay.remove();
        closeBtn.addEventListener('click', close);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

        async function render() {
            const db = (await Store.local.getOne(C.STORAGE_LOCAL.ICE_WALL_CLICK_DB, {})) || {};
            const keys = Object.keys(db).sort((a, b) => ((db[b] && db[b].hits) || 0) - ((db[a] && db[a].hits) || 0));
            count.textContent = t('overview.iceWallCount', { n: keys.length });
            body.innerHTML = '';
            if (!keys.length) {
                body.appendChild(el('div', 'muted xs', t('overview.iceWallNone')));
                return;
            }
            body.appendChild(el('div', 'muted xs', t('overview.iceWallHint')));
            const grid = el('div');
            Object.assign(grid.style, { display: 'flex', flexWrap: 'wrap', gap: '10px', marginTop: '8px' });
            for (const key of keys) {
                const entry = db[key];
                const item = el('div', 'card');
                Object.assign(item.style, { padding: '6px', width: '132px', textAlign: 'center' });
                if (entry.pinned) item.style.outline = '2px solid #FF3333';
                item.appendChild(renderIceWallShape(entry, (cell) => pickCell(key, cell)));
                const meta = el('div');
                Object.assign(meta.style, { display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: '4px', marginTop: '4px' });
                meta.appendChild(el('span', 'muted xs', t('overview.iceWallHits', { n: entry.hits || 0 })));
                const pinBtn = el('button', 'btn small' + (entry.pinned ? ' btn-success' : ''), entry.pinned ? t('overview.iceWallPinned') : t('overview.iceWallPin'));
                pinBtn.style.width = '100%';
                pinBtn.title = entry.pinned
                    ? t('overview.iceWallPinTipOn')
                    : t('overview.iceWallPinTipOff');
                pinBtn.addEventListener('click', () => togglePin(key));
                meta.appendChild(pinBtn);
                item.appendChild(meta);
                grid.appendChild(item);
            }
            body.appendChild(grid);
        }

        // Re-assign which cell of a learned shape the solver clicks. Persists the
        // whole DB; the auto-ice-wall bridge's onChanged push then applies it to
        // the live MAIN solver immediately (no reload).
        async function pickCell(key, cell) {
            const db = (await Store.local.getOne(C.STORAGE_LOCAL.ICE_WALL_CLICK_DB, {})) || {};
            const entry = db[key];
            if (!entry) return;
            entry.click = { dc: cell.dc, dr: cell.dr, mirror: !!cell.mirror };
            await Store.local.setOne(C.STORAGE_LOCAL.ICE_WALL_CLICK_DB, db);
            render();
        }

        // Pin/unpin a shape: pinned ⇒ solver clicks ONLY the chosen cell and
        // learnClick never overwrites it. Same live-push path as pickCell.
        async function togglePin(key) {
            const db = (await Store.local.getOne(C.STORAGE_LOCAL.ICE_WALL_CLICK_DB, {})) || {};
            const entry = db[key];
            if (!entry) return;
            entry.pinned = !entry.pinned;
            await Store.local.setOne(C.STORAGE_LOCAL.ICE_WALL_CLICK_DB, db);
            render();
        }
        clearBtn.addEventListener('click', async () => {
            // Clears storage; auto-ice-wall watches this key and pushes the empty
            // DB to the live MAIN solver (ICE_WALL_DB), so the clear takes effect
            // immediately, not only on the solver's next start.
            await Store.local.setOne(C.STORAGE_LOCAL.ICE_WALL_CLICK_DB, {});
            render();
        });
        render();
    }

    // ─── Targeted refreshes ───────────────────────────────────────────────

    async function refreshDaily() {
        if (!panel) return;
        const [daily, dailyLog] = await Promise.all([
            Store.local.getOne(C.STORAGE_LOCAL.DAILY_OPS),
            Store.local.getOne(C.STORAGE_LOCAL.DAILY_HACK_LOG),
        ]);
        const n = panel.daily;
        const resetMs = (daily && daily.nextTaskTime) ? new Date(daily.nextTaskTime).getTime() : NaN;
        // Once nextTaskTime passes, the stored snapshot (streak / hasClaimedToday)
        // AND the solver log line ("which puzzle …") are from the PREVIOUS day.
        const rolledOver = Number.isFinite(resetMs) && resetMs <= Date.now();

        if (daily && daily.nextTaskTime && !rolledOver) {
            n.headLabel.textContent = t('overview.nextReset');
            n.headLabel.style.display = '';
            // onExpire: when the countdown crosses 00:00 while the popup is open,
            // re-run refreshDaily so the now-stale puzzle/claim info is cleared
            // live (refreshDaily otherwise only fires on a storage change).
            placeTimer(n.timerHolder, daily.nextTaskTime, { onExpire: () => refreshDaily() });
            n.headDash.style.display = 'none';
            const streak = daily.currentStreak ?? daily.streak ?? 0;
            const claimed = daily.hasClaimedToday ? t('overview.claimed') : t('overview.pending');
            n.metaLine.textContent = `${t('overview.streak')} ${streak} · ${claimed}`;
            n.metaLine.style.display = '';
            if (dailyLog) { n.logLine.textContent = String(dailyLog); n.logLine.style.display = ''; }
            else { n.logLine.textContent = ''; n.logLine.style.display = 'none'; }
        } else if (daily && daily.nextTaskTime && rolledOver) {
            // Day rolled over — clear the stale puzzle log + claim/streak rather
            // than showing yesterday's. No auto re-fetch here: the Daily Ops
            // "Auto" toggle / "Solve" button refresh it (matches "don't
            // auto-refresh when it's off").
            n.headLabel.style.display = 'none';
            placeTimer(n.timerHolder, null);
            n.headDash.style.display = 'none';
            n.metaLine.textContent = t('overview.dailyNewDay');
            n.metaLine.style.display = '';
            n.logLine.textContent = '';
            n.logLine.style.display = 'none';
        } else {
            n.headLabel.style.display = 'none';
            placeTimer(n.timerHolder, null);
            n.headDash.style.display = 'none';
            n.metaLine.textContent = t('overview.noDaily');
            n.metaLine.style.display = '';
            n.logLine.textContent = '';
            n.logLine.style.display = 'none';
        }
    }

    // Update breakdown text + timer for all four market cards. Used when
    // any market payload arrives (jobs, reset time, or reachability).
    async function refreshMarkets() {
        if (!panel) return;
        const [market, dark, darkAvail, srm, srmAvail, usol, usolAvail, board] = await Promise.all([
            Store.local.getOne(C.STORAGE_LOCAL.MARKET),
            Store.local.getOne(C.STORAGE_LOCAL.DARK_MARKET),
            Store.local.getOne(C.STORAGE_LOCAL.DARK_MARKET_AVAILABLE, true),
            Store.local.getOne(C.STORAGE_LOCAL.SRM_MARKET),
            Store.local.getOne(C.STORAGE_LOCAL.SRM_MARKET_AVAILABLE, true),
            Store.local.getOne(C.STORAGE_LOCAL.USOL_MARKET),
            Store.local.getOne(C.STORAGE_LOCAL.USOL_MARKET_AVAILABLE, true),
            Store.local.getOne(C.STORAGE_LOCAL.AJ_JOB_QUEUE, null),
        ]);
        const boardJobs = (board && Array.isArray(board.jobs)) ? board.jobs : [];
        applyMarket('home', market, true,      false, boardJobs);
        applyMarket('dark', dark,   darkAvail, true,  boardJobs);
        applyMarket('srm',  srm,    srmAvail,  true,  boardJobs);
        applyMarket('usol', usol,   usolAvail, true,  boardJobs);
    }

    // Update ONLY the breakdown text for all four market cards. Used
    // when AJ_JOB_QUEUE / AJ_PIPELINE_STATE change — the in-progress count
    // shifts but the underlying market data didn't. Cheaper than
    // refreshMarkets because we don't touch timer instances.
    async function refreshInProgress() {
        if (!panel) return;
        const [market, dark, darkAvail, srm, srmAvail, usol, usolAvail, board] = await Promise.all([
            Store.local.getOne(C.STORAGE_LOCAL.MARKET),
            Store.local.getOne(C.STORAGE_LOCAL.DARK_MARKET),
            Store.local.getOne(C.STORAGE_LOCAL.DARK_MARKET_AVAILABLE, true),
            Store.local.getOne(C.STORAGE_LOCAL.SRM_MARKET),
            Store.local.getOne(C.STORAGE_LOCAL.SRM_MARKET_AVAILABLE, true),
            Store.local.getOne(C.STORAGE_LOCAL.USOL_MARKET),
            Store.local.getOne(C.STORAGE_LOCAL.USOL_MARKET_AVAILABLE, true),
            Store.local.getOne(C.STORAGE_LOCAL.AJ_JOB_QUEUE, null),
        ]);
        const boardJobs = (board && Array.isArray(board.jobs)) ? board.jobs : [];
        applyBreakdown('home', market, true,      false, boardJobs);
        applyBreakdown('dark', dark,   darkAvail, true,  boardJobs);
        applyBreakdown('srm',  srm,    srmAvail,  true,  boardJobs);
        applyBreakdown('usol', usol,   usolAvail, true,  boardJobs);
    }

    function computeBreakdown(data, available, canBeUnreachable, boardJobs) {
        const unreachable = canBeUnreachable && available === false;
        const jobs = (data && Array.isArray(data.jobs)) ? data.jobs : [];
        const myMarketId = data && data.marketId;
        // In-progress = Auto Jobs board entries for this market tagged TAKEN.
        const inProgress = (boardJobs || []).filter((j) => j.marketId === myMarketId && j.status === 'TAKEN').length;
        return unreachable
            ? ` · ${t('overview.unreachable')}`
            : ` · ${jobs.length} ${t('overview.avail')}${inProgress > 0 ? ` · ${inProgress} ${t('overview.inProgress')}` : ''}`;
    }

    function applyBreakdown(which, data, available, canBeUnreachable, boardJobs) {
        const n = panel.markets[which];
        if (!n) return;
        n.breakdownLabel.textContent = `${n.baseLabel}${computeBreakdown(data, available, canBeUnreachable, boardJobs)}`;
    }

    function applyMarket(which, data, available, canBeUnreachable, boardJobs) {
        const n = panel.markets[which];
        if (!n) return;
        applyBreakdown(which, data, available, canBeUnreachable, boardJobs);
        const unreachable = canBeUnreachable && available === false;
        if (!unreachable && data && data.nextJobsResetAt) {
            placeTimer(n.timerHolder, data.nextJobsResetAt);
            n.timerHolder.style.display = '';
            n.timerDash.style.display = 'none';
        } else {
            placeTimer(n.timerHolder, null);
            n.timerHolder.style.display = 'none';
            n.timerDash.style.display = '';
        }
    }

    async function refreshAlarmsList() {
        if (!panel) return;
        const [alarms, exps] = await Promise.all([
            Store.sync.getOne(C.STORAGE_SYNC.ALARMS, []),
            Store.local.getOne(C.STORAGE_LOCAL.EXPEDITIONS, []),
        ]);
        const labels = Object.assign({}, alarmTimerLabels());
        for (const e of exps || []) {
            labels['exp_' + e.id] = `${e.locationName || t('tabs.expeditions')} — ${e.zoneName || ''}`;
        }

        // Summary count
        panel.alarms.summary.textContent = `${t('overview.alarms')} (${(alarms || []).length})`;

        // List body — replaceChildren is atomic (no intermediate empty paint).
        if (!alarms || alarms.length === 0) {
            const empty = el('div', 'empty', t('overview.noAlarms'));
            panel.alarms.listHost.replaceChildren(empty);
        } else {
            const list = el('div', 'alarm-list');
            for (const a of alarms) {
                const row = el('div', 'alarm-row');
                row.innerHTML = `
                    <label class="switch"><input type="checkbox" data-id="${a.id}" data-act="toggle" ${a.enabled ? 'checked' : ''}><span class="switch-slider"></span></label>
                    <div>
                        <div class="sm">${escape(labels[a.timerSource] || a.timerSource)}</div>
                        <div class="muted xs">≤ ${a.thresholdSeconds}s · ${a.volume}%${a.continuous ? ' · loop' : ''}</div>
                    </div>
                    <button class="btn btn-danger small" data-id="${a.id}" data-act="del">×</button>
                `;
                list.appendChild(row);
            }
            panel.alarms.listHost.replaceChildren(list);
        }
    }

    async function refreshAlarmsTimerOptions() {
        if (!panel) return;
        const exps = await Store.local.getOne(C.STORAGE_LOCAL.EXPEDITIONS, []);
        const labels = Object.assign({}, alarmTimerLabels());
        for (const e of exps || []) {
            labels['exp_' + e.id] = `${e.locationName || t('tabs.expeditions')} — ${e.zoneName || ''}`;
        }
        // Preserve the user's current selection across the option swap.
        const prev = panel.alarms.timerSelect.value;
        const options = Object.entries(labels).map(([k, v]) => {
            const o = document.createElement('option');
            o.value = k;
            o.textContent = v;
            return o;
        });
        panel.alarms.timerSelect.replaceChildren(...options);
        if (Object.prototype.hasOwnProperty.call(labels, prev)) {
            panel.alarms.timerSelect.value = prev;
        }
    }

    async function refreshVersions() {
        if (!panel) return;
        const [web, sys] = await Promise.all([
            Store.local.getOne(C.STORAGE_LOCAL.WEB_VERSION, '?'),
            Store.local.getOne(C.STORAGE_LOCAL.SYSTEM_VERSION, '?'),
        ]);
        panel.versions.line.textContent = `web: ${String(web)} · system: ${String(sys)}`;
    }

    async function refreshAll() {
        await Promise.all([
            refreshDaily(),
            refreshMarkets(),
            refreshAlarmsList(),
            refreshAlarmsTimerOptions(),
            refreshVersions(),
        ]);
    }

    // ─── Lifecycle ────────────────────────────────────────────────────────
    let unsubLocal = null;
    let unsubSync = null;

    root.COR3.ui.overview = {
        // Subscribe-only mount; first render runs from activate(). Calling
        // any refresh here would race the activate() build and double-paint
        // (see logs-panel.js for the same pattern).
        //
        // Dispatcher granularity: each storage key drives the narrowest
        // refresh that depends on it. AJ_JOB_QUEUE only affects the in-progress
        // count on market breakdown lines, so it routes to refreshInProgress
        // (no timer reinstantiation). Same idea for EXPEDITIONS — it only
        // widens the Alarms timer-source dropdown, not the alarm list itself.
        mount(container) {
            unsubLocal = Store.local.onChanged((changes) => {
                if (!container.classList.contains('active')) return;
                const hits = new Set();
                if (changes[C.STORAGE_LOCAL.DAILY_OPS])              hits.add('daily');
                if (changes[C.STORAGE_LOCAL.DAILY_HACK_LOG])         hits.add('daily');
                if (changes[C.STORAGE_LOCAL.MARKET])                 hits.add('markets');
                if (changes[C.STORAGE_LOCAL.DARK_MARKET])            hits.add('markets');
                if (changes[C.STORAGE_LOCAL.DARK_MARKET_AVAILABLE])  hits.add('markets');
                if (changes[C.STORAGE_LOCAL.SRM_MARKET])             hits.add('markets');
                if (changes[C.STORAGE_LOCAL.SRM_MARKET_AVAILABLE])   hits.add('markets');
                if (changes[C.STORAGE_LOCAL.USOL_MARKET])            hits.add('markets');
                if (changes[C.STORAGE_LOCAL.USOL_MARKET_AVAILABLE])  hits.add('markets');
                if (changes[C.STORAGE_LOCAL.WEB_VERSION])            hits.add('versions');
                if (changes[C.STORAGE_LOCAL.SYSTEM_VERSION])         hits.add('versions');
                if (changes[C.STORAGE_LOCAL.AJ_JOB_QUEUE])           hits.add('inProgress');
                if (changes[C.STORAGE_LOCAL.EXPEDITIONS])            hits.add('expeditions');
                if (hits.has('daily'))      refreshDaily();
                if (hits.has('markets'))    refreshMarkets();
                else if (hits.has('inProgress')) refreshInProgress();
                if (hits.has('versions'))   refreshVersions();
                if (hits.has('expeditions')) {
                    // EXPEDITIONS widens BOTH the alarm timer-source
                    // dropdown options AND the labels shown next to each
                    // alarm row (the exp_<id> entries). replaceChildren on
                    // the list host is atomic so this won't paint a flash.
                    refreshAlarmsTimerOptions();
                    refreshAlarmsList();
                }
            });
            unsubSync = Store.sync.onChanged((changes) => {
                if (!container.classList.contains('active')) return;
                // Alarms list IS data — counts and items change visibly.
                // Other sync changes (toggle flags, theme) are user-driven
                // from this same popup; the DOM already reflects them.
                if (changes[C.STORAGE_SYNC.ALARMS]) refreshAlarmsList();
            });
        },
        async activate(container) {
            await build(container);
            await refreshAll();
        },
        deactivate() { tearDown(); },
    };
})();
