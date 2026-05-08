// src/entry/content.js
// Isolated-world entry point. Loaded by manifest content_scripts after
// constants/store/logger/module/settings/registry/bus/errors/dom AND after
// every src/modules/data/*.js (each one auto-registers on load).
// All this file does:
//   1. Boot the Registry — runs init() for every module, then start() for
//      every module flagged enabled in settings (default: all enabled).
//   2. Re-boot when settings change so master switches take effect live.
// Legacy content.js continues to load AFTER this — both run in parallel
// during the migration; storage writes are idempotent.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Registry, Settings, Logger, Bus, constants: C } = root.COR3;

    if (root.__cor3IsolatedBootDone) return;
    root.__cor3IsolatedBootDone = true;

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
        Logger.push('registry', C.LOG_LEVEL.INFO, `boot done — ${all.length} modules`, {
            ids: all.map((m) => m.id),
        });
    }).catch((e) => {
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
