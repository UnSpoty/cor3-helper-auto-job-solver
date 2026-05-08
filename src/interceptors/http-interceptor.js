// src/interceptors/http-interceptor.js
// MAIN-world HTTP interceptor. Wraps fetch() and XMLHttpRequest to capture:
//   • Bearer tokens on cor3/corie URLs → MSG.AUTH.BEARER_TOKEN
//   • translation.json query param `?v=...` → MSG.AUTH.WEB_VERSION
//   • api/users/me response.systemVersion → MSG.AUTH.SYSTEM_VERSION
//   • api/user-daily-claim/rewards array → MSG.AUTH.DAILY_REWARDS
// IIFE — no Module class (no chrome.storage in MAIN world).

(function () {
    if (window.__cor3HttpInterceptorActive) return;
    window.__cor3HttpInterceptorActive = true;

    const C = window.COR3 && window.COR3.constants;
    const Bus = window.COR3 && window.COR3.Bus;
    if (!C || !Bus) {
        console.error('[COR3.http-interceptor] missing COR3.constants/Bus — load order is wrong');
        return;
    }
    const MSG = C.MSG;

    // ──────────────────────────────────────────────────────────────────────
    // fetch wrapper
    // ──────────────────────────────────────────────────────────────────────
    const OrigFetch = window.fetch;
    let webVersion = null;

    window.fetch = function () {
        const args = arguments;
        const input = args[0];
        const init = args[1];
        try {
            const url = typeof input === 'string' ? input : (input && input.url ? input.url : '');
            if (url.includes('cor3') || url.includes('corie')) {
                let headers = init && init.headers;
                if (!headers && input && input.headers) headers = input.headers;
                if (headers) {
                    let authVal = null;
                    if (typeof headers.get === 'function') {
                        authVal = headers.get('Authorization') || headers.get('authorization');
                    } else if (typeof headers === 'object') {
                        authVal = headers['Authorization'] || headers['authorization'];
                    }
                    if (authVal && authVal.startsWith('Bearer ')) {
                        Bus.window.post(MSG.AUTH.BEARER_TOKEN, { token: authVal });
                    }
                }
            }
            if (url.includes('translation.json')) {
                try {
                    const parsedUrl = new URL(url, window.location.origin);
                    if (!webVersion) webVersion = parsedUrl.searchParams.get('v');
                    window.__cor3WebVersion = webVersion;
                    Bus.window.post(MSG.AUTH.WEB_VERSION, { version: webVersion });
                } catch (_) { /* silent */ }
            }
        } catch (_) { /* silent */ }

        const result = OrigFetch.apply(this, args);
        try {
            const url = typeof input === 'string' ? input : (input && input.url ? input.url : '');
            if (url.includes('api/users/me')) {
                result.then((resp) => {
                    if (resp && resp.ok) {
                        resp.clone().json().then((data) => {
                            if (data && data.systemVersion !== undefined) {
                                window.__cor3SystemVersion = data.systemVersion;
                                Bus.window.post(MSG.AUTH.SYSTEM_VERSION, { version: data.systemVersion });
                                if (webVersion) Bus.window.post(MSG.AUTH.WEB_VERSION, { version: webVersion });
                            }
                        }).catch(() => {});
                    }
                }).catch(() => {});
            }
            if (url.includes('api/user-daily-claim/rewards')) {
                result.then((resp) => {
                    if (resp && resp.ok) {
                        resp.clone().json().then((data) => {
                            if (Array.isArray(data)) Bus.window.post(MSG.AUTH.DAILY_REWARDS, { rewards: data });
                        }).catch(() => {});
                    }
                }).catch(() => {});
            }
        } catch (_) { /* silent */ }
        return result;
    };

    // ──────────────────────────────────────────────────────────────────────
    // XHR wrapper
    // ──────────────────────────────────────────────────────────────────────
    const OrigOpen = XMLHttpRequest.prototype.open;
    const OrigSetHeader = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.open = function () {
        this.__cor3Url = arguments[1] || '';
        return OrigOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
        if ((name === 'Authorization' || name === 'authorization') &&
            value && value.startsWith('Bearer ') &&
            this.__cor3Url && (this.__cor3Url.includes('cor3') || this.__cor3Url.includes('corie'))) {
            Bus.window.post(MSG.AUTH.BEARER_TOKEN, { token: value });
        }
        return OrigSetHeader.apply(this, arguments);
    };

    // Re-post versions after content.js (document_idle) is listening
    function repostVersions() {
        if (window.__cor3WebVersion) Bus.window.post(MSG.AUTH.WEB_VERSION, { version: window.__cor3WebVersion });
        if (window.__cor3SystemVersion) Bus.window.post(MSG.AUTH.SYSTEM_VERSION, { version: window.__cor3SystemVersion });
    }
    setTimeout(repostVersions, 3000);
    setTimeout(repostVersions, 8000);

    console.log('[COR3] HTTP interceptor installed');
})();
