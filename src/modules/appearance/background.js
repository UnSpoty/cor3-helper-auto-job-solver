// src/modules/appearance/background.js
// Removes the cor3.gg background visual layers (#app-background, #glitch-background,
// #video-glitch, #video-waves) on page load. Toggled by chrome.storage.sync.disableBackground.
// Note: enabling the toggle removes the elements; disabling requires page reload to restore.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Store, Registry, constants: C } = root.COR3;

    const SELECTORS = ['#app-background', '#glitch-background', '#video-glitch', '#video-waves'];

    function deleteAll() {
        for (const sel of SELECTORS) {
            try {
                const el = document.querySelector(sel);
                if (el) el.remove();
            } catch (_) {}
        }
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
            if (enabled) setTimeout(deleteAll, 1000);
            this.track(Store.sync.onChanged((changes) => {
                const ch = changes[C.STORAGE_SYNC.DISABLE_BACKGROUND];
                if (!ch) return;
                if (ch.newValue) { deleteAll(); this.info('background elements removed'); }
                else this.info('background restored on next reload');
            }));
            this.info('background ready');
        }
    }

    Registry.register(new BackgroundModule());
})();
