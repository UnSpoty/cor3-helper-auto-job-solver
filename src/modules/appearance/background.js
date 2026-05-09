// src/modules/appearance/background.js
// Hides the cor3.gg background visual layers (#app-background,
// #glitch-background, #video-glitch, #video-waves). Toggled by
// chrome.storage.sync.disableBackground. Hiding via display:none
// instead of .remove() so the toggle is reversible without reload.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Store, Registry, constants: C } = root.COR3;

    const SELECTORS = ['#app-background', '#glitch-background', '#video-glitch', '#video-waves'];
    const MARKER = 'data-cor3-bg-hidden';

    function hideAll() {
        for (const sel of SELECTORS) {
            try {
                document.querySelectorAll(sel).forEach((el) => {
                    if (el.style) {
                        el.style.display = 'none';
                        el.setAttribute(MARKER, 'true');
                    }
                });
            } catch (_) {}
        }
    }

    function showAll() {
        document.querySelectorAll(`[${MARKER}="true"]`).forEach((el) => {
            if (el.style) { el.style.display = ''; el.removeAttribute(MARKER); }
        });
    }

    class BackgroundModule extends Module {
        constructor() {
            super({
                id: 'appearance-background',
                name: 'Disable background',
                category: C.CATEGORY.APPEARANCE,
                owns: { storageKeys: [C.STORAGE_SYNC.DISABLE_BACKGROUND] },
                defaultEnabled: false,
            });
        }
        async start() {
            const enabled = await Store.sync.getOne(C.STORAGE_SYNC.DISABLE_BACKGROUND, false);
            if (enabled) setTimeout(hideAll, 1000);
            this.track(Store.sync.onChanged((changes) => {
                const ch = changes[C.STORAGE_SYNC.DISABLE_BACKGROUND];
                if (!ch) return;
                if (ch.newValue) { hideAll(); this.info('background hidden'); }
                else { showAll(); this.info('background restored'); }
            }));
            this.info('background ready');
        }
    }

    Registry.register(new BackgroundModule());
})();
