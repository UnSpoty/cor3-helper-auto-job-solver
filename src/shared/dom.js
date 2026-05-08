// src/shared/dom.js
// Reusable DOM helpers for MAIN-world game-flow modules.
// No hard dependency on COR3.* — usable from any context.
// Registers into globalThis.COR3.dom.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    root.COR3 = root.COR3 || {};
    if (root.COR3.dom) return;

    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    /**
     * Poll for an element matching `selector` until found or timeout.
     * @param {string|function(): Element|null} selectorOrFn  CSS selector or custom finder
     * @param {object} [opts]
     * @param {number} [opts.timeout=10000]  ms
     * @param {number} [opts.poll=100]       ms between checks
     * @param {Element|Document} [opts.root=document]
     * @returns {Promise<Element|null>}
     */
    async function waitForEl(selectorOrFn, opts = {}) {
        const { timeout = 10000, poll = 100 } = opts;
        const root = opts.root || document;
        const find = typeof selectorOrFn === 'function'
            ? selectorOrFn
            : () => root.querySelector(selectorOrFn);
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
            const el = find();
            if (el) return el;
            await sleep(poll);
        }
        return null;
    }

    /**
     * Wait until `predicate()` returns truthy OR timeout.
     * Returns the truthy value, or null on timeout.
     */
    async function waitFor(predicate, opts = {}) {
        const { timeout = 10000, poll = 100 } = opts;
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
            const v = predicate();
            if (v) return v;
            await sleep(poll);
        }
        return null;
    }

    /**
     * Dispatch a realistic mouse-click sequence on an element.
     * React event listeners react to bubbling 'click' events; some libs also
     * watch mousedown/mouseup. We dispatch all three.
     */
    function clickEl(el) {
        if (!el) return false;
        const opts = { bubbles: true, cancelable: true, view: window };
        el.dispatchEvent(new MouseEvent('mousedown', opts));
        el.dispatchEvent(new MouseEvent('mouseup', opts));
        el.dispatchEvent(new MouseEvent('click', opts));
        return true;
    }

    function dblClickEl(el) {
        if (!el) return false;
        clickEl(el);
        clickEl(el);
        const opts = { bubbles: true, cancelable: true, view: window };
        el.dispatchEvent(new MouseEvent('dblclick', opts));
        return true;
    }

    /**
     * Set the value of a React-controlled input/textarea so the React state
     * updates correctly. Plain `el.value = x` does NOT trigger React's onChange.
     * We invoke the underlying setter, then dispatch an `input` event (React
     * 16+ uses delegation on the document for these).
     */
    function setReactInputValue(el, value) {
        if (!el) return false;
        const proto = el.tagName === 'TEXTAREA'
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    }

    /**
     * Find an element whose textContent contains `text` (trimmed, case-insensitive).
     * Optionally constrained to a CSS selector.
     */
    function findByText(text, selector = '*', root = document) {
        const needle = String(text).trim().toLowerCase();
        const candidates = root.querySelectorAll(selector);
        for (const el of candidates) {
            const t = (el.textContent || '').trim().toLowerCase();
            if (t === needle) return el;
        }
        return null;
    }

    function findContainsText(text, selector = '*', root = document) {
        const needle = String(text).trim().toLowerCase();
        const candidates = root.querySelectorAll(selector);
        for (const el of candidates) {
            const t = (el.textContent || '').trim().toLowerCase();
            if (t.includes(needle)) return el;
        }
        return null;
    }

    /**
     * Re-query helper for React virtual scroll containers that may be
     * replaced after each interaction. Returns latest container or null.
     */
    function requery(selector, root = document) {
        return root.querySelector(selector);
    }

    /**
     * Scroll element into view if needed (smooth=false to keep it instant).
     */
    function scrollIntoView(el) {
        if (!el || typeof el.scrollIntoView !== 'function') return;
        try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); }
        catch (_) { /* old browsers */ }
    }

    /**
     * Run `fn`, retrying up to `attempts` times with `delay` ms between, until
     * it returns a truthy value or all attempts fail. Useful for flaky React DOM.
     */
    async function retry(fn, { attempts = 3, delay = 250 } = {}) {
        for (let i = 0; i < attempts; i++) {
            try {
                const v = await fn();
                if (v) return v;
            } catch (_) { /* swallow, retry */ }
            if (i < attempts - 1) await sleep(delay);
        }
        return null;
    }

    root.COR3.dom = {
        sleep,
        waitForEl,
        waitFor,
        clickEl,
        dblClickEl,
        setReactInputValue,
        findByText,
        findContainsText,
        requery,
        scrollIntoView,
        retry,
    };
})();
