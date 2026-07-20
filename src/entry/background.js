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
        '../shared/i18n.js',
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

// ─── Market reset notifications ───────────────────────────────────────
// Detection lives HERE (not the content script) on chrome.alarms, so a market
// job-timer reset is caught even when the cor3.gg tab is CLOSED. We schedule a
// one-shot alarm at each market's nextJobsResetAt (read from the envelopes the
// content script last wrote to chrome.storage.local); when it fires we raise a
// desktop notification AND forward a toast to the tab if one is open. The
// "Test" button reaches the same path via MSG.NOTIFY.MARKET_RESET.
const C = self.COR3 && self.COR3.constants;
const MARKET_RESET_ACTION = (C && C.MSG.NOTIFY.MARKET_RESET) || 'COR3_NOTIFY_MARKET_RESET';
const MARKET_TOAST_TYPE  = (C && C.MSG.NOTIFY.MARKET_TOAST) || 'COR3_NOTIFY_MARKET_TOAST';
const MN_ENABLED_KEY     = (C && C.STORAGE_SYNC.MARKET_NOTIFY_ENABLED) || 'marketNotifyEnabled';
const MN_SOURCES = C ? [
    { source: 'home', key: C.STORAGE_LOCAL.MARKET,      short: 'HOME' },
    { source: 'dark', key: C.STORAGE_LOCAL.DARK_MARKET, short: 'D4RK' },
    { source: 'srm',  key: C.STORAGE_LOCAL.SRM_MARKET,  short: 'SRM'  },
    { source: 'usol', key: C.STORAGE_LOCAL.USOL_MARKET, short: 'USOL' },
] : [];
const MN_FIELD = 'nextJobsResetAt';
const mnAlarmName = (source) => `cor3-mn-${source}`;

async function mnIsEnabled() {
    try { return !!(await chrome.storage.sync.get(MN_ENABLED_KEY))[MN_ENABLED_KEY]; }
    catch (_) { return false; }
}

// (Re)schedule the per-market reset alarms from the stored envelopes. Idempotent
// — skips a market already scheduled for the same instant, and clears alarms
// for markets that are off / have no future deadline (so a past reset never
// re-fires). Called on SW start and whenever the envelopes or the toggle change.
async function scheduleMarketAlarms() {
    if (!chrome.alarms) return;
    const on = await mnIsEnabled();
    for (const s of MN_SOURCES) {
        const name = mnAlarmName(s.source);
        let when = 0;
        if (on) {
            try {
                const env = (await chrome.storage.local.get(s.key))[s.key];
                const raw = env && env[MN_FIELD];
                if (raw) when = new Date(raw).getTime();
            } catch (_) { /* ignore */ }
        }
        const existing = await chrome.alarms.get(name);
        if (!on || !when || when <= Date.now() + 1000) {
            if (existing) await chrome.alarms.clear(name);
            continue;
        }
        if (existing && Math.abs(existing.scheduledTime - when) < 1000) continue;
        chrome.alarms.create(name, { when });
    }
}

// Raise the desktop notification (localised via i18n) + forward the in-page
// toast to the cor3.gg tab if it is open. iconUrl/title guard against a missing
// notifications permission so the SW never throws.
async function fireMarketNotification(source, short) {
    try {
        const lang = (await chrome.storage.sync.get('uiLanguage')).uiLanguage;
        if (self.COR3 && self.COR3.i18n && lang) self.COR3.i18n.set(lang);
    } catch (_) { /* fall back to en */ }
    const tr = (k, v) => (self.COR3 && self.COR3.i18n) ? self.COR3.i18n.t(k, v) : k;
    const title = tr('mn.title');
    const body = tr('mn.body', { market: short });
    try {
        if (chrome.notifications && chrome.notifications.create) {
            chrome.notifications.create(`cor3-mn-${source}-${Date.now()}`, {
                type: 'basic',
                iconUrl: chrome.runtime.getURL('icon/favicon128.png'),
                title, message: body, priority: 1,
            });
        }
    } catch (e) {
        if (self.cor3LogError) self.cor3LogError('background', e, { action: 'marketResetNotify' });
    }
    try {
        const tab = await getCor3Tab();
        if (tab) chrome.tabs.sendMessage(tab.id, { type: MARKET_TOAST_TYPE, payload: { short } }).catch(() => {});
    } catch (_) { /* no tab / no receiver — desktop notification still shown */ }
}

if (chrome.alarms) {
    chrome.alarms.onAlarm.addListener((alarm) => {
        if (!alarm || !alarm.name.startsWith('cor3-mn-')) return;
        const s = MN_SOURCES.find((x) => mnAlarmName(x.source) === alarm.name);
        if (s) fireMarketNotification(s.source, s.short);
    });
}

// Reschedule when the market envelopes (local) or the enable toggle (sync) change.
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && MN_SOURCES.some((s) => changes[s.key])) scheduleMarketAlarms();
    else if (area === 'sync' && changes[MN_ENABLED_KEY]) scheduleMarketAlarms();
});
scheduleMarketAlarms();

// "Test" button (popup → SW): fire a sample notification + toast on demand.
chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {
    if (!req || req.action !== MARKET_RESET_ACTION) return;
    fireMarketNotification(req.source || 'test', req.short || 'HOME');
    sendResponse({ success: true });
    return true;
});

// Clicking one of our market notifications focuses the cor3.gg tab.
try {
    if (chrome.notifications && chrome.notifications.onClicked) {
        chrome.notifications.onClicked.addListener(async (id) => {
            if (!id || !id.startsWith('cor3-mn-')) return;
            try {
                const tab = await getCor3Tab();
                if (tab) {
                    await chrome.tabs.update(tab.id, { active: true });
                    if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
                }
                chrome.notifications.clear(id);
            } catch (_) { /* tab gone / no window focus perm — ignore */ }
        });
    }
} catch (_) { /* notifications API absent */ }

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
