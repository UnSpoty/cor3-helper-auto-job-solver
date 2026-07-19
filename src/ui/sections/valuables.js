// src/ui/sections/valuables.js
// «Valuables» tab — UI for the Valuable Seller (scan reachable servers for
// valuable files/logs → select → download + sell at the markets). Pure view
// over STORAGE_LOCAL.VS_STATE (written by the isolated valuable-seller
// orchestrator); actions go out as chrome.tabs.sendMessage runtime actions
// (MSG.VALUABLE.SCAN_ACTION / SELL_ACTION / STOP_ACTION / SELECT_ACTION).

(function () {
    const root = window;
    root.COR3.ui = root.COR3.ui || {};
    const { Store, constants: C } = root.COR3;
    const VS = C.MSG.VALUABLE;
    const t = (k, vars) => root.COR3.i18n.t(k, vars);

    function el(tag, cls, html) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (html !== undefined) e.innerHTML = html;
        return e;
    }
    function escape(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    const fmt = (n) => (Number(n) || 0).toLocaleString('en-US').replace(/,/g, ' ');

    async function getCor3Tab() {
        const [tab] = await chrome.tabs.query({ url: ['https://cor3.gg/*', 'https://os.cor3.gg/*'] });
        return tab || null;
    }
    async function sendAction(type, payload) {
        const tab = await getCor3Tab();
        if (!tab) return { success: false, reason: 'no-tab' };
        let resp;
        try {
            resp = await chrome.tabs.sendMessage(tab.id, { type, payload: payload || {} });
        } catch (_) {
            // "Receiving end does not exist" — tab open but running an old
            // content script (extension reloaded, cor3.gg tab never refreshed).
            return { success: false, reason: 'no-content-script' };
        }
        if (resp === undefined || resp === null) return { success: false, reason: 'no-content-script' };
        return resp;
    }
    function refuseText(resp) {
        const reason = (resp && resp.reason) || 'unknown';
        const key = `vs.refused.${reason}`;
        const txt = t(key);
        return txt === key ? t('vs.refused.generic', { reason }) : txt;
    }

    let panel = null;
    let unsubStorage = null;
    let unsubSync = null;

    // ── Derived stats over VS_STATE ──────────────────────────────────────────
    function serverValue(s) {
        const f = (s.files || []).reduce((a, x) => a + (Number(x.basePrice) || 0), 0);
        const l = (s.logs || []).reduce((a, x) => a + (Number(x.basePrice) || 0), 0);
        return f + l;
    }
    function hasFinds(s) { return s.status === 'open' || s.status === 'downloaded'; }
    function stats(state) {
        const servers = state.servers || [];
        let foundCount = 0, foundValue = 0, openCount = 0;
        for (const s of servers) {
            foundCount += (s.files || []).length + (s.logs || []).length;
            foundValue += serverValue(s);
            if (s.status === 'open') openCount++;
        }
        return { candidates: servers.length, openCount, foundCount, foundValue,
            lastRun: state.lastRun || null, lifetime: state.lifetime || { credits: 0, rep: 0, items: 0 } };
    }

    function statTile(label, big, sub, cls) {
        const tile = el('div', 'vs-tile');
        tile.appendChild(el('div', `vs-tile-num ${cls || ''}`, big));
        tile.appendChild(el('div', 'vs-tile-label muted xs', escape(label)));
        if (sub) tile.appendChild(el('div', 'vs-tile-sub muted xs', sub));
        return tile;
    }
    function statusChip(s) {
        const cls = { open: 'ok', skipped: 'warn', downloaded: 'ok' }[s.status] || 'idle';
        const label = t(`vs.status.${s.status}`);
        return `<span class="pill ${cls}">${escape(label)}</span>`;
    }
    function itemLine(kind, name, price, tags) {
        const tagStr = (tags || []).map((x) => escape(x.label || x.key)).join(', ');
        return `<div class="muted xs vs-item">${kind} ${escape(name)} — <b>💰${fmt(price)}</b>${tagStr ? ` · <span class="muted">${tagStr}</span>` : ''}</div>`;
    }

    // ── Renderers ────────────────────────────────────────────────────────────
    function renderTiles(state) {
        const st = stats(state);
        const statusTxt = state.running ? (state.mode === 'sell' ? t('vs.state.sell') : t('vs.state.scan')) : t('vs.state.idle');
        const tiles = el('div', 'vs-tiles');
        tiles.appendChild(statTile(t('vs.stat.status'), escape(statusTxt), state.scannedAt ? `${new Date(state.scannedAt).toLocaleTimeString()}` : '', state.running ? 'ok' : ''));
        tiles.appendChild(statTile(t('vs.stat.candidates'), String(st.candidates), st.openCount ? `${st.openCount} ${t('vs.withValuables')}` : ''));
        tiles.appendChild(statTile(t('vs.stat.found'), String(st.foundCount), st.foundValue ? `~💰${fmt(st.foundValue)}` : ''));
        tiles.appendChild(statTile(t('vs.stat.thisRun'), st.lastRun ? `💰${fmt(st.lastRun.credits)}` : '—', st.lastRun ? `${fmt(st.lastRun.items)} ${t('vs.itemsShort')} · +${fmt(st.lastRun.rep)} ${t('vs.repShort')}` : '', st.lastRun && st.lastRun.credits ? 'ok' : ''));
        tiles.appendChild(statTile(t('vs.stat.lifetime'), `💰${fmt(st.lifetime.credits)}`, `${fmt(st.lifetime.items)} ${t('vs.itemsShort')} · +${fmt(st.lifetime.rep)} ${t('vs.repShort')}`, st.lifetime.credits ? 'ok' : ''));
        panel.tilesHost.replaceChildren(tiles);
    }

    function renderServers(state) {
        const host = panel.serversHost;
        // A SERVER_RESULT arrives roughly once a second during a scan and
        // triggers a full re-render. Capture the list's scroll offset so the
        // rebuild below can restore it — otherwise every new server yanks the
        // user back to the top mid-scroll.
        const prevList = host.querySelector('.vs-srv-list');
        const prevScroll = prevList ? prevList.scrollTop : 0;
        const all = state.servers || [];
        const openCount = all.filter((s) => s.status === 'open').length;
        // Title + count. Sync the segmented filter's active state.
        panel.srvTitle.textContent = `${t('vs.servers')} (${all.length}${openCount ? ` · ${openCount} ${t('vs.withValuables')}` : ''})`;
        const mode = panel.filterMode || 'finds';
        panel.segFinds.classList.toggle('active', mode === 'finds');
        panel.segAll.classList.toggle('active', mode === 'all');

        if (!all.length) { host.replaceChildren(el('div', 'muted sm vs-empty', escape(t('vs.noScan')))); return; }
        const shown = mode === 'all' ? all : all.filter(hasFinds);
        if (!shown.length) {
            host.replaceChildren(el('div', 'muted sm vs-empty', escape(t('vs.noFinds', { n: all.length }))));
            return;
        }
        const listWrap = el('div', 'vs-srv-list');
        for (const s of shown) {
            const wrap = el('div', 'vs-row-wrap');
            const val = serverValue(s);
            const nf = (s.files || []).length, nl = (s.logs || []).length;
            const head = el('div', 'vs-row');
            head.innerHTML = `
                <input type="checkbox" data-act="sel" data-id="${escape(s.id)}" ${s.selected ? 'checked' : ''}>
                <span class="nm" title="${escape(s.name)}">${escape(s.name)}</span>
                <span class="meta">${nf}${t('vs.filesShort')}·${nl}${t('vs.logsShort')}${val > 0 ? ` · 💰${fmt(val)}` : ''} ${statusChip(s)}</span>`;
            wrap.appendChild(head);
            const detail = (nf + nl) > 0;
            if (detail) {
                const body = el('div', 'vs-row-body');
                for (const f of (s.files || [])) body.insertAdjacentHTML('beforeend', itemLine('📄', f.name, f.basePrice, f.tags));
                for (const l of (s.logs || [])) body.insertAdjacentHTML('beforeend', itemLine('📜', l.name || l.message, l.basePrice, l.tags));
                wrap.appendChild(body);
                // Expanded state lives in panel.openIds (not the DOM), so the
                // rebuild doesn't collapse rows the user opened mid-scan.
                if (panel.openIds.has(s.id)) wrap.classList.add('open');
                head.addEventListener('click', (e) => {
                    if (e.target && e.target.matches('input')) return;
                    if (wrap.classList.toggle('open')) panel.openIds.add(s.id);
                    else panel.openIds.delete(s.id);
                });
                head.classList.add('expandable');
            }
            listWrap.appendChild(wrap);
        }
        host.replaceChildren(listWrap);
        listWrap.scrollTop = prevScroll;
    }

    function renderDownloads(state) {
        const files = state.downloads || [];
        panel.dlSummary.textContent = `${t('vs.downloads')} (${files.length})`;
        if (!files.length) { panel.downloadsHost.replaceChildren(el('div', 'muted xs', '—')); return; }
        const list = el('div');
        for (const f of files) {
            const tagStr = (f.tags || []).map((x) => escape(x.label || x.key)).join(', ');
            list.appendChild(el('div', 'muted xs', `📄 ${escape(f.name)}${f.source ? ` — ${escape(f.source)}` : ''}${tagStr ? ` · ${tagStr}` : ''}`));
        }
        panel.downloadsHost.replaceChildren(list);
    }

    function renderLog(state) {
        const host = panel.logHost;
        // Stick to the bottom only if the user is already there — don't yank
        // the view down while they're scrolled up reading earlier lines.
        const atBottom = host.scrollHeight - host.scrollTop - host.clientHeight < 8;
        const lines = (state.log || []).slice(-25);
        const list = document.createDocumentFragment();
        for (const ln of lines) {
            const time = new Date(ln.ts).toLocaleTimeString();
            list.appendChild(el('div', `xs ${ln.level === 'error' ? 'err' : ln.level === 'warn' ? 'warn' : 'muted'}`, `[${time}] ${escape(ln.msg)}`));
        }
        host.replaceChildren(list);
        if (atBottom) host.scrollTop = host.scrollHeight;
    }

    // Auto Jobs owns the endpoint + the SAI session, so the two subsystems
    // must never run at once. Lock Scan/Sell whenever Auto Jobs is enabled OR
    // its loop is live (the orchestrator's _guard enforces the same server-side).
    async function readAjLocked() {
        const [aj, s] = await Promise.all([
            Store.local.getOne(C.STORAGE_LOCAL.AJ_PIPELINE_STATE),
            Store.sync.getOne(C.STORAGE_SYNC.AUTOJOBS_SETTINGS, { enabled: false }),
        ]);
        return !!(s && s.enabled) || !!(aj && aj.running);
    }
    function syncButtons() {
        if (!panel) return;
        const vsRunning = !!panel.vsRunning, locked = !!panel.ajLocked;
        panel.scanBtn.disabled = vsRunning || locked;
        panel.sellBtn.disabled = vsRunning || locked;
        panel.stopBtn.disabled = !vsRunning;
        panel.lockNote.style.display = locked ? '' : 'none';
    }
    async function updateAjLock() {
        if (!panel) return;
        panel.ajLocked = await readAjLocked();
        syncButtons();
    }

    function renderState(state) {
        if (!panel) return;
        panel.vsRunning = !!state.running;
        syncButtons();
        renderTiles(state);
        renderServers(state);
        renderDownloads(state);
        renderLog(state);
    }

    async function refresh() {
        const state = (await Store.local.getOne(C.STORAGE_LOCAL.VS_STATE)) || { running: false, servers: [], downloads: [], log: [] };
        renderState(state);
    }

    function ensureStyles() {
        if (document.getElementById('vs-styles')) return;
        const css = `
        .vs-tiles{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
        .vs-tile{flex:1 1 84px;min-width:80px;background:var(--os-color-bg-card);border:1px solid var(--os-color-border-secondary);border-radius:8px;padding:7px 9px}
        .vs-tile-num{font-size:15px;font-weight:700;line-height:1.15}
        .vs-tile-num.ok{color:var(--os-color-success)}
        .vs-tile-label{margin-top:2px;text-transform:uppercase;letter-spacing:.04em}
        .vs-tile-sub{margin-top:1px}
        .vs-toolbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;background:var(--os-color-bg-card);border:1px solid var(--os-color-border-secondary);border-radius:8px;padding:5px 7px;margin-top:8px}
        .vs-toolbar .vs-tb-title{font-size:12px;color:var(--os-color-text-secondary);margin-right:auto;font-weight:600}
        .vs-seg{display:inline-flex;border:1px solid var(--os-color-border-secondary);border-radius:6px;overflow:hidden}
        .vs-seg button{border:0;background:transparent;color:var(--os-color-text-secondary);padding:3px 9px;font-size:11px;cursor:pointer;line-height:1.6}
        .vs-seg button:not(:last-child){border-right:1px solid var(--os-color-border-secondary)}
        .vs-seg button.active{background:var(--os-color-primary-hex);color:var(--os-color-surface)}
        .vs-seg button:hover:not(.active){background:var(--os-color-hover-bg)}
        .vs-srv-list{margin-top:6px;max-height:300px;overflow-y:auto;border:1px solid var(--os-color-border-secondary);border-radius:8px;background:var(--os-color-bg-card)}
        .vs-row-wrap{border-bottom:1px solid var(--os-color-border-secondary)}
        .vs-row-wrap:last-child{border-bottom:0}
        .vs-row{display:flex;align-items:center;gap:8px;padding:6px 9px;font-size:12px}
        .vs-row.expandable{cursor:pointer}
        .vs-row .nm{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:130px}
        .vs-row .meta{margin-left:auto;display:flex;align-items:center;gap:6px;color:var(--os-color-text-secondary);font-size:10px;white-space:nowrap}
        .vs-row-body{display:none;padding:0 9px 7px 30px}
        .vs-row-wrap.open .vs-row-body{display:block}
        .vs-item{padding:1px 0}
        .vs-empty{padding:14px 6px;text-align:center}
        .vs-log{margin-top:6px;max-height:150px;overflow-y:auto;background:var(--os-color-bg-card);border:1px solid var(--os-color-border-secondary);border-radius:8px;padding:6px 8px}
        .vs-log>div{padding:1px 0;line-height:1.4}
        .vs-log:empty::after{content:'—';color:var(--os-color-text-secondary)}
        .vs-lock{margin-top:8px;font-size:11px;line-height:1.45;color:var(--os-color-text-secondary);background:var(--os-color-bg-card);border:1px solid var(--os-color-border-secondary);border-left:3px solid var(--os-color-primary-hex);border-radius:6px;padding:6px 9px}
        `;
        const style = document.createElement('style');
        style.id = 'vs-styles';
        style.textContent = css;
        document.head.appendChild(style);
    }

    async function render(container) {
        ensureStyles();
        container.innerHTML = '';

        container.appendChild(el('div', 'section-title', escape(t('vs.title'))));

        // Stat tiles
        const tilesHost = el('div');
        container.appendChild(tilesHost);

        // Controls
        const controls = el('div', 'row gap-sm mt-sm');
        const scanBtn = el('button', 'btn small', escape(t('vs.scan')));
        const sellBtn = el('button', 'btn small btn-success', escape(t('vs.sellSelected')));
        const stopBtn = el('button', 'btn btn-danger small', escape(t('common.stop')));
        controls.appendChild(scanBtn); controls.appendChild(sellBtn); controls.appendChild(stopBtn);
        container.appendChild(controls);

        // Shown while Auto Jobs is enabled — Scan/Sell are locked out (they
        // share the endpoint + SAI session with the Auto Jobs loop).
        const lockNote = el('div', 'vs-lock', `🔒 ${escape(t('vs.lockedByAutoJobs'))}`);
        lockNote.style.display = 'none';
        container.appendChild(lockNote);

        const errEl = el('div', 'warn xs mt-sm');
        container.appendChild(errEl);

        // Servers toolbar (title · view filter · selection) — grouped in a
        // styled bar so the controls read as one unit, not floating chips.
        const bar = el('div', 'vs-toolbar');
        const srvTitle = el('div', 'vs-tb-title', escape(t('vs.servers')));
        const seg = el('div', 'vs-seg');
        const segFinds = el('button', '', escape(t('vs.filterFinds')));
        const segAll = el('button', '', escape(t('vs.filterAll')));
        seg.appendChild(segFinds); seg.appendChild(segAll);
        const selAllBtn = el('button', 'btn small', escape(t('vs.selectAll')));
        const selNoneBtn = el('button', 'btn small', escape(t('vs.selectNone')));
        bar.appendChild(srvTitle); bar.appendChild(seg); bar.appendChild(selAllBtn); bar.appendChild(selNoneBtn);
        container.appendChild(bar);
        const serversHost = el('div');
        container.appendChild(serversHost);

        // Downloads (collapsible)
        const dlBlock = document.createElement('details');
        dlBlock.className = 'collapsible mt-sm';
        const dlSummary = document.createElement('summary');
        dlSummary.className = 'section-title';
        dlSummary.textContent = t('vs.downloads');
        dlBlock.appendChild(dlSummary);
        const downloadsHost = el('div');
        dlBlock.appendChild(downloadsHost);
        container.appendChild(dlBlock);

        // Activity log (collapsible)
        const logBlock = document.createElement('details');
        logBlock.className = 'collapsible mt-sm';
        const logSummary = document.createElement('summary');
        logSummary.className = 'section-title';
        logSummary.textContent = t('vs.activity');
        logBlock.appendChild(logSummary);
        const logHost = el('div', 'vs-log');
        logBlock.appendChild(logHost);
        container.appendChild(logBlock);

        panel = { tilesHost, scanBtn, sellBtn, stopBtn, errEl, lockNote, serversHost, downloadsHost, dlSummary, logHost,
            srvTitle, segFinds, segAll, filterMode: 'finds', openIds: new Set(), vsRunning: false, ajLocked: false };

        scanBtn.addEventListener('click', async () => {
            errEl.textContent = '';
            const resp = await sendAction(VS.SCAN_ACTION);
            if (!resp || !resp.success) errEl.textContent = refuseText(resp);
        });
        sellBtn.addEventListener('click', async () => {
            errEl.textContent = '';
            const state = (await Store.local.getOne(C.STORAGE_LOCAL.VS_STATE)) || { servers: [] };
            const serverIds = (state.servers || []).filter((s) => s.selected).map((s) => s.id);
            const resp = await sendAction(VS.SELL_ACTION, { serverIds });
            if (!resp || !resp.success) errEl.textContent = refuseText(resp);
        });
        stopBtn.addEventListener('click', async () => {
            errEl.textContent = '';
            const resp = await sendAction(VS.STOP_ACTION);
            if (!resp || !resp.success) errEl.textContent = refuseText(resp);
        });

        // View filter (which rows are shown) — client-side, no round-trip.
        const setFilter = (m) => { panel.filterMode = m; refresh(); };
        segFinds.addEventListener('click', () => setFilter('finds'));
        segAll.addEventListener('click', () => setFilter('all'));

        // Checkbox delegation (survives re-renders — bound on the stable host).
        serversHost.addEventListener('change', (e) => {
            if (e.target.dataset.act !== 'sel') return;
            sendAction(VS.SELECT_ACTION, { serverId: e.target.dataset.id, selected: e.target.checked });
        });
        // Selection ops apply to VISIBLE rows: "All" selects the shown set,
        // "None" clears everything.
        const applySelect = async (pred) => {
            const state = (await Store.local.getOne(C.STORAGE_LOCAL.VS_STATE)) || { servers: [] };
            for (const s of (state.servers || [])) {
                const want = pred(s);
                if (!!s.selected !== want) await sendAction(VS.SELECT_ACTION, { serverId: s.id, selected: want });
            }
        };
        const visible = (s) => panel.filterMode === 'all' ? true : hasFinds(s);
        selAllBtn.addEventListener('click', () => applySelect((s) => visible(s) ? true : !!s.selected));
        selNoneBtn.addEventListener('click', () => applySelect(() => false));

        await refresh();
        await updateAjLock();
    }

    root.COR3.ui.valuables = {
        mount() {},
        activate(container) {
            render(container);
            if (unsubStorage) { try { unsubStorage(); } catch (_) {} }
            unsubStorage = Store.local.onChanged((changes) => {
                if (changes[C.STORAGE_LOCAL.VS_STATE]) renderState(changes[C.STORAGE_LOCAL.VS_STATE].newValue || {});
                // Auto Jobs starting/stopping its loop re-evaluates the lock.
                if (changes[C.STORAGE_LOCAL.AJ_PIPELINE_STATE]) updateAjLock();
            });
            // The Auto Jobs enable toggle lives in chrome.storage.sync.
            if (unsubSync) { try { unsubSync(); } catch (_) {} }
            unsubSync = Store.sync.onChanged((changes) => {
                if (changes[C.STORAGE_SYNC.AUTOJOBS_SETTINGS]) updateAjLock();
            });
        },
        deactivate() {
            if (unsubStorage) { try { unsubStorage(); } catch (_) {} unsubStorage = null; }
            if (unsubSync) { try { unsubSync(); } catch (_) {} unsubSync = null; }
            panel = null;
        },
    };
})();
