// src/ui/sections/modules-panel.js
// Module Manager: master switch + log toggle for every module known to the
// content-script Registries. We poll the active cor3.gg tab for snapshots.

(function () {
    const root = window;
    root.COR3.ui = root.COR3.ui || {};
    const { uiComponents, Store, constants: C } = root.COR3;
    const t = (k, vars) => root.COR3.i18n.t(k, vars);

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

    async function fetchSnapshots() {
        // Ask content script for both world snapshots — query MAIN globals via
        // executeScript fallback if Bus.runtime isn't wired. We use chrome.tabs.executeScript-style
        // via the injected isolated content script: it can read window.COR3.Registry
        // (isolated world). MAIN-world Registry is reached via Bus.window.
        // Simplest: send a runtime message; the auto-jobs module already responds
        // to getAutoJobsState. We add a lightweight 'getModuleSnapshot' handler
        // here by piggybacking on chrome.scripting if available; otherwise we
        // read from chrome.storage.sync.modules directly and synthesize from
        // STATIC catalog.
        const tab = await getCor3Tab();
        if (!tab || !chrome.scripting || !chrome.scripting.executeScript) {
            return [];
        }
        // Pull snapshots from BOTH worlds
        const isolated = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: 'ISOLATED',
            func: () => (window.COR3 && window.COR3.Registry) ? window.COR3.Registry.snapshot() : [],
        }).catch(() => []);
        const main = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: 'MAIN',
            func: () => (window.COR3 && window.COR3.Registry) ? window.COR3.Registry.snapshot() : [],
        }).catch(() => []);
        const isoArr = isolated[0]?.result || [];
        const mainArr = main[0]?.result || [];
        return [...isoArr.map((m) => ({ ...m, world: 'isolated' })), ...mainArr.map((m) => ({ ...m, world: 'main' }))];
    }

    async function render(container) {
        container.innerHTML = '';
        container.appendChild(el('div', 'section-title', t('modules.title')));

        const mods = await fetchSnapshots();
        if (mods.length === 0) {
            container.appendChild(el('div', 'empty',
                `${t('modules.openTab')}<br>(scripting permission required for live state)`));
            return;
        }

        const persisted = (await Store.sync.getOne(C.STORAGE_SYNC.MODULES, {})) || {};

        // Group by category
        const byCat = {};
        for (const m of mods) {
            const cat = m.category || 'other';
            if (!byCat[cat]) byCat[cat] = [];
            // Hydrate persisted state
            const ps = persisted[m.id] || {};
            byCat[cat].push({
                ...m,
                enabled: ps.enabled !== undefined ? ps.enabled : (m.enabled !== false),
                logsEnabled: ps.logsEnabled !== undefined ? ps.logsEnabled : (m.logsEnabled !== false),
            });
        }

        for (const cat of Object.keys(byCat).sort()) {
            container.appendChild(el('div', 'section-title', cat));
            for (const m of byCat[cat]) {
                container.appendChild(uiComponents.moduleCard.create(m));
            }
        }

        // Refresh button at bottom
        const refresh = el('button', 'btn small btn-block mt-md', t('modules.refresh'));
        refresh.addEventListener('click', () => render(container));
        container.appendChild(refresh);
    }

    let unsub = null;
    root.COR3.ui.modules = {
        mount(container) {
            unsub = Store.sync.onChanged((changes) => {
                if (changes[C.STORAGE_SYNC.MODULES] && container.classList.contains('active')) render(container);
            });
            render(container);
        },
        activate(container) { render(container); },
    };
})();
