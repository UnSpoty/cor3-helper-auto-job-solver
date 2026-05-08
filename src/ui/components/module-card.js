// src/ui/components/module-card.js
// Renders one module entry with master switch + log toggle.
// Persists changes to chrome.storage.sync.modules ({ [id]: {enabled, logsEnabled} }).

(function () {
    const root = window;
    root.COR3.uiComponents = root.COR3.uiComponents || {};
    const Store = root.COR3.Store;
    const C = root.COR3.constants;
    const KEY = C.STORAGE_SYNC.MODULES;

    function badge(category) {
        const cat = String(category || '').toLowerCase();
        const map = {
            core: 'idle', data: 'active', automation: 'ok',
            game: 'active', solver: 'active', appearance: 'idle', ui: 'idle',
        };
        return `<span class="pill ${map[cat] || 'idle'}">${cat || '?'}</span>`;
    }

    /**
     * @param {object} mod  shape: { id, name, category, dependsOn[], enabled, logsEnabled }
     */
    function create(mod) {
        const el = document.createElement('div');
        el.className = 'module-card' + (mod.enabled === false ? ' disabled' : '');
        el.innerHTML = `
            <div>
                <div class="mod-id">${mod.name || mod.id} ${badge(mod.category)}</div>
                ${mod.dependsOn && mod.dependsOn.length
                    ? `<div class="mod-deps">deps: ${mod.dependsOn.join(', ')}</div>`
                    : ''}
            </div>
            <div class="row gap-sm">
                <span class="mod-toggle-label">on</span>
                <label class="switch"><input type="checkbox" data-toggle="enabled" ${mod.enabled !== false ? 'checked' : ''}><span class="switch-slider"></span></label>
            </div>
            <div class="row gap-sm">
                <span class="mod-toggle-label">log</span>
                <label class="switch"><input type="checkbox" data-toggle="logsEnabled" ${mod.logsEnabled !== false ? 'checked' : ''}><span class="switch-slider"></span></label>
            </div>
            <div class="mod-meta">id: ${mod.id}${mod.started === true ? ' · running' : (mod.started === false ? ' · stopped' : '')}</div>
        `;

        async function updateState(partial) {
            const all = (await Store.sync.getOne(KEY, {})) || {};
            all[mod.id] = Object.assign({ enabled: true, logsEnabled: true }, all[mod.id] || {}, partial);
            await Store.sync.setOne(KEY, all);
            // Local CSS feedback
            if (partial.enabled !== undefined) el.classList.toggle('disabled', partial.enabled === false);
        }

        el.querySelector('input[data-toggle="enabled"]').addEventListener('change', (e) => {
            updateState({ enabled: e.target.checked });
        });
        el.querySelector('input[data-toggle="logsEnabled"]').addEventListener('change', (e) => {
            updateState({ logsEnabled: e.target.checked });
        });
        return el;
    }

    root.COR3.uiComponents.moduleCard = { create };
})();
