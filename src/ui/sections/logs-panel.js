// src/ui/sections/logs-panel.js
// Live log stream from chrome.storage.local.cor3_logs with module + level filter.

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

    async function render(container) {
        container.innerHTML = '';
        container.appendChild(el('div', 'section-title', t('logs.title')));

        const data = (await Store.local.getOne(C.STORAGE_LOCAL.LOGS, {})) || {};
        const moduleIds = Object.keys(data).sort();

        const toolbar = el('div', 'log-toolbar');
        toolbar.innerHTML = `
            <select id="log-mod"><option value="">${t('logs.allModules')}</option>${moduleIds.map((m) => `<option value="${m}">${m}</option>`).join('')}</select>
            <select id="log-lvl">
                <option value="">${t('logs.allLevels')}</option>
                <option value="debug">debug+</option>
                <option value="info">info+</option>
                <option value="warn">warn+</option>
                <option value="error">error</option>
            </select>
            <button class="btn btn-danger small" id="log-clear">${t('common.clear')}</button>
        `;
        container.appendChild(toolbar);

        const stream = el('div', 'log-stream');
        container.appendChild(stream);

        const viewer = uiComponents.logViewer.attach(stream, {});

        toolbar.querySelector('#log-mod').addEventListener('change', (e) => viewer.setFilter({ module: e.target.value }));
        toolbar.querySelector('#log-lvl').addEventListener('change', (e) => viewer.setFilter({ level: e.target.value }));
        toolbar.querySelector('#log-clear').addEventListener('click', async () => {
            await Store.local.setOne(C.STORAGE_LOCAL.LOGS, {});
        });

        // Stash viewer for cleanup on tab switch
        container._logViewer = viewer;
    }

    root.COR3.ui.logs = {
        // No-op mount: render is driven by activate() to avoid the dup-render race
        // (both pre-await innerHTML clears land before either appendChild → 2× content).
        mount() {},
        activate(container) { render(container); },
        deactivate(container) {
            if (container._logViewer) try { container._logViewer.destroy(); } catch (_) {}
        },
    };
})();
