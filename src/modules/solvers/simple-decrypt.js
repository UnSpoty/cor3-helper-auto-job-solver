// Auto-solver for the cor3.gg "Simple Decrypt" minigame — the one-click
// progress-bar hack that shows a single Decrypt button and ticks a
// percentage label up to 100%.
//
// Strategy: watch loop polls for [data-sentry-component=
// "SimpleDecryptApplication"]; when present, dispatch a click on the
// Decrypt button and then poll the footer label / app presence until
// progress reads 100% or the window closes. Aborts on user toggle-off.
//
// Lives in MAIN world. Same start/stop pattern as solver-decrypt /
// solver-ice-wall; toggle wired through auto-simple-decrypt in isolated.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Registry, dom, constants: C } = root.COR3;
    const MSG = C.MSG;

    // Stable component-name selectors. Goober "go…" hashes change between
    // builds, but data-sentry-* attributes stay.
    const SEL = {
        APP:      '[data-sentry-component="SimpleDecryptApplication"], [data-component-name="SimpleDecryptApplication"]',
        BUTTON:   '[data-sentry-element="DecryptButtonStyled"]',
        PROGRESS: '[data-sentry-element="FooterCenterLabelStyled"]',
    };

    function findApp() { return document.querySelector(SEL.APP); }
    function findButton() { return document.querySelector(SEL.BUTTON); }

    function getProgressPercent() {
        const label = document.querySelector(SEL.PROGRESS);
        if (!label) return null;
        const m = (label.textContent || '').match(/(\d+)\s*%/);
        return m ? parseInt(m[1], 10) : null;
    }

    function clickDecrypt(btn) {
        const opts = { bubbles: true, cancelable: true, view: window };
        btn.dispatchEvent(new MouseEvent('mousedown', opts));
        btn.dispatchEvent(new MouseEvent('mouseup', opts));
        btn.dispatchEvent(new MouseEvent('click', opts));
    }

    // Run one full minigame instance: click → poll → return when finished.
    async function solveOnce(mod) {
        // Brief settle to let the React UI mount the button.
        await dom.sleep(400);
        if (root.__simpleDecryptAbort) return;

        const btn = findButton();
        if (!btn) { mod.error('Decrypt button not found'); return; }
        clickDecrypt(btn);
        mod.info('clicked Decrypt — waiting for progress');

        const MAX_WAIT_MS = 120000;
        const start = Date.now();
        let lastPct = -1;
        while (Date.now() - start < MAX_WAIT_MS) {
            if (root.__simpleDecryptAbort) return;
            if (!findApp()) {
                const elapsed = Math.round((Date.now() - start) / 1000);
                mod.info(`solved in ${elapsed}s`);
                return;
            }
            const pct = getProgressPercent();
            if (pct !== null && pct !== lastPct) {
                lastPct = pct;
                if (pct % 25 === 0 || pct >= 90) mod.debug(`progress ${pct}%`);
            }
            if (pct !== null && pct >= 100) {
                mod.info('progress 100% — waiting for window to close');
                // Game closes itself shortly after — give it a moment so
                // the watch loop doesn't immediately re-detect the same
                // instance during teardown.
                await dom.sleep(1500);
                return;
            }
            await dom.sleep(400);
        }
        mod.warn('timed out after 2 minutes');
    }

    async function watchLoop(mod) {
        while (!root.__simpleDecryptAbort) {
            await dom.sleep(400);
            if (!findApp()) continue;

            mod.info('minigame detected');
            await solveOnce(mod);
            if (root.__simpleDecryptAbort) break;

            // Wait for the puzzle window to fully tear down before
            // re-arming, otherwise we'd loop on the closing animation.
            while (!root.__simpleDecryptAbort && findApp()) {
                await dom.sleep(200);
            }
            if (!root.__simpleDecryptAbort) mod.debug('window closed, watching for next one');
        }
        root.__simpleDecryptActive = false;
        root.__simpleDecryptAbort = false;
        // Lost-wakeup guard: if an owner re-armed us in the narrow window between
        // the abort being detected and this teardown, restart instead of dying.
        if (root.__simpleDecryptOwners && root.__simpleDecryptOwners.size > 0) {
            mod.debug(`owner present after teardown ([${[...root.__simpleDecryptOwners].join(', ')}]) — restarting watch loop`);
            root.__simpleDecryptActive = true;
            watchLoop(mod);
            return;
        }
        mod.info('simple-decrypt solver stopped');
    }

    class SimpleDecryptSolverModule extends Module {
        constructor() {
            super({
                id: 'solver-simple-decrypt',
                name: 'Solver: Simple Decrypt minigame',
                category: C.CATEGORY.SOLVER,
                owns: { busTypes: [MSG.SOLVER.START_SIMPLE_DECRYPT, MSG.SOLVER.STOP_SIMPLE_DECRYPT] },
            });
        }
        async start() {
            // Owner-aware lifecycle — mirrors solver-decrypt. 'user' = the
            // standalone Auto-simple-decrypt toggle (auto-simple-decrypt.js);
            // 'flow' = an Auto Jobs flow. The loop runs while any owner is
            // present; a STOP removes only that owner and aborts only when the set
            // empties, so a flow ending never kills the user's standalone watcher.
            root.__simpleDecryptOwners = root.__simpleDecryptOwners || new Set();

            this.track(Bus.window.on(MSG.SOLVER.START_SIMPLE_DECRYPT, (env) => {
                const owner = (env && env.owner) ? env.owner : 'user';
                root.__simpleDecryptOwners.add(owner);
                root.__simpleDecryptAbort = false;   // cancel any pending abort
                if (root.__simpleDecryptActive) { this.debug(`start ignored — already active (owner ${owner})`); return; }
                root.__simpleDecryptActive = true;
                this.info(`simple-decrypt solver started (owner ${owner})`);
                watchLoop(this);
            }));
            this.track(Bus.window.on(MSG.SOLVER.STOP_SIMPLE_DECRYPT, (env) => {
                const owner = (env && env.owner) ? env.owner : 'user';
                root.__simpleDecryptOwners.delete(owner);
                if (root.__simpleDecryptOwners.size > 0) { this.debug(`stop from '${owner}' ignored — still owned by [${[...root.__simpleDecryptOwners].join(', ')}]`); return; }
                root.__simpleDecryptAbort = true;
                this.info(`simple-decrypt solver stop requested (owner ${owner})`);
            }));
        }
    }

    Registry.register(new SimpleDecryptSolverModule());
})();
