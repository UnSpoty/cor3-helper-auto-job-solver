// Helper used by isolated-world modules to inject MAIN-world scripts via
// <script src="chrome-extension://…"> tags.
// Lives in MAIN world too so it can self-load helpers if needed.
// Registers into globalThis.COR3.solverLoader.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    root.COR3 = root.COR3 || {};
    if (root.COR3.solverLoader) return;

    const loaded = new Set();

    /**
     * Inject a script registered in manifest's `web_accessible_resources` into
     * the page (MAIN world). Idempotent per `path`. Returns the resolved <script>
     * element or null on failure.
     */
    function inject(path) {
        if (loaded.has(path)) return null;
        if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.getURL) {
            console.warn('[COR3.solverLoader] chrome.runtime.getURL unavailable — skipping', path);
            return null;
        }
        try {
            const url = chrome.runtime.getURL(path);
            const s = document.createElement('script');
            s.src = url;
            s.dataset.cor3Loader = path;
            s.onload = () => s.remove();
            (document.head || document.documentElement).appendChild(s);
            loaded.add(path);
            return s;
        } catch (e) {
            console.error('[COR3.solverLoader] inject failed', path, e);
            return null;
        }
    }

    function isLoaded(path) { return loaded.has(path); }

    /**
     * Force-mark a path as already loaded — used when the page re-injects on
     * its own and we shouldn't double-load.
     */
    function markLoaded(path) { loaded.add(path); }

    root.COR3.solverLoader = { inject, isLoaded, markLoaded };
})();
