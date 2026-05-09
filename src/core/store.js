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

    // Detect "extension context invalidated" — the throw/rejection that
    // chrome.* APIs produce after the extension is reloaded or disabled
    // while a content script is still running on the page. Safe to swallow:
    // the next page load will get a fresh content-script context.
    function isCtxInvalidated(e) {
        const msg = (e && (e.message || String(e))) || '';
        return /Extension context invalidated|context invalidated/i.test(msg);
    }

    function makeArea(areaName) {
        const area = hasStorage() ? chrome.storage[areaName] : null;

        // Wrap a chrome.storage callback-style call. Resolves with the
        // callback arg, OR with `fallback` if the call throws synchronously
        // (extension reload race) or fails with chrome.runtime.lastError.
        // Never rejects — silent best-effort, callers can keep going.
        function safeCall(fn, fallback) {
            return new Promise((resolve) => {
                try {
                    fn((arg) => {
                        // Read lastError to silence the "unchecked" warning
                        // that Chrome emits when nobody touches it.
                        const err = chrome.runtime && chrome.runtime.lastError;
                        if (err && isCtxInvalidated(err)) return resolve(fallback);
                        resolve(arg !== undefined ? arg : fallback);
                    });
                } catch (e) {
                    if (!isCtxInvalidated(e)) {
                        try { console.warn('[COR3.Store] storage call threw', e); } catch (_) {}
                    }
                    resolve(fallback);
                }
            });
        }

        async function get(keys)         { return area ? safeCall((cb) => area.get(keys, cb), {}) : {}; }
        async function set(obj)          { if (area) await safeCall((cb) => area.set(obj, cb), undefined); }
        async function remove(keys)      { if (area) await safeCall((cb) => area.remove(keys, cb), undefined); }
        async function clear()           { if (area) await safeCall((cb) => area.clear(cb), undefined); }
        async function getOne(key, defaultValue) {
            const data = await get(key);
            return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : defaultValue;
        }
        async function setOne(key, value) { return set({ [key]: value }); }

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
            try { chrome.storage.onChanged.addListener(wrapped); }
            catch (e) {
                if (!isCtxInvalidated(e)) try { console.warn('[COR3.Store] onChanged addListener threw', e); } catch (_) {}
                return () => {};
            }
            return () => {
                try { chrome.storage.onChanged.removeListener(wrapped); } catch (_) { /* invalidated */ }
            };
        }

        return { get, getOne, set, setOne, remove, clear, onChanged };
    }

    const local = makeArea('local');
    const sync = makeArea('sync');

    /**
     * Listen for changes to a single sync key from EITHER source:
     *   • chrome.storage.sync.onChanged — the canonical channel; reliable
     *     on Chrome but Firefox MV3 has known cross-context delivery
     *     issues (popup writes that don't propagate to isolated content
     *     scripts).
     *   • Bus.runtime — a fallback message of the shape
     *     { type: 'settingChanged', payload: { key, value } } that the
     *     popup posts via chrome.tabs.sendMessage right after setOne().
     *
     * Both signals call the callback; we dedupe by the last seen value so
     * a Chrome write that lands on both channels still fires once.
     * Returns an unsubscribe fn.
     *
     * Lives on root.COR3.Store.sync so isolated modules can replace
     *   Store.sync.onChanged((changes) => { if (changes[KEY]) … })
     * with
     *   Store.sync.onSettingChange(KEY, (newValue) => …)
     * — fewer lines AND Firefox-safe.
     */
    function onSettingChange(key, callback) {
        let lastValue = Symbol('uninit');
        const fire = (newValue) => {
            if (newValue === lastValue) return;
            lastValue = newValue;
            try { callback(newValue); }
            catch (e) {
                try { console.error('[COR3.Store] onSettingChange callback error', e); } catch (_) {}
            }
        };
        const unsubStorage = sync.onChanged((changes) => {
            if (Object.prototype.hasOwnProperty.call(changes, key)) {
                fire(changes[key].newValue);
            }
        });
        let unsubBus = () => {};
        const Bus = root.COR3.Bus;
        if (Bus && Bus.runtime && typeof Bus.runtime.on === 'function') {
            unsubBus = Bus.runtime.on('settingChanged', (payload) => {
                if (!payload || payload.key !== key) return;
                fire(payload.value);
            });
        }
        return () => { unsubStorage(); unsubBus(); };
    }
    sync.onSettingChange = onSettingChange;

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
