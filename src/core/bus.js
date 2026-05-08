// src/core/bus.js
// Cross-context message bus. Two transport surfaces:
//   • Bus.window  — window.postMessage (MAIN ↔ isolated content world)
//   • Bus.runtime — chrome.runtime.sendMessage (isolated ↔ popup ↔ SW)
// Both surfaces share the SAME envelope shape: { type, payload, _src? }.
// Registers into globalThis.COR3.Bus.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    root.COR3 = root.COR3 || {};
    if (root.COR3.Bus) return;

    // Trace hook (optional). Logger plugs into this once it's initialized.
    let traceFn = null;
    function setTrace(fn) { traceFn = (typeof fn === 'function') ? fn : null; }
    function trace(direction, transport, type, payload) {
        if (!traceFn) return;
        try { traceFn({ direction, transport, type, payload }); } catch (_) {}
    }

    // ──────────────────────────────────────────────────────────────────────
    // window.postMessage transport
    // ──────────────────────────────────────────────────────────────────────
    const winListeners = new Map(); // type -> Set<handler>
    let winInstalled = false;

    function installWindowListener() {
        if (winInstalled) return;
        if (typeof window === 'undefined') return; // no window in SW
        winInstalled = true;
        window.addEventListener('message', (event) => {
            if (event.source !== window) return;
            const data = event.data;
            if (!data || typeof data.type !== 'string') return;
            const set = winListeners.get(data.type);
            trace('recv', 'window', data.type, data);
            if (!set) return;
            for (const fn of set) {
                try { fn(data); } catch (e) {
                    try { console.error('[COR3.Bus.window] handler error', data.type, e); } catch (_) {}
                }
            }
        });
    }

    function winPost(type, payload) {
        if (typeof window === 'undefined') return;
        const envelope = (payload && typeof payload === 'object')
            ? Object.assign({ type }, payload)
            : { type, payload };
        trace('send', 'window', type, envelope);
        window.postMessage(envelope, '*');
    }

    function winOn(type, handler) {
        installWindowListener();
        if (!winListeners.has(type)) winListeners.set(type, new Set());
        winListeners.get(type).add(handler);
        return () => winOff(type, handler);
    }

    function winOff(type, handler) {
        const set = winListeners.get(type);
        if (set) set.delete(handler);
    }

    // ──────────────────────────────────────────────────────────────────────
    // chrome.runtime.sendMessage transport
    // ──────────────────────────────────────────────────────────────────────
    const rtListeners = new Map(); // type -> Set<handler(payload, sender, sendResponse)>
    let rtInstalled = false;

    function installRuntimeListener() {
        if (rtInstalled) return;
        if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.onMessage) return;
        rtInstalled = true;
        chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
            if (!msg) return false;
            // Accept both shapes: Bus-style { type, payload } and legacy { action, ...flat }
            const key = (typeof msg.type === 'string') ? msg.type
                      : (typeof msg.action === 'string') ? msg.action : null;
            if (!key) return false;
            const payload = (msg.payload !== undefined) ? msg.payload : msg;
            const set = rtListeners.get(key);
            trace('recv', 'runtime', key, msg);
            if (!set || set.size === 0) return false;
            let asyncReply = false;
            for (const fn of set) {
                try {
                    const result = fn(payload, sender, sendResponse);
                    if (result && typeof result.then === 'function') {
                        asyncReply = true;
                        result.then(
                            (v) => { try { sendResponse(v); } catch (_) {} },
                            (e) => { try { sendResponse({ error: String(e) }); } catch (_) {} }
                        );
                    }
                } catch (e) {
                    try { console.error('[COR3.Bus.runtime] handler error', key, e); } catch (_) {}
                }
            }
            return asyncReply;
        });
    }

    function rtSend(type, payload) {
        if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
            return Promise.resolve(undefined);
        }
        const envelope = { type, payload: payload === undefined ? null : payload };
        trace('send', 'runtime', type, envelope);
        return new Promise((resolve) => {
            try {
                chrome.runtime.sendMessage(envelope, (response) => {
                    // chrome.runtime.lastError is read here to silence "Receiving end does not exist"
                    void chrome.runtime.lastError;
                    resolve(response);
                });
            } catch (_) {
                resolve(undefined);
            }
        });
    }

    function rtOn(type, handler) {
        installRuntimeListener();
        if (!rtListeners.has(type)) rtListeners.set(type, new Set());
        rtListeners.get(type).add(handler);
        return () => rtOff(type, handler);
    }

    function rtOff(type, handler) {
        const set = rtListeners.get(type);
        if (set) set.delete(handler);
    }

    root.COR3.Bus = {
        window: { post: winPost, on: winOn, off: winOff },
        runtime: { send: rtSend, on: rtOn, off: rtOff },
        setTrace,
    };
})();
