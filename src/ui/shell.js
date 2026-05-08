// src/ui/shell.js
// Popup entry. Mode detection (?mode=popout), tab routing, section lifecycle.

(function () {
    const root = window;
    const C = root.COR3.constants;

    const TABS = [
        { id: 'overview',    label: 'Overview' },
        { id: 'expeditions', label: 'Expeditions' },
        { id: 'autojobs',    label: 'Auto-Jobs' },
        { id: 'modules',     label: 'Modules' },
        { id: 'logs',        label: 'Logs' },
    ];

    // Mode detection
    const params = new URLSearchParams(location.search);
    if (params.get('mode') === 'popout') document.body.classList.add('mode-popout');

    // Pop-out / side-panel buttons
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

    // Tab strip
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

    for (const t of TABS) {
        const btn = document.createElement('button');
        btn.className = 'tab';
        btn.dataset.tab = t.id;
        btn.textContent = t.label;
        btn.addEventListener('click', () => activate(t.id));
        tabsEl.appendChild(btn);
    }

    // Mount each section's content (each section module exposes `mount(el)`).
    for (const id of Object.keys(sections)) {
        try {
            if (root.COR3.ui && root.COR3.ui[id] && typeof root.COR3.ui[id].mount === 'function') {
                root.COR3.ui[id].mount(sections[id]);
            }
        } catch (e) {
            console.error(`[COR3.ui] mount ${id} failed`, e);
        }
    }

    // Restore last active tab or default to overview
    let initial = 'overview';
    try { initial = localStorage.getItem('cor3.activeTab') || 'overview'; } catch (_) {}
    if (!TABS.some((t) => t.id === initial)) initial = 'overview';
    activate(initial);
})();
