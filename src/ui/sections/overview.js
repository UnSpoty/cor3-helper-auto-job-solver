// src/ui/sections/overview.js
// Main dashboard. Aggregates everything that's "at-a-glance" useful:
//   • Daily Ops card — timer + Auto daily-hack toggle (toggle lives WITH
//     the timer because they're thematically the same thing)
//   • Markets cards (home + dark) — each card carries its own Auto-refresh
//     toggle (was a separate "Auto-refresh markets" section; merged in to
//     keep market controls together with the market they affect)
//   • Auto solvers — Auto-decrypt only (auto-daily-hack moved to Daily Ops)
//   • Game appearance — system messages, background, network fog, map FX
//   • Alarms (collapsible <details>, default open) — list + add form
//   • Versions footer (web / system)
//
// Active expeditions and pending decisions live in the Expeditions tab.

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
    function genAlarmId() { return 'alarm_' + Date.now() + '_' + Math.floor(Math.random() * 1000); }

    const ALARM_TIMER_LABELS = {
        daily: 'Daily Ops', home_jobs: 'Home Market reset', dark_jobs: 'Dark Market reset',
    };

    function appearanceToggle(label, key, currentValue) {
        const row = el('div', 'card');
        row.innerHTML = `
            <div class="card-row">
                <span class="card-label">${escape(label)}</span>
                <label class="switch"><input type="checkbox" ${currentValue ? 'checked' : ''}><span class="switch-slider"></span></label>
            </div>
        `;
        row.querySelector('input').addEventListener('change', (e) => Store.sync.setOne(key, e.target.checked));
        return row;
    }

    async function render(container) {
        clearTimers();
        container.innerHTML = '';

        const [
            daily, market, dark, darkAvail,
            web, sys,
            autoRefresh, autoDecrypt, autoDailyHack,
            disableSystemMessages, disableBackground, disableNetworkFog, disableMapFx,
            alarms, exps,
        ] = await Promise.all([
            Store.local.getOne(C.STORAGE_LOCAL.DAILY_OPS),
            Store.local.getOne(C.STORAGE_LOCAL.MARKET),
            Store.local.getOne(C.STORAGE_LOCAL.DARK_MARKET),
            Store.local.getOne(C.STORAGE_LOCAL.DARK_MARKET_AVAILABLE, true),
            Store.local.getOne(C.STORAGE_LOCAL.WEB_VERSION, '?'),
            Store.local.getOne(C.STORAGE_LOCAL.SYSTEM_VERSION, '?'),
            Store.sync.getOne(C.STORAGE_SYNC.AUTO_REFRESH, { home_jobs: false, dark_jobs: false }),
            Store.sync.getOne(C.STORAGE_SYNC.AUTO_DECRYPT_ENABLED, false),
            Store.sync.getOne(C.STORAGE_SYNC.AUTO_DAILY_HACK_ENABLED, false),
            Store.sync.getOne(C.STORAGE_SYNC.DISABLE_SYSTEM_MESSAGES, false),
            Store.sync.getOne(C.STORAGE_SYNC.DISABLE_BACKGROUND, false),
            Store.sync.getOne(C.STORAGE_SYNC.DISABLE_NETWORK_FOG, false),
            Store.sync.getOne('disableMapFxEnabled', false),
            Store.sync.getOne(C.STORAGE_SYNC.ALARMS, []),
            Store.local.getOne(C.STORAGE_LOCAL.EXPEDITIONS, []),
        ]);

        const ar = autoRefresh || { home_jobs: false, dark_jobs: false };

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
            dailyCard.appendChild(el('div', 'muted sm', 'No daily ops data yet.'));
        }
        // Auto-daily-hack lives here, with the timer it's solving for.
        const dhRow = el('div', 'card-row mt-sm');
        dhRow.innerHTML = `
            <span class="card-label">Auto daily-hack</span>
            <label class="switch"><input type="checkbox" ${autoDailyHack ? 'checked' : ''}><span class="switch-slider"></span></label>
        `;
        dhRow.querySelector('input').addEventListener('change', (e) =>
            Store.sync.setOne(C.STORAGE_SYNC.AUTO_DAILY_HACK_ENABLED, e.target.checked));
        dailyCard.appendChild(dhRow);
        const dailyRefresh = el('button', 'btn small mt-sm', 'Refresh');
        dailyRefresh.addEventListener('click', () => sendToContent('fetchDailyOps'));
        dailyCard.appendChild(dailyRefresh);
        container.appendChild(dailyCard);

        // ─── Markets ──────────────────────────────────────────────────
        container.appendChild(el('div', 'section-title', 'Markets'));

        function marketCard(label, data, available, isDark) {
            const card = el('div', 'card');
            const head = el('div', 'card-row');
            head.appendChild(el('span', 'card-label',
                `${label}${(isDark && available === false) ? ' · unreachable' : ''}`));
            if (data && data.nextJobsResetAt && (!isDark || available !== false)) {
                const t = uiComponents.timer.create(data.nextJobsResetAt);
                timerInstances.push(t);
                head.appendChild(t.el);
            } else {
                head.appendChild(el('span', 'muted sm', '—'));
            }
            card.appendChild(head);

            const jobs = (data && Array.isArray(data.jobs)) ? data.jobs : [];
            card.appendChild(el('div', 'sm muted mt-sm', `${jobs.length} job(s) on the board`));

            // Per-market auto-refresh toggle (was a separate AUTO-REFRESH MARKETS section).
            const arKey = isDark ? 'dark_jobs' : 'home_jobs';
            const arRow = el('div', 'card-row mt-sm');
            arRow.innerHTML = `
                <span class="card-label">Auto-refresh</span>
                <label class="switch"><input type="checkbox" ${ar[arKey] ? 'checked' : ''}><span class="switch-slider"></span></label>
            `;
            arRow.querySelector('input').addEventListener('change', async (e) => {
                const cur = (await Store.sync.getOne(C.STORAGE_SYNC.AUTO_REFRESH, {})) || {};
                cur[arKey] = e.target.checked;
                await Store.sync.setOne(C.STORAGE_SYNC.AUTO_REFRESH, cur);
            });
            card.appendChild(arRow);

            const btnRow = el('div', 'row gap-sm mt-sm');
            const refresh = el('button', 'btn small', 'Refresh');
            refresh.addEventListener('click', () =>
                sendToContent(isDark ? 'refreshDarkMarket' : 'refreshMarket'));
            btnRow.appendChild(refresh);
            card.appendChild(btnRow);
            return card;
        }
        container.appendChild(marketCard('Home Market', market, true, false));
        container.appendChild(marketCard('Dark Market', dark, darkAvail, true));

        // ─── Auto solvers (auto-decrypt only — auto-daily-hack lives in Daily Ops) ──
        container.appendChild(el('div', 'section-title', 'Auto solvers'));
        container.appendChild(appearanceToggle('Auto-decrypt', C.STORAGE_SYNC.AUTO_DECRYPT_ENABLED, autoDecrypt));

        // ─── Game appearance ──────────────────────────────────────────
        container.appendChild(el('div', 'section-title', 'Game appearance'));
        container.appendChild(appearanceToggle('Hide system messages', C.STORAGE_SYNC.DISABLE_SYSTEM_MESSAGES, disableSystemMessages));
        container.appendChild(appearanceToggle('Disable background', C.STORAGE_SYNC.DISABLE_BACKGROUND, disableBackground));
        container.appendChild(appearanceToggle('Disable network fog', C.STORAGE_SYNC.DISABLE_NETWORK_FOG, disableNetworkFog));
        container.appendChild(appearanceToggle('Disable map FX', 'disableMapFxEnabled', disableMapFx));

        // ─── Alarms (collapsible — at the bottom, takes a lot of vertical space) ──
        const alarmLabels = Object.assign({}, ALARM_TIMER_LABELS);
        for (const e of exps || []) alarmLabels['exp_' + e.id] = `${e.locationName || 'Expedition'} — ${e.zoneName || ''}`;
        const alarmsBlock = document.createElement('details');
        alarmsBlock.className = 'collapsible';
        alarmsBlock.open = true;
        const summary = document.createElement('summary');
        summary.className = 'section-title';
        summary.textContent = `Alarms (${(alarms || []).length})`;
        alarmsBlock.appendChild(summary);

        if (!alarms || alarms.length === 0) {
            alarmsBlock.appendChild(el('div', 'empty', 'No alarms configured.'));
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

        alarmsBlock.appendChild(el('div', 'section-title', 'Add alarm'));
        const form = el('div', 'card');
        const opts = Object.entries(alarmLabels).map(([k, v]) => `<option value="${k}">${escape(v)}</option>`).join('');
        form.innerHTML = `
            <div class="row gap-sm"><span class="card-label flex1">Timer</span><select id="al-timer">${opts}</select></div>
            <div class="row gap-sm mt-sm"><span class="card-label flex1">Threshold (sec)</span><input type="number" id="al-thresh" min="1" value="60" style="width: 80px;"></div>
            <div class="row gap-sm mt-sm"><span class="card-label flex1">Volume (%)</span><input type="range" id="al-vol" min="10" max="100" value="50" style="width: 120px;"></div>
            <div class="row gap-sm mt-sm"><span class="card-label flex1">Continuous</span><label class="switch"><input type="checkbox" id="al-cont"><span class="switch-slider"></span></label></div>
            <div class="row gap-sm mt-sm">
                <button class="btn small" id="al-test">Test</button>
                <button class="btn small" id="al-add">Add</button>
                <button class="btn btn-danger small" id="al-stop">Stop all</button>
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
        mount(container) {
            unsubs.push(Store.local.onChanged((changes) => {
                if (!container.classList.contains('active')) return;
                if (changes[C.STORAGE_LOCAL.DAILY_OPS] || changes[C.STORAGE_LOCAL.MARKET] ||
                    changes[C.STORAGE_LOCAL.DARK_MARKET] || changes[C.STORAGE_LOCAL.EXPEDITIONS] ||
                    changes[C.STORAGE_LOCAL.WEB_VERSION] || changes[C.STORAGE_LOCAL.SYSTEM_VERSION]) {
                    render(container);
                }
            }));
            unsubs.push(Store.sync.onChanged((changes) => {
                if (!container.classList.contains('active')) return;
                if (changes[C.STORAGE_SYNC.ALARMS]
                    || changes[C.STORAGE_SYNC.AUTO_REFRESH]
                    || changes[C.STORAGE_SYNC.AUTO_DECRYPT_ENABLED]
                    || changes[C.STORAGE_SYNC.AUTO_DAILY_HACK_ENABLED]
                    || changes[C.STORAGE_SYNC.DISABLE_SYSTEM_MESSAGES]
                    || changes[C.STORAGE_SYNC.DISABLE_BACKGROUND]
                    || changes[C.STORAGE_SYNC.DISABLE_NETWORK_FOG]
                    || changes.disableMapFxEnabled) {
                    render(container);
                }
            }));
        },
        activate(container) { render(container); },
        deactivate() { clearTimers(); },
    };
})();
