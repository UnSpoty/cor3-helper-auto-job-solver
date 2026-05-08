// src/core/settings.js
// Reads/writes per-module enable + logsEnabled state to chrome.storage.sync.
// Storage shape under STORAGE_SYNC.MODULES:
//   { [moduleId]: { enabled: boolean, logsEnabled: boolean } }
// Registers into globalThis.COR3.Settings.
//
// Note: this is the *module* settings facade, not all extension settings.
// User-facing prefs (alarms, autoSendMerc, …) live under their existing keys.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    root.COR3 = root.COR3 || {};
    if (root.COR3.Settings) return;

    const C = root.COR3.constants;
    const Store = root.COR3.Store;
    if (!C || !Store) {
        // No-op shim if loaded in a context without Store (e.g. raw MAIN world).
        // Registry.boot() detects the absence and falls back to defaults.
        return;
    }

    const KEY = C.STORAGE_SYNC.MODULES;

    async function load() {
        const data = await Store.sync.getOne(KEY, {});
        return (data && typeof data === 'object') ? data : {};
    }

    async function getModuleState(id) {
        const all = await load();
        return all[id] || { enabled: true, logsEnabled: true };
    }

    async function setModuleState(id, partial) {
        const all = await load();
        const prev = all[id] || {};
        const next = Object.assign({}, prev, partial);
        all[id] = next;
        await Store.sync.setOne(KEY, all);
        return next;
    }

    /**
     * Subscribe to changes in module settings. Handler receives (moduleId, newState, oldState).
     */
    function onChange(handler) {
        return Store.sync.onChanged((changes) => {
            if (!changes[KEY]) return;
            const oldVal = changes[KEY].oldValue || {};
            const newVal = changes[KEY].newValue || {};
            const ids = new Set([...Object.keys(oldVal), ...Object.keys(newVal)]);
            for (const id of ids) {
                const o = oldVal[id] || {};
                const n = newVal[id] || {};
                if (o.enabled !== n.enabled || o.logsEnabled !== n.logsEnabled) {
                    try { handler(id, n, o); } catch (_) {}
                }
            }
        });
    }

    root.COR3.Settings = { load, getModuleState, setModuleState, onChange };
})();
