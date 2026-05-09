// src/modules/appearance/map-fx.js
// Disables visual FX on the network map: SVG glow filters, glitch/wave videos,
// CRT scanlines, distortion keyframes. Toggled via storage key disableMapFx.
// Note: this uses its own sync key (disableMapFxEnabled) — it pre-existed in
// the legacy code. Constants list it as a one-off.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Store, Registry, constants: C } = root.COR3;

    const SYNC_KEY = 'disableMapFxEnabled'; // legacy key — kept for back-compat
    const STYLE_ID = 'cor3-helper-mapfx-disable';

    function applyMapFx(disable) {
        const existing = document.getElementById(STYLE_ID);
        if (disable) {
            if (!existing) {
                const style = document.createElement('style');
                style.id = STYLE_ID;
                style.textContent = [
                    'svg * { filter: none !important; }',
                    '#video-glitch, #video-waves { display: none !important; }',
                    'video[data-sentry-component="FogVideo"] { display: none !important; }',
                    '#glitch-background { display: none !important; }',
                    '.crt-effect::before { display: none !important; animation: none !important; }',
                    '@keyframes go248007083 { 0%,100% { transform: none; } }',
                    '@keyframes go3433233158 { 0%,100% { transform: none; } }',
                    '@keyframes go1942270456 { 0%,100% { transform: none; } }',
                    '@keyframes go3457846050 { 0%,100% { opacity: 0; } }',
                    '@keyframes go3062458513 { 0%,100% { transform: none; filter: none; opacity: 1; } }',
                ].join('\n');
                document.head.appendChild(style);
            }
            document.querySelectorAll('#video-glitch video, #video-waves video, video[data-sentry-component="FogVideo"]')
                .forEach((v) => v.pause());
        } else {
            if (existing) existing.remove();
            document.querySelectorAll('#video-glitch video, #video-waves video, video[data-sentry-component="FogVideo"]')
                .forEach((v) => v.play().catch(() => {}));
        }
    }

    class MapFxModule extends Module {
        constructor() {
            super({
                id: 'appearance-map-fx',
                name: 'Disable map FX',
                category: C.CATEGORY.APPEARANCE,
                owns: { storageKeys: [SYNC_KEY] },
                // Module always loads; FEATURE off by default via storage default.
            });
        }
        async start() {
            const enabled = await Store.sync.getOne(SYNC_KEY, false);
            if (enabled) applyMapFx(true);

            this.track(Store.sync.onSettingChange(SYNC_KEY, (newValue) => {
                applyMapFx(!!newValue);
                this.info(newValue ? 'map FX disabled' : 'map FX enabled');
            }));
            this.info('map-fx ready');
        }
    }

    Registry.register(new MapFxModule());
})();
