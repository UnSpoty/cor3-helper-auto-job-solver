// src/core/store.js
// Thin async facade over chrome.storage.local / chrome.storage.sync.
// Adds:
//   • Promise-based API (uniform across all contexts)
//   • Single-key get/set helpers
//   • onChanged subscription with area filtering
//   • Module.namespace(): scoped getter/setter for per-module data
// Registers into globalThis.COR3.Store.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    root.COR3 = root.COR3 || {};
    if (root.COR3.Store) return;

    function hasStorage() {
        return typeof chrome !== 'undefined' && chrome.storage;
    }

    function makeArea(areaName) {
        const area = hasStorage() ? chrome.storage[areaName] : null;

        async function get(keys) {
            if (!area) return {};
            return new Promise((resolve) => {
                area.get(keys, (data) => { void chrome.runtime.lastError; resolve(data || {}); });
            });
        }

        async function getOne(key, defaultValue) {
            const data = await get(key);
            return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : defaultValue;
        }

        async function set(obj) {
            if (!area) return;
            return new Promise((resolve) => {
                area.set(obj, () => { void chrome.runtime.lastError; resolve(); });
            });
        }

        async function setOne(key, value) {
            return set({ [key]: value });
        }

        async function remove(keys) {
            if (!area) return;
            return new Promise((resolve) => {
                area.remove(keys, () => { void chrome.runtime.lastError; resolve(); });
            });
        }

        async function clear() {
            if (!area) return;
            return new Promise((resolve) => {
                area.clear(() => { void chrome.runtime.lastError; resolve(); });
            });
        }

        /**
         * Subscribe to changes in this area. Handler receives the same
         * `changes` object that chrome.storage.onChanged exposes.
         * Returns an unsubscribe fn.
         */
        function onChanged(handler) {
            if (!hasStorage() || !chrome.storage.onChanged) return () => {};
            const wrapped = (changes, area) => {
                if (area !== areaName) return;
                try { handler(changes); }
                catch (e) {
                    try { console.error('[COR3.Store] onChanged handler error', e); } catch (_) {}
                }
            };
            chrome.storage.onChanged.addListener(wrapped);
            return () => chrome.storage.onChanged.removeListener(wrapped);
        }

        return { get, getOne, set, setOne, remove, clear, onChanged };
    }

    const local = makeArea('local');
    const sync = makeArea('sync');

    /**
     * Wait until a particular key has any (truthy) value in `area`. Useful for
     * modules that need a token / config item before they can do anything.
     */
    async function waitForKey(areaName, key, { timeout = 30000, poll = 250 } = {}) {
        const area = areaName === 'sync' ? sync : local;
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
            const v = await area.getOne(key);
            if (v !== undefined && v !== null) return v;
            await new Promise((r) => setTimeout(r, poll));
        }
        return undefined;
    }

    root.COR3.Store = { local, sync, waitForKey };
})();
