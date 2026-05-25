// src/entry/background.js
// Cross-browser background entry.
//
// Chrome MV3 (service worker context):
//   • manifest.background.service_worker → this file runs in a SW
//   • importScripts() is defined and loads our deps
//   • manifest.background.scripts is ignored (Chrome warns about it)
//
// Firefox MV3 (event page context, as of Firefox 150):
//   • background.service_worker is currently pref-gated off → won't run
//   • manifest.background.scripts is honoured: each file loaded as a
//     classic <script> in document order, with this file last so it
//     runs after constants/Bus/Store/etc. are defined globally
//   • importScripts() is undefined here, so the if-guard is a no-op
//
// Both paths land in the same flat globals (no module exports), so
// every helper below works regardless of which browser loaded us.

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

// ─── Upstream extension-version checker ───────────────────────────────
// Fetches release.json from the main branch and writes the diff against
// the locally-installed manifest.version to chrome.storage.local. The
// popup's version-mismatch banner reads that key (EXT_UPDATE_INFO) and
// renders an "update available" notice when isOutdated===true.
//
// raw.githubusercontent.com sits behind a CDN with a ~5min Cache-Control;
// we append a timestamp query to bypass that and pick up new releases
// within minutes rather than hours. The result is then cached in
// chrome.storage.local for UPDATE_CHECK_STALE_MS so we don't refetch on
// every SW wake.
const UPDATE_CHECK_URL =
    'https://raw.githubusercontent.com/UnSpoty/cor3-helper-auto-job-solver/main/release.json';
const UPDATE_CHECK_INTERVAL_MS = 10 * 60 * 1000;
const UPDATE_CHECK_STALE_MS    = 10 * 60 * 1000;

function _parseSemver(v) {
    if (!v) return null;
    const m = String(v).trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!m) return null;
    return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}
function _isNewerSemver(remote, local) {
    const a = _parseSemver(remote), b = _parseSemver(local);
    if (!a || !b) return false;
    for (let i = 0; i < 3; i++) {
        if (a[i] > b[i]) return true;
        if (a[i] < b[i]) return false;
    }
    return false;
}

async function checkForUpdate() {
    let localVersion = '';
    try { localVersion = chrome.runtime.getManifest().version || ''; } catch (_) { return; }
    try {
        const existing = await chrome.storage.local.get('extUpdateInfo');
        const prev = existing && existing.extUpdateInfo;
        // Skip the network call when we already have a fresh probe for
        // this exact local version. If the user upgraded (localVersion
        // changed) we always re-probe, even if the cache is still warm.
        if (prev && prev.checkedAt && prev.localVersion === localVersion &&
            (Date.now() - prev.checkedAt) < UPDATE_CHECK_STALE_MS) {
            return;
        }
        const res = await fetch(`${UPDATE_CHECK_URL}?t=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok) return;
        const json = await res.json();
        const latestVersion = String((json && json.version) || '').trim();
        const changes = Array.isArray(json && json.changes)
            ? json.changes.slice(0, 20).map((s) => String(s))
            : [];
        if (!latestVersion) return;
        await chrome.storage.local.set({
            extUpdateInfo: {
                localVersion,
                latestVersion,
                isOutdated: _isNewerSemver(latestVersion, localVersion),
                changes,
                checkedAt: Date.now(),
            },
        });
    } catch (_) { /* network/parse error — leave previous value in place */ }
}
checkForUpdate();
setInterval(checkForUpdate, UPDATE_CHECK_INTERVAL_MS);
