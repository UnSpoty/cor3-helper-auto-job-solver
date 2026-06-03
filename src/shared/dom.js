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

    root.COR3.dom = {
        sleep,
        waitForEl,
        waitFor,
        clickEl,
        setReactInputValue,
    };
})();
