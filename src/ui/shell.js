// src/ui/shell.js
// Popup entry. Mode detection (?mode=popout), tab routing, section lifecycle,
// language switcher, no-tab gate, version-mismatch banner, locked Expeditions
// tab.

(function () {
    const root = window;
    const C = root.COR3.constants;
    const i18n = root.COR3.i18n;
    const Store = root.COR3.Store;

    // The web client we tested against. Bumping this every release would
    // produce noise — only nudge when we actually rely on a new field. The
    // banner doesn't disable the extension; it just warns the user that
    // their game version is outside the tested range.
    const EXPECTED_WEB_VERSION = '1.18.188';

    const TABS = [
        { id: 'overview',    labelKey: 'tabs.overview' },
        { id: 'expeditions', labelKey: 'tabs.expeditions' },
        { id: 'autojobs',    labelKey: 'tabs.autojobs' },
        { id: 'modules',     labelKey: 'tabs.modules' },
        { id: 'logs',        labelKey: 'tabs.logs' },
    ];

    // Mode detection
    const params = new URLSearchParams(location.search);
    if (params.get('mode') === 'popout') document.body.classList.add('mode-popout');

    // ─── Theme switcher ───────────────────────────────────────────────
    // Default cor3-style theme is the palette baked into popup.css's :root.
    // Optional themes are layered as `body.theme-<name>` overrides; the
    // 'amber-console' theme mimics the retro CRT look from the
    // cor3-auto-Mission competitor. selectedTheme is one of:
    //   'cor3' (or undefined/null) — default; no class applied
    //   'amber-console'           — body.theme-amber-console
    const THEME_CLASSES = ['theme-amber-console'];
    function applyTheme(name) {
        for (const cls of THEME_CLASSES) document.body.classList.remove(cls);
        if (name === 'amber-console') document.body.classList.add('theme-amber-console');
    }
    // Sync apply happens before tabs render — read storage and toggle the
    // class. We don't await this (boot proceeds in parallel); the worst
    // case is a single-frame flash of default colors before amber kicks in.
    Store.sync.getOne(C.STORAGE_SYNC.SELECTED_THEME, 'cor3').then(applyTheme);
    Store.sync.onChanged((changes) => {
        if (changes[C.STORAGE_SYNC.SELECTED_THEME]) {
            applyTheme(changes[C.STORAGE_SYNC.SELECTED_THEME].newValue);
        }
    });

    // ─── Language switcher ────────────────────────────────────────────
    // Hydrate the dropdown synchronously so the user sees something useful
    // even before chrome.storage.sync resolves; the chosen language is
    // applied once Store responds (a couple ms later).
    const langSelect = document.getElementById('langSelect');
    for (const { code, label } of i18n.LANGS) {
        const opt = document.createElement('option');
        opt.value = code;
        opt.textContent = label;
        langSelect.appendChild(opt);
    }

    async function loadLanguage() {
        const lang = await Store.sync.getOne(i18n.STORAGE_KEY, 'en');
        i18n.set(lang);
        langSelect.value = i18n.get();
    }

    langSelect.addEventListener('change', async (e) => {
        const next = e.target.value;
        i18n.set(next);
        await Store.sync.setOne(i18n.STORAGE_KEY, next);
        applyStaticTranslations();
        // Re-render every section that's currently mounted so labels flip.
        rerenderActive();
    });

    // Re-render on cross-context language change (e.g. user changes it in
    // the side panel while the popup is open).
    Store.sync.onChanged((changes) => {
        if (!changes[i18n.STORAGE_KEY]) return;
        const v = changes[i18n.STORAGE_KEY].newValue;
        if (v && v !== i18n.get()) {
            i18n.set(v);
            langSelect.value = i18n.get();
            applyStaticTranslations();
            rerenderActive();
        }
    });

    // ─── Header buttons (titles get translated by applyStaticTranslations) ──
    document.getElementById('popOutBtn').addEventListener('click', () => {
        chrome.windows.create({
            url: chrome.runtime.getURL('src/ui/popup.html?mode=popout'),
            type: 'popup', width: 420, height: 700,
        });
        window.close();
    });
    document.getElementById('sidePanelBtn').addEventListener('click', async () => {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            const target = (tab && /cor3\.gg/.test(tab.url || '')) ? tab : (await chrome.tabs.query({ url: ['https://cor3.gg/*', 'https://os.cor3.gg/*'] }))[0];
            if (!target) return;
            await chrome.sidePanel.open({ tabId: target.id });
            window.close();
        } catch (_) {}
    });

    // ─── Tab strip + sections ─────────────────────────────────────────
    const tabsEl = document.getElementById('tabs');
    const sections = {};
    document.querySelectorAll('.section').forEach((s) => { sections[s.dataset.tab] = s; });

    function activate(tabId) {
        document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tabId));
        for (const id of Object.keys(sections)) {
            const on = id === tabId;
            sections[id].classList.toggle('active', on);
            if (on && root.COR3.ui && root.COR3.ui[id] && typeof root.COR3.ui[id].activate === 'function') {
                root.COR3.ui[id].activate(sections[id]);
            }
            if (!on && root.COR3.ui && root.COR3.ui[id] && typeof root.COR3.ui[id].deactivate === 'function') {
                root.COR3.ui[id].deactivate(sections[id]);
            }
        }
        try { localStorage.setItem('cor3.activeTab', tabId); } catch (_) {}
    }

    function buildTabs() {
        tabsEl.innerHTML = '';
        for (const t of TABS) {
            const btn = document.createElement('button');
            btn.className = 'tab';
            btn.dataset.tab = t.id;
            btn.dataset.labelKey = t.labelKey;
            btn.textContent = i18n.t(t.labelKey);
            btn.addEventListener('click', () => activate(t.id));
            tabsEl.appendChild(btn);
        }
    }

    function applyStaticTranslations() {
        // Header titles
        const popOut = document.getElementById('popOutBtn');
        const sidePanel = document.getElementById('sidePanelBtn');
        if (popOut) popOut.title = i18n.t('header.popOut');
        if (sidePanel) sidePanel.title = i18n.t('header.sidePanel');
        if (langSelect) langSelect.title = i18n.t('header.language');

        // Tab labels in place
        document.querySelectorAll('.tab[data-label-key]').forEach((el) => {
            el.textContent = i18n.t(el.dataset.labelKey);
        });

        // Re-render the version banner if it's visible (text depends on
        // language).
        renderVersionWarning();

        // No-tab placeholder is shown OUTSIDE the section system, so
        // rerenderActive() doesn't touch it. Re-render it explicitly so
        // the timer labels and gate copy flip with the language.
        if (!noTabEl.hidden) renderNoTab();
    }

    function rerenderActive() {
        const active = document.querySelector('.tab.active');
        if (!active) return;
        activate(active.dataset.tab);
    }

    // ─── Mount sections ─────────────────────────────────────────────
    function mountSections() {
        for (const id of Object.keys(sections)) {
            try {
                if (root.COR3.ui && root.COR3.ui[id] && typeof root.COR3.ui[id].mount === 'function') {
                    root.COR3.ui[id].mount(sections[id]);
                }
            } catch (e) {
                console.error(`[COR3.ui] mount ${id} failed`, e);
            }
        }
    }

    // ─── No-tab gate ──────────────────────────────────────────────────
    // Hide the entire shell (tabs + sections) when no cor3.gg tab is open.
    // The popup is useless in that state — it can't read live state via
    // chrome.scripting.executeScript and most controls send messages to a
    // tab that doesn't exist. Rather than render every section in an
    // empty/error state, we show a single "Open cor3.gg" placeholder.
    const appShell = document.getElementById('appShell');
    const noTabEl = document.getElementById('noTab');

    async function hasCor3Tab() {
        try {
            const tabs = await chrome.tabs.query({ url: ['https://cor3.gg/*', 'https://os.cor3.gg/*'] });
            return tabs && tabs.length > 0;
        } catch (_) { return false; }
    }

    // Countdown components attached to the no-tab placeholder. Tracked so
    // we can stop the per-instance setIntervals on re-render and avoid
    // ticking ghosts when the user opens cor3.gg and the placeholder hides.
    let noTabTimers = [];
    function clearNoTabTimers() {
        for (const tm of noTabTimers) try { tm.stop(); } catch (_) {}
        noTabTimers = [];
    }

    async function renderNoTab() {
        clearNoTabTimers();
        noTabEl.innerHTML = '';
        const title = document.createElement('div');
        title.className = 'nt-title';
        title.textContent = i18n.t('noTab.title');
        const body = document.createElement('div');
        body.className = 'nt-body';
        body.textContent = i18n.t('noTab.body');
        const btn = document.createElement('button');
        btn.className = 'btn';
        btn.textContent = i18n.t('noTab.openBtn');
        btn.addEventListener('click', () => {
            chrome.tabs.create({ url: 'https://cor3.gg/' });
            window.close();
        });
        noTabEl.appendChild(title);
        noTabEl.appendChild(body);
        noTabEl.appendChild(btn);

        // Last-known timers: Daily Ops + Home/Dark/SRM market resets.
        // Pulled from chrome.storage.local — populated by the data modules
        // during the previous live session. Even with no tab open the
        // countdown ticks correctly because the targets are absolute
        // wall-clock times. Markets that the live session marked as
        // unreachable show that label instead of a stale timer.
        const tm = root.COR3.uiComponents && root.COR3.uiComponents.timer;
        if (!tm) return;
        let daily, market, dark, darkAvail, srm, srmAvail;
        try {
            [daily, market, dark, darkAvail, srm, srmAvail] = await Promise.all([
                Store.local.getOne(C.STORAGE_LOCAL.DAILY_OPS),
                Store.local.getOne(C.STORAGE_LOCAL.MARKET),
                Store.local.getOne(C.STORAGE_LOCAL.DARK_MARKET),
                Store.local.getOne(C.STORAGE_LOCAL.DARK_MARKET_AVAILABLE, true),
                Store.local.getOne(C.STORAGE_LOCAL.SRM_MARKET),
                Store.local.getOne(C.STORAGE_LOCAL.SRM_MARKET_AVAILABLE, true),
            ]);
        } catch (_) { return; }

        const list = document.createElement('div');
        list.className = 'nt-timers';

        function row(label, target, isUnreachable) {
            const r = document.createElement('div');
            r.className = 'nt-timer-row';
            const lab = document.createElement('span');
            lab.className = 'nt-timer-label';
            lab.textContent = label;
            r.appendChild(lab);
            if (isUnreachable) {
                const un = document.createElement('span');
                un.className = 'muted sm';
                un.textContent = i18n.t('overview.unreachable');
                r.appendChild(un);
            } else if (target) {
                const inst = tm.create(target);
                noTabTimers.push(inst);
                r.appendChild(inst.el);
            } else {
                const dash = document.createElement('span');
                dash.className = 'muted sm';
                dash.textContent = '—';
                r.appendChild(dash);
            }
            return r;
        }

        list.appendChild(row(i18n.t('overview.dailyOps'), daily && daily.nextTaskTime, false));
        list.appendChild(row(i18n.t('overview.homeMarket'), market && market.nextJobsResetAt, false));
        list.appendChild(row(i18n.t('overview.darkMarket'), dark && dark.nextJobsResetAt, darkAvail === false));
        list.appendChild(row(i18n.t('overview.srm'), srm && srm.nextJobsResetAt, srmAvail === false));
        noTabEl.appendChild(list);
    }

    // Re-render the no-tab placeholder when the storage values backing
    // its timers change. Without a live cor3.gg tab they normally won't
    // — but if the user opens cor3.gg in another window while the popup
    // is still in this state, the data modules will land their first
    // payloads and we want the timers to refresh once before
    // syncTabState() flips the gate.
    Store.local.onChanged((changes) => {
        if (noTabEl.hidden) return;
        if (changes[C.STORAGE_LOCAL.DAILY_OPS] ||
            changes[C.STORAGE_LOCAL.MARKET] ||
            changes[C.STORAGE_LOCAL.DARK_MARKET] || changes[C.STORAGE_LOCAL.DARK_MARKET_AVAILABLE] ||
            changes[C.STORAGE_LOCAL.SRM_MARKET] || changes[C.STORAGE_LOCAL.SRM_MARKET_AVAILABLE]) {
            renderNoTab();
        }
    });

    let lastTabState = null;
    async function syncTabState() {
        const present = await hasCor3Tab();
        if (present === lastTabState) {
            // First call always renders so the placeholder gets text even
            // if state hasn't changed; subsequent calls only re-render on
            // an actual flip.
            if (lastTabState !== null) return;
        }
        lastTabState = present;
        if (present) {
            appShell.hidden = false;
            noTabEl.hidden = true;
            clearNoTabTimers();
        } else {
            appShell.hidden = true;
            noTabEl.hidden = false;
            await renderNoTab();
        }
    }

    // Re-check tab presence on tab create/remove/update events. We can't
    // listen for navigation directly (URL changes inside an existing tab
    // don't fire onCreated), so we hook onUpdated too.
    try {
        chrome.tabs.onCreated.addListener(syncTabState);
        chrome.tabs.onRemoved.addListener(syncTabState);
        chrome.tabs.onUpdated.addListener((_id, info) => { if (info.url) syncTabState(); });
    } catch (_) { /* permission missing */ }

    // ─── Version-mismatch warning ─────────────────────────────────────
    const versionWarningEl = document.getElementById('versionWarning');
    let cachedWebVersion = null;

    function renderVersionWarning() {
        if (!cachedWebVersion) {
            versionWarningEl.hidden = true;
            return;
        }
        if (cachedWebVersion === EXPECTED_WEB_VERSION) {
            versionWarningEl.hidden = true;
            return;
        }
        versionWarningEl.hidden = false;
        versionWarningEl.innerHTML = '';
        const title = document.createElement('div');
        title.innerHTML = `<strong>⚠ ${escapeHtml(i18n.t('version.warningTitle'))}</strong>`;
        const detail = document.createElement('div');
        detail.className = 'vw-detail';
        detail.textContent = i18n.t('version.warningBody', {
            expected: EXPECTED_WEB_VERSION,
            detected: cachedWebVersion || i18n.t('version.unknownDetected'),
        });
        versionWarningEl.appendChild(title);
        versionWarningEl.appendChild(detail);
    }
    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    // Strip the leading 'v' that the cor3.gg client sometimes attaches
    // (e.g. translation.json?v=v1.18.188) so the comparison against
    // EXPECTED_WEB_VERSION is symmetrical regardless of which form the
    // server returned this session.
    function normalizeVersion(v) {
        if (!v) return v;
        return String(v).replace(/^v/i, '').trim();
    }

    async function refreshVersion() {
        const raw = await Store.local.getOne(C.STORAGE_LOCAL.WEB_VERSION, null);
        const v = normalizeVersion(raw);
        if (v && v !== '?' && v !== cachedWebVersion) {
            cachedWebVersion = v;
            renderVersionWarning();
        } else if (!v && cachedWebVersion === null) {
            // Still unknown — hide for now; we'd rather show nothing than
            // a false alarm before the http-interceptor has a chance to
            // capture it.
        }
    }
    Store.local.onChanged((changes) => {
        if (changes[C.STORAGE_LOCAL.WEB_VERSION]) refreshVersion();
    });

    // ─── Boot ─────────────────────────────────────────────────────────
    (async () => {
        await loadLanguage();
        applyStaticTranslations();
        buildTabs();
        applyStaticTranslations();
        mountSections();
        await syncTabState();
        await refreshVersion();

        // Restore last active tab or default to overview.
        let initial = 'overview';
        try { initial = localStorage.getItem('cor3.activeTab') || 'overview'; } catch (_) {}
        if (!TABS.some((t) => t.id === initial)) initial = 'overview';
        activate(initial);
    })();
})();
