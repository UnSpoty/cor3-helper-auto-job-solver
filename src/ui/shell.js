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
        { id: 'expeditions', labelKey: 'tabs.expeditions', locked: true },
        { id: 'autojobs',    labelKey: 'tabs.autojobs' },
        { id: 'modules',     labelKey: 'tabs.modules' },
        { id: 'logs',        labelKey: 'tabs.logs' },
    ];

    // Mode detection
    const params = new URLSearchParams(location.search);
    if (params.get('mode') === 'popout') document.body.classList.add('mode-popout');

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
            if (on) {
                if (id === 'expeditions') {
                    // Locked tab: always render the placeholder, never the
                    // real expeditions UI.
                    renderLockedTab(sections[id]);
                } else if (root.COR3.ui && root.COR3.ui[id] && typeof root.COR3.ui[id].activate === 'function') {
                    root.COR3.ui[id].activate(sections[id]);
                }
            }
            if (!on && id !== 'expeditions' && root.COR3.ui && root.COR3.ui[id] && typeof root.COR3.ui[id].deactivate === 'function') {
                root.COR3.ui[id].deactivate(sections[id]);
            }
        }
        try { localStorage.setItem('cor3.activeTab', tabId); } catch (_) {}
    }

    function buildTabs() {
        tabsEl.innerHTML = '';
        for (const t of TABS) {
            const btn = document.createElement('button');
            btn.className = 'tab' + (t.locked ? ' disabled' : '');
            btn.dataset.tab = t.id;
            btn.dataset.labelKey = t.labelKey;
            btn.textContent = i18n.t(t.labelKey);
            if (t.locked) btn.title = i18n.t('expeditions.locked');
            btn.addEventListener('click', () => activate(t.id));
            tabsEl.appendChild(btn);
        }
    }

    function renderLockedTab(container) {
        container.innerHTML = '';
        const wrap = document.createElement('div');
        wrap.className = 'locked-tab';
        const title = document.createElement('div');
        title.className = 'lt-title';
        title.textContent = i18n.t('expeditions.locked');
        const body = document.createElement('div');
        body.className = 'lt-body';
        body.textContent = i18n.t('expeditions.lockedBody');
        wrap.appendChild(title);
        wrap.appendChild(body);
        container.appendChild(wrap);
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
    }

    function rerenderActive() {
        const active = document.querySelector('.tab.active');
        if (!active) return;
        activate(active.dataset.tab);
    }

    // ─── Mount sections (skip the locked Expeditions section so it never
    //     calls into the original module that wires storage subscribers we
    //     don't want firing). ────────────────────────────────────────────
    function mountSections() {
        for (const id of Object.keys(sections)) {
            if (id === 'expeditions') continue;
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

    function renderNoTab() {
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
    }

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
        } else {
            appShell.hidden = true;
            noTabEl.hidden = false;
            renderNoTab();
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
