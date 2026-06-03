// Centralized error capture. Pushes errors into chrome.storage.local.cor3_errors
// and into the Logger if available. Registers into globalThis.COR3.errors.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    root.COR3 = root.COR3 || {};
    if (root.COR3.errors) return;

    // constants always loads before errors.js (manifest + popup.html order).
    const C = root.COR3.constants;
    const KEY = C.STORAGE_LOCAL.ERRORS;
    const MAX = C.LIMITS.ERRORS_RING;

    function describe(error) {
        if (!error) return { message: 'unknown', stack: undefined };
        if (error instanceof Error) return { message: error.message, stack: error.stack };
        if (typeof error === 'string') return { message: error };
        try { return { message: JSON.stringify(error) }; }
        catch (_) { return { message: String(error) }; }
    }

    /**
     * Log an error. Best-effort; never throws.
     * @param {string} source       e.g. 'auto-jobs', 'network-map'
     * @param {Error|string|object} error
     * @param {object} [context]
     */
    async function logError(source, error, context) {
        const desc = describe(error);
        const entry = {
            timestamp: new Date().toISOString(),
            source,
            message: desc.message,
            stack: desc.stack,
            context: context || undefined,
        };

        // Tee to centralized Logger if loaded
        try {
            if (root.COR3.Logger && typeof root.COR3.Logger.push === 'function') {
                root.COR3.Logger.push(source, 'error', desc.message, context);
            }
        } catch (_) { /* swallow */ }

        // Persist to storage if chrome.storage is available (i.e. not raw MAIN world)
        try {
            if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
            const data = await chrome.storage.local.get(KEY);
            const list = Array.isArray(data[KEY]) ? data[KEY] : [];
            list.push(entry);
            while (list.length > MAX) list.shift();
            await chrome.storage.local.set({ [KEY]: list });
        } catch (e) {
            try { console.error('[COR3] Failed to persist error:', e); } catch (_) {}
        }
    }

    async function getErrors() {
        try {
            if (typeof chrome === 'undefined' || !chrome.storage) return [];
            const data = await chrome.storage.local.get(KEY);
            return Array.isArray(data[KEY]) ? data[KEY] : [];
        } catch (_) { return []; }
    }

    async function clearErrors() {
        try {
            if (typeof chrome === 'undefined' || !chrome.storage) return;
            await chrome.storage.local.remove(KEY);
        } catch (_) {}
    }

    /**
     * Wrap a promise-returning function so any error is captured automatically.
     */
    function guard(source, fn) {
        return async function (...args) {
            try { return await fn.apply(this, args); }
            catch (e) {
                logError(source, e, { args: args.length ? '[...]' : undefined });
                throw e;
            }
        };
    }

    root.COR3.errors = { logError, getErrors, clearErrors, guard };

    // Global aliases for use from the F12 console.
    if (typeof root.cor3LogError !== 'function') root.cor3LogError = logError;
    if (typeof root.cor3GetErrors !== 'function') root.cor3GetErrors = getErrors;
    if (typeof root.cor3ClearErrors !== 'function') root.cor3ClearErrors = clearErrors;

    if (typeof root.cor3LogWsMessage !== 'function') {
        root.cor3LogWsMessage = function () {};
    }
    if (typeof root.cor3GetWsMessages !== 'function') {
        root.cor3GetWsMessages = async function () { return []; };
    }
    if (typeof root.cor3ClearWsMessages !== 'function') {
        root.cor3ClearWsMessages = async function () {};
    }
})();
