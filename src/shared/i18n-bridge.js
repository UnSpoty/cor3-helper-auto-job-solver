// src/shared/i18n-bridge.js
// Glue that drives COR3.i18n.set() from the user-chosen language in
// chrome.storage.sync[uiLanguage]. Loaded in every context that has
// i18n.js. Self-adapts:
//
//   • Contexts WITH chrome.* (isolated content scripts, popup, SW):
//       - read uiLanguage from storage on boot,
//       - subscribe to storage.onChanged for live updates,
//       - call i18n.set() locally and broadcast over Bus.window so
//         the MAIN-world side picks the same language.
//   • Contexts WITHOUT chrome.* (MAIN-world content scripts):
//       - listen to the Bus.window broadcast and call i18n.set().
//
// Popup's shell.js already manages the language picker UI directly
// via Store.sync; this bridge is idempotent next to that — it just
// keeps i18n.current in sync if the popup itself changed storage.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    if (!root.COR3 || !root.COR3.i18n) return;
    const i18n = root.COR3.i18n;
    const Bus = root.COR3.Bus;
    const LANG_MSG = 'COR3_UI_LANGUAGE';
    const STORAGE_KEY = i18n.STORAGE_KEY || 'uiLanguage';

    const hasStorage = typeof chrome !== 'undefined'
        && chrome.storage && chrome.storage.sync;

    function applyAndBroadcast(lang) {
        const next = lang || 'en';
        if (i18n.get() !== next) i18n.set(next);
        if (Bus && Bus.window && typeof Bus.window.post === 'function') {
            try { Bus.window.post(LANG_MSG, { lang: next }); } catch (_) {}
        }
    }

    if (hasStorage) {
        try {
            chrome.storage.sync.get(STORAGE_KEY, (data) => {
                if (chrome.runtime && chrome.runtime.lastError) return;
                const lang = data && data[STORAGE_KEY];
                if (lang) applyAndBroadcast(lang);
            });
            chrome.storage.onChanged.addListener((changes, area) => {
                if (area !== 'sync') return;
                if (!changes || !changes[STORAGE_KEY]) return;
                applyAndBroadcast(changes[STORAGE_KEY].newValue);
            });
        } catch (_) { /* not in extension context */ }
    }

    // MAIN-world (and any other context with Bus but no chrome.*) —
    // listen for the broadcast and update local i18n.
    if (Bus && Bus.window && typeof Bus.window.on === 'function') {
        try {
            Bus.window.on(LANG_MSG, (env) => {
                if (env && env.lang && i18n.get() !== env.lang) i18n.set(env.lang);
            });
        } catch (_) {}
    }
})();
