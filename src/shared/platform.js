// src/shared/platform.js
// Detect which extension runtime we're in. Both Chrome and Firefox MV3
// expose `chrome.*`, so a typeof check isn't enough. The cleanest signal
// is the extension URL prefix:
//   chrome-extension://… → Chrome / Edge / Brave (Chromium)
//   moz-extension://…    → Firefox
//   safari-web-extension://… → Safari (untested)
//
// Exposed as `globalThis.COR3.platform` so any module — content script,
// service worker, popup — can branch on it without importing.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    root.COR3 = root.COR3 || {};
    if (root.COR3.platform) return;

    let extUrl = '';
    try {
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
            extUrl = chrome.runtime.getURL('');
        }
    } catch (_) { /* Some contexts (popout window?) deny getURL — leave blank */ }

    const isFirefox = extUrl.startsWith('moz-extension://');
    const isChromium = extUrl.startsWith('chrome-extension://');
    const isSafari = extUrl.startsWith('safari-web-extension://');

    root.COR3.platform = {
        isFirefox,
        isChromium,
        isSafari,
        // Also expose the raw prefix so callers can do their own checks
        // for novel runtimes without us editing this file.
        extensionProtocol: extUrl ? extUrl.split(':')[0] : null,
    };
})();
