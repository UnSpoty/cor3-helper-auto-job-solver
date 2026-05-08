// src/modules/appearance/system-messages.js
// Hides cor3.gg system message / notification / alert toasts via DOM
// MutationObserver. Toggled by chrome.storage.sync.disableSystemMessages.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Store, Registry, constants: C } = root.COR3;

    const SELECTORS = [
        '[class*="system-message"]', '[class*="notification"]', '[class*="alert"]',
        '[id*="system-message"]', '[id*="notification"]',
        '.toast-container', '.notification-container', '[role="alert"]',
    ];

    let observer = null;

    function hideAll() {
        for (const sel of SELECTORS) {
            try {
                document.querySelectorAll(sel).forEach((el) => {
                    if (el && el.style) {
                        el.style.display = 'none';
                        el.setAttribute('data-cor3-hidden', 'true');
                    }
                });
            } catch (_) {}
        }
    }

    function showAll() {
        document.querySelectorAll('[data-cor3-hidden="true"]').forEach((el) => {
            if (el && el.style) { el.style.display = ''; el.removeAttribute('data-cor3-hidden'); }
        });
    }

    function startObserver() {
        if (observer) return;
        observer = new MutationObserver((mutations) => {
            for (const m of mutations) {
                for (const node of m.addedNodes) {
                    if (node.nodeType !== 1) continue;
                    for (const sel of SELECTORS) {
                        try {
                            if (node.matches && node.matches(sel)) {
                                node.style.display = 'none';
                                node.setAttribute('data-cor3-hidden', 'true');
                            }
                            const children = node.querySelectorAll(sel);
                            children.forEach((c) => { c.style.display = 'none'; c.setAttribute('data-cor3-hidden', 'true'); });
                        } catch (_) {}
                    }
                }
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    function stopObserver() {
        if (observer) { observer.disconnect(); observer = null; }
    }

    class SystemMessagesModule extends Module {
        constructor() {
            super({
                id: 'appearance-system-messages',
                name: 'Hide system messages',
                category: C.CATEGORY.APPEARANCE,
                owns: { storageKeys: [C.STORAGE_SYNC.DISABLE_SYSTEM_MESSAGES] },
                defaultEnabled: false,
            });
        }
        async start() {
            const enabled = await Store.sync.getOne(C.STORAGE_SYNC.DISABLE_SYSTEM_MESSAGES, false);
            if (enabled) { setTimeout(() => { hideAll(); startObserver(); }, 1000); }

            this.track(Store.sync.onChanged((changes) => {
                const ch = changes[C.STORAGE_SYNC.DISABLE_SYSTEM_MESSAGES];
                if (!ch) return;
                if (ch.newValue) { hideAll(); startObserver(); this.info('hiding system messages'); }
                else { showAll(); stopObserver(); this.info('showing system messages'); }
            }));
            this.track(() => stopObserver());
            this.info('system-messages ready');
        }
    }

    Registry.register(new SystemMessagesModule());
})();
