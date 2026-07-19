// src/modules/game/anti-afk.js  (world: MAIN)
// Anti-AFK — keeps cor3.gg from dropping into "Sleep Mode".
//
// The site arms a 5-minute inactivity timer that fires when NONE of the events
// ["mousemove","mousedown","keydown","touchstart","scroll"] reach `window`
// (verified live 2026-07-20 in the bundle: `setTimeout(enterSleep, 3e5)`, reset
// by `rp.forEach(ev => window.addEventListener(ev, reset, {passive:true}))`).
// Its reset handler ignores the event object, so a bare synthetic event resets
// the countdown — a single `window.dispatchEvent(new Event('mousemove'))` under
// 5 minutes keeps the page awake indefinitely with no visual side effect.
//
// Two tactics, both gated on the Overview toggle (STORAGE_SYNC.ANTI_AFK_ENABLED,
// default OFF) bridged here by the isolated automation/anti-afk module over
// MSG.UI.ANTI_AFK:
//   1. PREVENT — tick a synthetic activity event on `window` every TICK_MS.
//   2. AUTO-EXIT — a MutationObserver on the `SleepMode` overlay; if the tick
//      was ever throttled hard enough that sleep slipped in, click the overlay
//      + press Enter (both the site's documented exit paths) until it's gone.
//
// Must run in the MAIN world so `window` IS the page's real window that the
// site listens on. The isolated world only relays the toggle (no chrome.storage
// here).

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Registry, constants: C } = root.COR3;

    // < the site's 5-min (300000ms) threshold, with wide margin even under
    // background-tab timer throttling (which clamps to ~1/min — a 90s timer
    // still fires at ~90s, never pushed out to 300s).
    const TICK_MS = 90 * 1000;
    // One of the site's reset events. The handler ignores the object, so a bare
    // Event is enough; 'mousemove' has zero user-visible effect.
    const RESET_EVENT = 'mousemove';
    const SLEEP_SELECTOR = '[data-component-name="SleepMode"]';

    class AntiAfkModule extends Module {
        constructor() {
            super({
                id: 'anti-afk',
                name: 'Anti-AFK',
                category: C.CATEGORY.GAME,
            });
            this._enabled = false;
            this._timer = null;
            this._observer = null;
            this._exiting = false;
        }

        async start() {
            // Boots at document_start; do nothing until the isolated bridge
            // posts the verdict (default OFF — no fabricated default here).
            this.track(Bus.window.on(C.MSG.UI.ANTI_AFK, (env) => {
                this._apply(!!(env && env.enabled));
            }));
        }

        stop() {
            this._apply(false);
        }

        _apply(enabled) {
            if (enabled === this._enabled) return;
            this._enabled = enabled;
            if (enabled) {
                this._poke();                 // reset the countdown right now
                this._timer = root.setInterval(() => this._poke(), TICK_MS);
                this._watchSleepOverlay();
                this.info('anti-afk ON (keeping page awake)');
            } else {
                if (this._timer) { root.clearInterval(this._timer); this._timer = null; }
                if (this._observer) { this._observer.disconnect(); this._observer = null; }
                this._exiting = false;
                this.info('anti-afk OFF');
            }
        }

        // PREVENT: one synthetic activity event resets the site's inactivity
        // timer (its handler runs on any dispatched event, trusted or not).
        _poke() {
            try { root.dispatchEvent(new Event(RESET_EVENT)); }
            catch (e) { this.warn('poke failed', { error: String(e) }); }
        }

        // AUTO-EXIT fallback: catch the SleepMode overlay if it ever appears.
        _watchSleepOverlay() {
            if (this._observer || !root.document || !root.MutationObserver) return;
            // If sleep is already up when we enable, exit it immediately.
            if (root.document.querySelector(SLEEP_SELECTOR)) this._exitSleep();
            this._observer = new root.MutationObserver(() => {
                if (this._exiting) return;
                if (root.document.querySelector(SLEEP_SELECTOR)) this._exitSleep();
            });
            this._observer.observe(root.document.body || root.document.documentElement, { childList: true, subtree: true });
        }

        // The site exits sleep on a screen click OR an Enter keydown (the
        // overlay's own listeners). Retry both a few times — the Enter listener
        // only attaches ~300ms after the overlay mounts (once "showEnter" flips).
        _exitSleep() {
            if (this._exiting) return;
            this._exiting = true;
            this.info('sleep overlay detected — auto-exiting');
            let tries = 0;
            const attempt = () => {
                const node = root.document.querySelector(SLEEP_SELECTOR);
                if (!node || tries >= 8) { this._exiting = false; return; }
                tries++;
                try {
                    node.click();
                    root.dispatchEvent(new root.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
                } catch (_) { /* keep retrying */ }
                root.setTimeout(attempt, 400);
            };
            attempt();
        }
    }

    Registry.register(new AntiAfkModule());
})();
