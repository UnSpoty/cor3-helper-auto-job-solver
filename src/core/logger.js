// src/core/logger.js
// Centralized per-module logger.
//   • Stores a ring buffer (size LIMITS.LOG_RING_PER_MODULE) per module in
//     chrome.storage.local under STORAGE_LOCAL.LOGS.
//   • Lets the UI subscribe to live entries without polling storage.
//   • Honors per-module log toggle (Settings.getModuleState(id).logsEnabled);
//     when off, log calls become no-ops.
//   • Plugs into Bus.setTrace so cross-world traffic is logged automatically
//     under the synthetic module id 'bus'.
// Registers into globalThis.COR3.Logger.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    root.COR3 = root.COR3 || {};
    if (root.COR3.Logger) return;

    const C = root.COR3.constants;
    const Store = root.COR3.Store;
    if (!C || !Store) {
        console.error('[COR3.Logger] constants/Store must load before logger.js');
        return;
    }

    const LOG_KEY = C.STORAGE_LOCAL.LOGS;
    const RING = C.LIMITS.LOG_RING_PER_MODULE;

    // In-memory mirror to avoid a storage roundtrip per log call.
    // Shape: { [moduleId]: [{ ts, level, msg, ctx }, ...] }
    let buffer = null;
    let flushTimer = null;
    const FLUSH_MS = 500;

    // moduleId -> boolean (logs enabled). Defaults to true.
    const enabledByModule = new Map();

    const subscribers = new Set();

    async function ensureBuffer() {
        if (buffer) return buffer;
        const persisted = await Store.local.getOne(LOG_KEY, {});
        buffer = (persisted && typeof persisted === 'object') ? persisted : {};
        return buffer;
    }

    function scheduleFlush() {
        if (flushTimer) return;
        flushTimer = setTimeout(async () => {
            flushTimer = null;
            try { await Store.local.setOne(LOG_KEY, buffer); }
            catch (_) { /* swallow */ }
        }, FLUSH_MS);
    }

    function setLogsEnabled(moduleId, on) {
        enabledByModule.set(moduleId, !!on);
    }

    function isLogsEnabled(moduleId) {
        if (!enabledByModule.has(moduleId)) return true; // default-on
        return enabledByModule.get(moduleId);
    }

    // Detect whether this context can persist logs (chrome.storage available).
    // MAIN content world cannot — logs are forwarded to isolated world via Bus.
    const HAS_STORAGE = (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local);

    /**
     * Push a log entry. Synchronous from the caller's POV — the entry hits
     * the in-memory buffer immediately and the flush is debounced.
     * In contexts without chrome.storage (MAIN world), entries are forwarded
     * via Bus.window.post('COR3_LOG_REMOTE', {moduleId, entry}); the isolated
     * world's log-bridge ingests them.
     */
    function push(moduleId, level, msg, ctx) {
        if (!isLogsEnabled(moduleId)) return;
        const entry = {
            ts: Date.now(),
            level: level || C.LOG_LEVEL.INFO,
            msg: typeof msg === 'string' ? msg : safeStringify(msg),
            ctx: ctx === undefined ? undefined : ctx,
        };
        if (!HAS_STORAGE) {
            // MAIN world (or any context lacking chrome.storage): forward.
            try {
                if (root.COR3.Bus && root.COR3.Bus.window && typeof root.COR3.Bus.window.post === 'function') {
                    root.COR3.Bus.window.post('COR3_LOG_REMOTE', { moduleId, entry });
                }
            } catch (_) { /* swallow */ }
            return;
        }
        ingestLocal(moduleId, entry);
    }

    /**
     * Like push, but accepts a pre-built entry. Used by the log-bridge in the
     * isolated world to ingest entries forwarded from MAIN. Bypasses the
     * isLogsEnabled gate because MAIN already gated (we still tee through
     * notify so subscribers see remote entries).
     */
    function ingest(moduleId, entry) {
        if (!HAS_STORAGE) return; // never ingest in non-storage contexts
        ingestLocal(moduleId, entry);
    }

    function ingestLocal(moduleId, entry) {
        // Lazy buffer init — load (or create) the persisted ring FIRST, then
        // append. Pre-seeding `buffer = {}` here would make ensureBuffer()
        // short-circuit (`if (buffer) return buffer`) and never merge the
        // stored LOGS, so the first log after a page load wiped the whole ring.
        if (!buffer) {
            ensureBuffer().then(() => {
                if (!buffer[moduleId]) buffer[moduleId] = [];
                buffer[moduleId].push(entry);
                trimRing(buffer[moduleId]);
                notify(moduleId, entry);
                scheduleFlush();
            });
            return;
        }
        if (!buffer[moduleId]) buffer[moduleId] = [];
        buffer[moduleId].push(entry);
        trimRing(buffer[moduleId]);
        notify(moduleId, entry);
        scheduleFlush();
    }

    function trimRing(list) {
        while (list.length > RING) list.shift();
    }

    function notify(moduleId, entry) {
        for (const fn of subscribers) {
            try { fn(moduleId, entry); }
            catch (e) {
                try { console.error('[COR3.Logger] subscriber error', e); } catch (_) {}
            }
        }
    }

    function subscribe(fn) {
        subscribers.add(fn);
        return () => subscribers.delete(fn);
    }

    async function getAll() {
        await ensureBuffer();
        return buffer;
    }

    async function getModule(moduleId) {
        await ensureBuffer();
        return Array.isArray(buffer[moduleId]) ? buffer[moduleId].slice() : [];
    }

    // Clear log entries from the in-memory ring AND storage.
    //   • RegExp → drop every module id that matches (e.g. the v2 Activity Log
    //     clears /^(auto-jobs-v2|flow-v2-.+)$/).
    //   • string → drop that one module.
    //   • falsy  → wipe everything.
    // Mutating the shared `buffer` (not reassigning on the RegExp/string paths)
    // keeps a pending scheduleFlush() writing the already-cleared ring, so a
    // queued flush can't resurrect the entries we just removed.
    async function clear(moduleId) {
        await ensureBuffer();
        if (moduleId instanceof RegExp) {
            for (const id of Object.keys(buffer)) if (moduleId.test(id)) delete buffer[id];
        } else if (moduleId) {
            delete buffer[moduleId];
        } else {
            for (const id of Object.keys(buffer)) delete buffer[id];
        }
        await Store.local.setOne(LOG_KEY, buffer);
    }

    function safeStringify(v) {
        try { return JSON.stringify(v); }
        catch (_) { return String(v); }
    }

    // Auto-trace bus traffic under module id 'bus'.
    // CRITICAL: only register in contexts that can persist logs locally
    // (chrome.storage available). In MAIN world push() forwards every entry
    // via Bus.window.post('COR3_LOG_REMOTE'), and Bus.window.post fires the
    // trace synchronously — registering here would create unbounded synchronous
    // recursion (push → post → trace → push → …) that overflows the stack on
    // the first log line and freezes the tab so hard DevTools can't even open.
    // The receiving (isolated) side still traces 'recv', so we don't lose
    // visibility into bus traffic.
    let inTrace = false;
    if (HAS_STORAGE && root.COR3.Bus && typeof root.COR3.Bus.setTrace === 'function') {
        root.COR3.Bus.setTrace(({ direction, transport, type, payload }) => {
            if (inTrace) return;                 // re-entry guard
            if (type === 'COR3_LOG_REMOTE') return; // already ingested under its real moduleId
            inTrace = true;
            try { push('bus', C.LOG_LEVEL.DEBUG, `${direction.toUpperCase()} ${transport} ${type}`, payload); }
            finally { inTrace = false; }
        });
    }

    root.COR3.Logger = {
        push,
        ingest,
        subscribe,
        getAll,
        getModule,
        clear,
        setLogsEnabled,
        isLogsEnabled,
        HAS_STORAGE,
    };
})();
