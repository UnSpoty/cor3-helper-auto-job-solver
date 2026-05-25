// src/ui/sections/overview.js
// Main dashboard. Aggregates everything that's "at-a-glance" useful:
//   • Daily Ops card — timer + one-shot "Solve" button + Refresh on the
//     same row (Daily Ops moved into the Game Center window, so a watcher
//     toggle no longer makes sense; the user clicks Solve when they want
//     to claim/replay)
//   • Markets cards (home + dark) — each card carries its own Auto-refresh
//     toggle (was a separate "Auto-refresh markets" section; merged in to
//     keep market controls together with the market they affect)
//   • Auto solvers — Auto-decrypt only
//   • Game appearance — system messages, background, network fog, map FX
//   • Alarms (collapsible <details>, default closed) — list + add form
//   • Versions footer (web / system)
//
// Active expeditions and pending decisions live in the Expeditions tab.

(function () {
    const root = window;
    root.COR3.ui = root.COR3.ui || {};
    const { Store, constants: C, uiComponents } = root.COR3;
    const t = (k, vars) => root.COR3.i18n.t(k, vars);

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
    function genAlarmId() { return 'alarm_' + Date.now() + '_' + Math.floor(Math.random() * 1000); }

    function alarmTimerLabels() {
        return {
            daily: t('overview.dailyOps'),
            home_jobs: `${t('overview.homeMarket')} — ${t('overview.nextReset')}`,
            dark_jobs: `${t('overview.darkMarket')} — ${t('overview.nextReset')}`,
            srm_jobs: `${t('overview.srm')} — ${t('overview.nextReset')}`,
        };
    }

    function appearanceToggle(label, key, currentValue) {
        const row = el('div', 'card');
        row.innerHTML = `
            <div class="card-row">
                <span class="card-label">${escape(label)}</span>
                <label class="switch"><input type="checkbox" ${currentValue ? 'checked' : ''}><span class="switch-slider"></span></label>
            </div>
        `;
        row.querySelector('input').addEventListener('change', async (e) => {
            const value = e.target.checked;
            await Store.sync.setOne(key, value);
            // Belt-and-suspenders: also push the change as a runtime message.
            // chrome.storage.sync.onChanged works reliably from popup → isolated
            // content script on Chrome, but Firefox MV3 has known cross-context
            // delivery gaps. The Store.sync.onSettingChange helper in modules
            // listens for both signals and dedupes.
            sendToContent('settingChanged', { key, value });
        });
        return row;
    }

    async function render(container) {
        clearTimers();
        container.innerHTML = '';

        const [
            daily, dailyLog, market, dark, darkAvail, srm, srmAvail,
            web, sys,
            autoRefresh, autoDecrypt, autoIceWall,
            disableSystemMessages, disableBackground, disableNetworkFog, disableMapFx,
            alarms, exps,
            autoJobsQueue, autoJobsState,
            selectedTheme,
        ] = await Promise.all([
            Store.local.getOne(C.STORAGE_LOCAL.DAILY_OPS),
            Store.local.getOne(C.STORAGE_LOCAL.DAILY_HACK_LOG),
            Store.local.getOne(C.STORAGE_LOCAL.MARKET),
            Store.local.getOne(C.STORAGE_LOCAL.DARK_MARKET),
            Store.local.getOne(C.STORAGE_LOCAL.DARK_MARKET_AVAILABLE, true),
            Store.local.getOne(C.STORAGE_LOCAL.SRM_MARKET),
            Store.local.getOne(C.STORAGE_LOCAL.SRM_MARKET_AVAILABLE, true),
            Store.local.getOne(C.STORAGE_LOCAL.WEB_VERSION, '?'),
            Store.local.getOne(C.STORAGE_LOCAL.SYSTEM_VERSION, '?'),
            Store.sync.getOne(C.STORAGE_SYNC.AUTO_REFRESH, { home_jobs: false, dark_jobs: false, srm_jobs: false }),
            Store.sync.getOne(C.STORAGE_SYNC.AUTO_DECRYPT_ENABLED, false),
            Store.sync.getOne(C.STORAGE_SYNC.AUTO_ICE_WALL_ENABLED, false),
            Store.sync.getOne(C.STORAGE_SYNC.DISABLE_SYSTEM_MESSAGES, false),
            Store.sync.getOne(C.STORAGE_SYNC.DISABLE_BACKGROUND, false),
            Store.sync.getOne(C.STORAGE_SYNC.DISABLE_NETWORK_FOG, false),
            Store.sync.getOne('disableMapFxEnabled', false),
            Store.sync.getOne(C.STORAGE_SYNC.ALARMS, []),
            Store.local.getOne(C.STORAGE_LOCAL.EXPEDITIONS, []),
            Store.local.getOne(C.STORAGE_LOCAL.AUTOJOBS_QUEUE, []),
            Store.local.getOne(C.STORAGE_LOCAL.AUTOJOBS_STATE, { status: 'idle' }),
            Store.sync.getOne(C.STORAGE_SYNC.SELECTED_THEME, 'cor3'),
        ]);

        const ar = autoRefresh || { home_jobs: false, dark_jobs: false, srm_jobs: false };

        // ─── Daily Ops ────────────────────────────────────────────────
        container.appendChild(el('div', 'section-title', t('overview.dailyOps')));
        const dailyCard = el('div', 'card');
        if (daily && daily.nextTaskTime) {
            // Timer first, then the "next reset · streak N · claimed/pending"
            // metadata under it. Was reversed before — label sat to the left
            // of the timer, which read as "Next reset · streak 0  8h 35m".
            const streak = daily.currentStreak ?? daily.streak ?? 0;
            const claimed = daily.hasClaimedToday ? t('overview.claimed') : t('overview.pending');
            const headRow = el('div', 'card-row');
            const tm = uiComponents.timer.create(daily.nextTaskTime);
            timerInstances.push(tm);
            headRow.appendChild(el('span', 'card-label', t('overview.nextReset')));
            headRow.appendChild(tm.el);
            dailyCard.appendChild(headRow);
            dailyCard.appendChild(el('div', 'muted sm', `${t('overview.streak')} ${streak} · ${claimed}`));
        } else {
            dailyCard.appendChild(el('div', 'muted sm', t('overview.noDaily')));
        }
        // Action row: Solve (one-shot) + Refresh on the same line. The
        // puzzle is nested inside the Game Center window so it can't be
        // auto-watched without navigating first; Solve does the whole
        // open → start → decode → submit chain.
        const dailyActions = el('div', 'row gap-sm mt-sm');
        const solveBtn = el('button', 'btn small', t('common.solve'));
        solveBtn.addEventListener('click', () => sendToContent('solveDailyOps'));
        dailyActions.appendChild(solveBtn);
        const dailyRefresh = el('button', 'btn small', t('common.refresh'));
        dailyRefresh.addEventListener('click', () => sendToContent('fetchDailyOps'));
        dailyActions.appendChild(dailyRefresh);
        dailyCard.appendChild(dailyActions);
        if (dailyLog) dailyCard.appendChild(el('div', 'muted xs mt-sm', escape(String(dailyLog))));
        container.appendChild(dailyCard);

        // ─── Markets ──────────────────────────────────────────────────
        container.appendChild(el('div', 'section-title', t('overview.markets')));

        // Compact 2-row card. Was 4 rows (head + jobs line + ar-row + btn-row);
        // collapsed to (label · jobs | timer) and (auto-refresh switch | refresh).
        // canBeUnreachable flips on for remote markets (Dark, SRM7-M) where the
        // server can refuse get.jobs with no-path-to-server.
        function marketCard({ label, data, available, arKey, refreshAction, canBeUnreachable }) {
            const card = el('div', 'card compact');

            const head = el('div', 'card-row');
            const unreachable = canBeUnreachable && available === false;
            const jobs = (data && Array.isArray(data.jobs)) ? data.jobs : [];
            // Per-market in-progress count: queue items targeting this market
            // PLUS the currently-running job if it lives here. Surfaces the
            // same Auto-Jobs Jobs-section breakdown in compact form.
            const myMarketId = data && data.marketId;
            const inProgress = (autoJobsQueue || []).filter((q) => q.marketId === myMarketId).length
                + (autoJobsState && autoJobsState.marketId === myMarketId && autoJobsState.status === 'solving' ? 1 : 0);
            const breakdown = unreachable
                ? ` · ${t('overview.unreachable')}`
                : ` · ${jobs.length} ${t('overview.avail')}${inProgress > 0 ? ` · ${inProgress} ${t('overview.inProgress')}` : ''}`;
            const left = el('span', 'card-label', `${escape(label)}${breakdown}`);
            head.appendChild(left);
            if (data && data.nextJobsResetAt && !unreachable) {
                const tm = uiComponents.timer.create(data.nextJobsResetAt);
                timerInstances.push(tm);
                head.appendChild(tm.el);
            } else {
                head.appendChild(el('span', 'muted sm', '—'));
            }
            card.appendChild(head);

            const ctrls = el('div', 'card-row mt-sm');
            const sw = el('label', 'switch');
            sw.innerHTML = `<input type="checkbox" ${ar[arKey] ? 'checked' : ''}><span class="switch-slider"></span>`;
            sw.querySelector('input').addEventListener('change', async (e) => {
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

            return card;
        }
        container.appendChild(marketCard({
            label: t('overview.homeMarket'), data: market, available: true,      arKey: 'home_jobs',
            refreshAction: 'refreshMarket',     canBeUnreachable: false,
        }));
        container.appendChild(marketCard({
            label: t('overview.darkMarket'), data: dark,   available: darkAvail, arKey: 'dark_jobs',
            refreshAction: 'refreshDarkMarket', canBeUnreachable: true,
        }));
        container.appendChild(marketCard({
            label: t('overview.srm'),        data: srm,    available: srmAvail,  arKey: 'srm_jobs',
            refreshAction: 'refreshSrmMarket',  canBeUnreachable: true,
        }));

        // ─── Auto solvers ─────────────────────────────────────────────
        container.appendChild(el('div', 'section-title', t('overview.autoSolvers')));
        container.appendChild(appearanceToggle(t('overview.autoDecrypt'), C.STORAGE_SYNC.AUTO_DECRYPT_ENABLED, autoDecrypt));
        container.appendChild(appearanceToggle(t('overview.autoIceWall'), C.STORAGE_SYNC.AUTO_ICE_WALL_ENABLED, autoIceWall));

        // ─── Game appearance ──────────────────────────────────────────
        container.appendChild(el('div', 'section-title', t('overview.appearance')));

        // Popup theme dropdown. Storage value is 'cor3' (default) or
        // 'amber-console' (retro CRT, ported from cor3-auto-Mission).
        // shell.js applies the corresponding body class on storage change,
        // so we don't need to reload the popup after a switch.
        const themeCard = el('div', 'card');
        const currentTheme = (selectedTheme === 'amber-console') ? 'amber-console' : 'cor3';
        themeCard.innerHTML = `
            <div class="card-row">
                <span class="card-label">${escape(t('overview.theme'))}</span>
                <select id="theme-select">
                    <option value="cor3" ${currentTheme === 'cor3' ? 'selected' : ''}>${escape(t('overview.themeCor3'))}</option>
                    <option value="amber-console" ${currentTheme === 'amber-console' ? 'selected' : ''}>${escape(t('overview.themeAmber'))}</option>
                </select>
            </div>
        `;
        themeCard.querySelector('#theme-select').addEventListener('change', (e) => {
            Store.sync.setOne(C.STORAGE_SYNC.SELECTED_THEME, e.target.value);
        });
        container.appendChild(themeCard);

        container.appendChild(appearanceToggle(t('overview.hideSysMsg'), C.STORAGE_SYNC.DISABLE_SYSTEM_MESSAGES, disableSystemMessages));
        container.appendChild(appearanceToggle(t('overview.disableBg'), C.STORAGE_SYNC.DISABLE_BACKGROUND, disableBackground));
        container.appendChild(appearanceToggle(t('overview.disableNetFog'), C.STORAGE_SYNC.DISABLE_NETWORK_FOG, disableNetworkFog));
        container.appendChild(appearanceToggle(t('overview.disableMapFx'), 'disableMapFxEnabled', disableMapFx));

        // ─── Alarms (collapsible — at the bottom, takes a lot of vertical space) ──
        const alarmLabels = Object.assign({}, alarmTimerLabels());
        for (const e of exps || []) alarmLabels['exp_' + e.id] = `${e.locationName || t('tabs.expeditions')} — ${e.zoneName || ''}`;
        const alarmsBlock = document.createElement('details');
        alarmsBlock.className = 'collapsible';
        alarmsBlock.open = false;
        const summary = document.createElement('summary');
        summary.className = 'section-title';
        summary.textContent = `${t('overview.alarms')} (${(alarms || []).length})`;
        alarmsBlock.appendChild(summary);

        if (!alarms || alarms.length === 0) {
            alarmsBlock.appendChild(el('div', 'empty', t('overview.noAlarms')));
        } else {
            const list = el('div', 'alarm-list');
            for (const a of alarms) {
                const row = el('div', 'alarm-row');
                row.innerHTML = `
                    <label class="switch"><input type="checkbox" data-id="${a.id}" data-act="toggle" ${a.enabled ? 'checked' : ''}><span class="switch-slider"></span></label>
                    <div>
                        <div class="sm">${escape(alarmLabels[a.timerSource] || a.timerSource)}</div>
                        <div class="muted xs">≤ ${a.thresholdSeconds}s · ${a.volume}%${a.continuous ? ' · loop' : ''}</div>
                    </div>
                    <button class="btn btn-danger small" data-id="${a.id}" data-act="del">×</button>
                `;
                list.appendChild(row);
            }
            list.addEventListener('change', async (e) => {
                if (e.target.dataset.act !== 'toggle') return;
                const cur = (await Store.sync.getOne(C.STORAGE_SYNC.ALARMS, [])) || [];
                const idx = cur.findIndex((x) => x.id === e.target.dataset.id);
                if (idx === -1) return;
                cur[idx].enabled = e.target.checked;
                await Store.sync.setOne(C.STORAGE_SYNC.ALARMS, cur);
            });
            list.addEventListener('click', async (e) => {
                if (e.target.dataset.act !== 'del') return;
                const cur = (await Store.sync.getOne(C.STORAGE_SYNC.ALARMS, [])) || [];
                await Store.sync.setOne(C.STORAGE_SYNC.ALARMS, cur.filter((x) => x.id !== e.target.dataset.id));
            });
            alarmsBlock.appendChild(list);
        }

        alarmsBlock.appendChild(el('div', 'section-title', t('overview.addAlarm')));
        const form = el('div', 'card');
        const opts = Object.entries(alarmLabels).map(([k, v]) => `<option value="${k}">${escape(v)}</option>`).join('');
        form.innerHTML = `
            <div class="row gap-sm"><span class="card-label flex1">${escape(t('overview.timer'))}</span><select id="al-timer">${opts}</select></div>
            <div class="row gap-sm mt-sm"><span class="card-label flex1">${escape(t('overview.threshold'))}</span><input type="number" id="al-thresh" min="1" value="60" style="width: 80px;"></div>
            <div class="row gap-sm mt-sm"><span class="card-label flex1">${escape(t('overview.volume'))}</span><input type="range" id="al-vol" min="10" max="100" value="50" style="width: 120px;"></div>
            <div class="row gap-sm mt-sm"><span class="card-label flex1">${escape(t('overview.continuous'))}</span><label class="switch"><input type="checkbox" id="al-cont"><span class="switch-slider"></span></label></div>
            <div class="row gap-sm mt-sm">
                <button class="btn small" id="al-test">${escape(t('common.test'))}</button>
                <button class="btn small" id="al-add">${escape(t('common.add'))}</button>
                <button class="btn btn-danger small" id="al-stop">${escape(t('common.stopAll'))}</button>
            </div>
        `;
        form.querySelector('#al-test').addEventListener('click', async () => {
            const tab = await getCor3Tab();
            if (tab) chrome.tabs.sendMessage(tab.id, {
                type: 'testAlarm',
                payload: {
                    volume: Number(form.querySelector('#al-vol').value),
                    continuous: form.querySelector('#al-cont').checked,
                },
            }).catch(() => {});
        });
        form.querySelector('#al-stop').addEventListener('click', async () => {
            const tab = await getCor3Tab();
            if (tab) chrome.tabs.sendMessage(tab.id, { type: 'stopAlarm' }).catch(() => {});
        });
        form.querySelector('#al-add').addEventListener('click', async () => {
            const a = {
                id: genAlarmId(),
                timerSource: form.querySelector('#al-timer').value,
                thresholdSeconds: Math.max(1, Number(form.querySelector('#al-thresh').value) || 60),
                volume: Number(form.querySelector('#al-vol').value),
                continuous: form.querySelector('#al-cont').checked,
                enabled: true,
            };
            const cur = (await Store.sync.getOne(C.STORAGE_SYNC.ALARMS, [])) || [];
            cur.push(a);
            await Store.sync.setOne(C.STORAGE_SYNC.ALARMS, cur);
        });
        alarmsBlock.appendChild(form);
        container.appendChild(alarmsBlock);

        // ─── Versions footer ──────────────────────────────────────────
        container.appendChild(el('div', 'muted xs mt-md', `web: ${escape(String(web))} · system: ${escape(String(sys))}`));
    }

    root.COR3.ui.overview = {
        // Subscribe-only mount; first render runs from activate(). Calling render
        // here would race the activate() render and double-paint (see logger fix
        // commit for the full pattern).
        //
        // We re-render only on DATA changes (timer values, job lists, expedition
        // counts, daily-ops result, alarms list). Toggle changes are NOT re-render
        // triggers — the user just clicked the switch, the DOM already shows
        // the new state, and a full repaint flickers the whole tab. Same goes
        // for the auto-refresh map (a per-market sub-toggle). The handful of
        // controls in the Alarms add-form re-render naturally when ALARMS
        // (the visible list) changes — that's a real data update.
        mount(container) {
            unsubs.push(Store.local.onChanged((changes) => {
                if (!container.classList.contains('active')) return;
                if (changes[C.STORAGE_LOCAL.DAILY_OPS] || changes[C.STORAGE_LOCAL.DAILY_HACK_LOG] ||
                    changes[C.STORAGE_LOCAL.MARKET] ||
                    changes[C.STORAGE_LOCAL.DARK_MARKET] || changes[C.STORAGE_LOCAL.SRM_MARKET] ||
                    changes[C.STORAGE_LOCAL.EXPEDITIONS] ||
                    changes[C.STORAGE_LOCAL.WEB_VERSION] || changes[C.STORAGE_LOCAL.SYSTEM_VERSION] ||
                    // Per-market in-progress count is derived from these.
                    changes[C.STORAGE_LOCAL.AUTOJOBS_QUEUE] || changes[C.STORAGE_LOCAL.AUTOJOBS_STATE]) {
                    render(container);
                }
            }));
            unsubs.push(Store.sync.onChanged((changes) => {
                if (!container.classList.contains('active')) return;
                // Alarms list IS data — counts and items change visibly.
                // Everything else (toggle flags) is the user's own click.
                if (changes[C.STORAGE_SYNC.ALARMS]) render(container);
            }));
        },
        activate(container) { render(container); },
        deactivate() { clearTimers(); },
    };
})();
