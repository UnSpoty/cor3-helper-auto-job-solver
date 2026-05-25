// Isolated-world entry point. Loaded by manifest content_scripts after
// constants/store/logger/module/settings/registry/bus/errors/dom AND after
// every src/modules/data/*.js (each one auto-registers on load).
// All this file does:
//   1. Boot the Registry — runs init() for every module, then start() for
//      every module flagged enabled in settings (default: all enabled).
//   2. Re-boot when settings change so master switches take effect live.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Registry, Settings, Logger, Bus, constants: C } = root.COR3;

    if (root.__cor3IsolatedBootDone) return;
    root.__cor3IsolatedBootDone = true;

    // Console-visible boot indicator. Without this we have no way to tell
    // from the page console whether isolated content_scripts loaded at all
    // (Logger.push goes to chrome.storage, not console). Critical for
    // diagnosing Firefox MV3 load issues.
    console.log('[COR3.entry/content] isolated-world boot starting');

    // Last-resort swallow for "Extension context invalidated" rejections.
    // Store/Settings/Bus all defend against this on their own, but anything
    // that touches chrome.* asynchronously (open setTimeouts, in-flight
    // listeners, third-party callbacks) can still surface it on reload.
    // Harmless — the next page load gets a fresh content-script context;
    // we just don't want it cluttering chrome://extensions errors.
    window.addEventListener('unhandledrejection', (e) => {
        const reason = e && e.reason;
        const msg = (reason && (reason.message || String(reason))) || '';
        if (/Extension context invalidated|context invalidated/i.test(msg)) {
            e.preventDefault();
        }
    });

    // Log-bridge: ingest entries forwarded from MAIN-world modules.
    // MAIN-world Logger lacks chrome.storage, so it posts each entry as
    // 'COR3_LOG_REMOTE' via window.postMessage. We unwrap and persist locally.
    Bus.window.on('COR3_LOG_REMOTE', (env) => {
        if (env && env.moduleId && env.entry) {
            Logger.ingest(env.moduleId, env.entry);
        }
    });

    Registry.boot().then(() => {
        const all = Registry.snapshot();
        console.log('[COR3.entry/content] isolated-world boot complete —', all.length, 'modules');
        Logger.push('registry', C.LOG_LEVEL.INFO, `boot done — ${all.length} modules`, {
            ids: all.map((m) => m.id),
        });
    }).catch((e) => {
        console.error('[COR3.entry/content] boot failed', e);
        Logger.push('registry', C.LOG_LEVEL.ERROR, 'boot failed', { error: String(e), stack: e && e.stack });
    });

    // Live re-sync when user toggles a master switch in the UI
    if (Settings && typeof Settings.onChange === 'function') {
        Settings.onChange((id, next, prev) => {
            Registry.setModuleState(id, next).catch((e) => {
                Logger.push('registry', C.LOG_LEVEL.ERROR, `setModuleState ${id} failed`, { error: String(e) });
            });
        });
    }
})();
