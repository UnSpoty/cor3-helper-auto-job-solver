// src/modules/appearance/network-fog.js
// Hides Network Map fog videos (fog.mp4, fog_layer_2.mp4). Uses a
// MutationObserver to handle dynamically-mounted videos.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Store, Registry, constants: C } = root.COR3;

    let observer = null;

    function isFogVideo(v) {
        const src = v.getAttribute('src') || '';
        return src.includes('/video/network-map/fog.mp4') || src.includes('/video/network-map/fog_layer_2.mp4');
    }

    function hideAll() {
        document.querySelectorAll('video').forEach((v) => {
            if (isFogVideo(v)) {
                v.style.display = 'none';
                v.pause();
                v.setAttribute('data-cor3-fog-hidden', 'true');
            }
        });
    }

    function showAll() {
        document.querySelectorAll('[data-cor3-fog-hidden="true"]').forEach((v) => {
            v.style.display = '';
            v.removeAttribute('data-cor3-fog-hidden');
            v.play().catch(() => {});
        });
    }

    function startObserver() {
        if (observer) return;
        observer = new MutationObserver(() => hideAll());
        observer.observe(document.body, { childList: true, subtree: true });
    }
    function stopObserver() {
        if (observer) { observer.disconnect(); observer = null; }
    }

    class NetworkFogModule extends Module {
        constructor() {
            super({
                id: 'appearance-network-fog',
                name: 'Disable network fog',
                category: C.CATEGORY.APPEARANCE,
                owns: { storageKeys: [C.STORAGE_SYNC.DISABLE_NETWORK_FOG] },
                // Module always loads; FEATURE off by default via storage default.
            });
        }
        async start() {
            const enabled = await Store.sync.getOne(C.STORAGE_SYNC.DISABLE_NETWORK_FOG, false);
            if (enabled) setTimeout(() => { hideAll(); startObserver(); }, 1000);

            this.track(Store.sync.onSettingChange(C.STORAGE_SYNC.DISABLE_NETWORK_FOG, (newValue) => {
                if (newValue) { hideAll(); startObserver(); this.info('fog hidden'); }
                else { showAll(); stopObserver(); this.info('fog restored'); }
            }));
            this.track(() => stopObserver());
            this.info('network-fog ready');
        }
    }

    Registry.register(new NetworkFogModule());
})();
