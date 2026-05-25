// MAIN-world entry point. Loaded by manifest content_scripts AFTER all the
// shared/core/interceptor/game-module/solver files. Boots the Registry so
// game flow modules and solver modules start listening for their Bus types.
//
// MAIN-world Registry has no chrome.storage access — Settings.load() returns
// {} and every module starts with its `defaultEnabled` value (default: true).
// Cross-world module-state sync is not yet wired.

(function () {
    const root = window;
    if (root.__cor3MainBootDone) return;
    root.__cor3MainBootDone = true;

    const C = root.COR3 && root.COR3.constants;
    const Bus = root.COR3 && root.COR3.Bus;
    const Registry = root.COR3 && root.COR3.Registry;
    const Logger = root.COR3 && root.COR3.Logger;
    if (!C || !Bus || !Registry) {
        console.error('[COR3.entry/content-early] missing core — manifest load order is wrong');
        return;
    }

    // Sanity-check interceptors installed
    if (!root.__cor3WsInterceptorActive || !root.__cor3HttpInterceptorActive) {
        console.warn('[COR3.entry/content-early] interceptors did not all install');
    }

    Registry.boot().then(() => {
        const all = Registry.snapshot();
        if (Logger) Logger.push('registry', C.LOG_LEVEL.INFO, `MAIN boot — ${all.length} modules`, {
            ids: all.map((m) => m.id),
        });
        console.log('[COR3.entry/content-early] MAIN-world boot complete —', all.length, 'modules');
    }).catch((e) => {
        console.error('[COR3.entry/content-early] boot failed', e);
    });
})();
