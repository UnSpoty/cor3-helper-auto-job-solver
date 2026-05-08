// src/ui/components/log-viewer.js
// Live log stream. Reads chrome.storage.local.cor3_logs on mount and
// subscribes to storage onChanged for live updates.

(function () {
    const root = window;
    root.COR3.uiComponents = root.COR3.uiComponents || {};
    const Store = root.COR3.Store;
    const C = root.COR3.constants;

    /**
     * @param {HTMLElement} container
     * @param {object} [opts]
     * @param {string} [opts.moduleFilter]  module id ('' = all)
     * @param {string} [opts.levelFilter]   '' | 'debug' | 'info' | 'warn' | 'error'
     * @returns {{ destroy: ()=>void, refresh: ()=>void, setFilter: (f)=>void }}
     */
    function attach(container, opts = {}) {
        let moduleFilter = opts.moduleFilter || '';
        let levelFilter = opts.levelFilter || '';
        let unsub = null;

        function levelRank(l) {
            return { debug: 0, info: 1, ok: 1, separator: 1, warn: 2, error: 3 }[l || 'info'] ?? 1;
        }
        function passes(modId, entry) {
            if (moduleFilter && modId !== moduleFilter) return false;
            if (levelFilter && levelRank(entry.level) < levelRank(levelFilter)) return false;
            return true;
        }

        function fmtTs(ts) {
            const d = new Date(ts);
            return d.toLocaleTimeString();
        }

        function lineHtml(modId, entry) {
            const lvl = entry.level || 'info';
            const ctxStr = entry.ctx !== undefined
                ? ` <span class="muted">${escape(JSON.stringify(entry.ctx)).slice(0, 200)}</span>`
                : '';
            return `<div class="log-line ${lvl}">` +
                `<span class="ts">${fmtTs(entry.ts)}</span>` +
                `<span class="modid">${escape(modId)}</span>` +
                `${escape(entry.msg)}${ctxStr}</div>`;
        }
        function escape(s) {
            return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        }

        async function refresh() {
            const data = (await Store.local.getOne(C.STORAGE_LOCAL.LOGS, {})) || {};
            const allLines = [];
            for (const [modId, entries] of Object.entries(data)) {
                if (!Array.isArray(entries)) continue;
                for (const e of entries) {
                    if (passes(modId, e)) allLines.push({ modId, e });
                }
            }
            allLines.sort((a, b) => (a.e.ts || 0) - (b.e.ts || 0));
            container.innerHTML = allLines.map(({ modId, e }) => lineHtml(modId, e)).join('') ||
                '<div class="empty">No log entries yet.</div>';
            container.scrollTop = container.scrollHeight;
        }

        async function setFilter(f) {
            if (f && typeof f.module === 'string') moduleFilter = f.module;
            if (f && typeof f.level === 'string') levelFilter = f.level;
            await refresh();
        }

        unsub = Store.local.onChanged((changes) => {
            if (changes[C.STORAGE_LOCAL.LOGS]) refresh();
        });
        refresh();

        return {
            destroy: () => { if (unsub) unsub(); },
            refresh,
            setFilter,
        };
    }

    root.COR3.uiComponents.logViewer = { attach };
})();
