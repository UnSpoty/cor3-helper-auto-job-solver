// src/entry/background.js
// Service worker entry. Load shared/core then SW-specific modules.
// Uses importScripts (classic SW context) to load scripts in order.

if (typeof importScripts === 'function') {
    importScripts(
        '../shared/platform.js',
        '../shared/constants.js',
        '../core/bus.js',
        '../core/store.js',
        '../core/logger.js',
        '../shared/errors.js',
        '../core/module.js',
        '../core/settings.js',
        '../core/registry.js'
    );
}

// ─── Helpers ──────────────────────────────────────────────────────────
async function getCor3Tab() {
    try {
        const tabs = await chrome.tabs.query({ url: ['*://*.cor3.gg/*', '*://os.cor3.gg/*'] });
        return tabs[0] || null;
    } catch (_) { return null; }
}

// ─── Keep-alive ───────────────────────────────────────────────────────
// "Receiving end does not exist" is expected whenever the cor3.gg tab has no
// content script attached yet (page loading, just-reloaded extension, tab on
// a non-matching URL fragment). It's not an actionable error, so silence it
// — the SW just retries on the next 30 s tick.
function isNoReceiverError(e) {
    const msg = (e && (e.message || String(e))) || '';
    return /Receiving end does not exist|Could not establish connection/i.test(msg);
}

async function keepAlive() {
    try {
        const tab = await getCor3Tab();
        if (!tab) return;
        await chrome.tabs.sendMessage(tab.id, { action: 'keepWorkerAlive' });
    } catch (e) {
        if (isNoReceiverError(e)) return;
        if (self.cor3LogError) self.cor3LogError('background', e, { action: 'keepAlive' });
    }
}
keepAlive();
setInterval(keepAlive, 30000);

// ─── Expedition polling for auto-features ─────────────────────────────
async function expeditionPolling() {
    try {
        const sync = await chrome.storage.sync.get(['autoChooseEnabled', 'autoSendMerc']);
        const need = !!sync.autoChooseEnabled || !!(sync.autoSendMerc && sync.autoSendMerc.enabled);
        if (!need) return;
        const tab = await getCor3Tab();
        if (tab) await chrome.tabs.sendMessage(tab.id, { action: 'requestExpeditions' });
    } catch (_) { /* silent */ }
}
setInterval(expeditionPolling, 30000);

// ─── Side panel default behavior ──────────────────────────────────────
try {
    if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
        chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
    }
} catch (_) {}

// ─── Suppressed: alarmActiveStatus ack (no-op back-compat) ────────────
chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {
    if (req && req.action === 'alarmActiveStatus') {
        sendResponse({ success: true });
        return true;
    }
});
