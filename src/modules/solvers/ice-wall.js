// src/modules/solvers/ice-wall.js
// Auto-solver for the SAI "Porter-lite r4" / ICE WALL Break minigame.
// Watch loop polls for [data-sentry-component="IceWallBreakApplication"];
// when the wall stage is rendered, scan the WallBoard for "lit" glyphs
// (paths filled `#76C1D1` instead of the dark `#00121D` background) and
// match their geometric signatures against the TargetPreview. Click any
// matching glyph to advance the sidebar counter (0/3 → 3/3 wins).
//
// Lives in MAIN world. Logger forwards via Bus.
//
// Status (May 2026): the DOM analysis layer is verified live —
// 100 glyphs on the board, 9 in the target preview (5 unique signatures),
// 4-30 lit at any moment (puzzle pulses them in/out over time). Click
// dispatch is the open question: dispatching MouseEvent / PointerEvent
// sequences on the bounding triangle, on the wrapper <g>, on the SVG
// path under elementFromPoint, and even hover+down+up sequences all
// fail to advance the counter on this build. The puzzle likely requires
// trusted user-input events (event.isTrusted === true) or has its
// React onClick bound through a path our dispatched events don't reach.
// `attemptClick()` is wired up but no-op in practice — keeping it here
// as the integration point for whatever click-trigger the next iteration
// lands on (CDP Input.dispatchMouseEvent through the SW + chrome.debugger
// is one option; another is finding the React fiber and calling its
// onClick prop directly).

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Registry, dom, constants: C } = root.COR3;
    const MSG = C.MSG;

    const SEL = {
        APP:        '[data-sentry-component="IceWallBreakApplication"]',
        WALL:       '[data-sentry-component="WallBoard"]',
        TARGET:     '[data-sentry-component="TargetPreview"]',
        TRIANGLE:   '[data-sentry-component="GlyphBoundingTriangle"]',
        COUNTER:    '[data-sentry-element="SidebarCounterStyled"]',
        TIMER:      '[data-sentry-element="TimerBoxesStyled"]',
        EVENT_LOG:  '[data-sentry-element="EventLogStyled"]',
    };
    const COLOR_LIT = '#76C1D1';     // visible / interactive
    const MIN_LIT_PATHS = 4;          // a fully-rendered glyph has 4-9 cyan paths

    // ─── Geometry helpers ────────────────────────────────────────────────
    /**
     * Build a stable signature for a glyph: sorted list of d= attributes
     * for paths and the x,y,w,h,transform for rects, excluding the
     * transparent bounding triangle (which is a hit area, not visual).
     * Two glyphs with the same signature are visually identical.
     */
    function glyphSignature(glyphGroup) {
        // Each top-level glyph is <g class=…><g transform="translate(X,Y)">…shapes…</g></g>
        const inner = glyphGroup.children[0];
        const root = (inner && inner.tagName === 'g') ? inner : glyphGroup;
        const shapes = [];
        for (const c of root.children) {
            if (c.dataset && c.dataset.sentryComponent === 'GlyphBoundingTriangle') continue;
            if (c.tagName === 'path') shapes.push('p:' + (c.getAttribute('d') || ''));
            else if (c.tagName === 'rect') shapes.push('r:' + ['x','y','width','height','transform'].map((a) => c.getAttribute(a) || '').join(','));
        }
        shapes.sort();
        return shapes.join('|');
    }

    function isGlyphLit(glyphGroup) {
        let cyan = 0;
        const all = glyphGroup.querySelectorAll('path, rect');
        for (const el of all) {
            if (el.dataset && el.dataset.sentryComponent === 'GlyphBoundingTriangle') continue;
            if (el.getAttribute('fill') === COLOR_LIT) cyan++;
        }
        return cyan >= MIN_LIT_PATHS;
    }

    function readTargetSignatures() {
        const target = document.querySelector(SEL.TARGET);
        if (!target) return new Set();
        const groups = Array.from(target.querySelectorAll(':scope > g'));
        return new Set(groups.map(glyphSignature));
    }

    function readCounter() {
        const txt = document.querySelector(SEL.COUNTER)?.textContent || '';
        const m = txt.match(/(\d+)\s*\/\s*(\d+)/);
        if (!m) return null;
        return { current: +m[1], total: +m[2] };
    }

    function readTimerSeconds() {
        const txt = document.querySelector(SEL.TIMER)?.textContent || '';
        const m = txt.match(/(\d+)M\s*(\d+)S/i);
        if (!m) return null;
        return (+m[1]) * 60 + (+m[2]);
    }

    // ─── Click attempt ───────────────────────────────────────────────────
    /**
     * Best-effort click: dispatches pointer + mouse sequence at the centre
     * of the bounding triangle. This is the same shape that worked for
     * Auto-decrypt's ParameterCells — if the puzzle accepts it, great;
     * empirically (May 2026) it does NOT advance the counter, so this is
     * the open TODO. The function still runs so the rest of the pipeline
     * is exercisable end-to-end the moment a working dispatch is found.
     */
    async function attemptClick(glyphGroup) {
        const tri = glyphGroup.querySelector(SEL.TRIANGLE);
        if (!tri) return false;
        const r = tri.getBoundingClientRect();
        const evtBase = {
            bubbles: true, cancelable: true, view: window,
            clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
            button: 0, buttons: 1,
        };
        try {
            tri.dispatchEvent(new PointerEvent('pointerdown', { ...evtBase, pointerType: 'mouse', pointerId: 1 }));
            tri.dispatchEvent(new PointerEvent('pointerup',   { ...evtBase, pointerType: 'mouse', pointerId: 1, buttons: 0 }));
        } catch (_) { /* PointerEvent unsupported — fall through to MouseEvent */ }
        tri.dispatchEvent(new MouseEvent('mousedown', evtBase));
        tri.dispatchEvent(new MouseEvent('mouseup',   { ...evtBase, buttons: 0 }));
        tri.dispatchEvent(new MouseEvent('click',     { ...evtBase, buttons: 0 }));
        return true;
    }

    // ─── Main loop ───────────────────────────────────────────────────────
    /**
     * One pass over the wall: find every lit glyph whose signature is in
     * the target set, and attempt-click them. The puzzle pulses glyphs
     * on and off, so we re-scan continuously until counter is full.
     */
    async function solveOnce(mod) {
        const target = document.querySelector(SEL.TARGET);
        const wall = document.querySelector(SEL.WALL);
        if (!target || !wall) {
            mod.warn('puzzle stage incomplete — TargetPreview or WallBoard missing');
            return false;
        }
        const targetSigs = readTargetSignatures();
        if (targetSigs.size === 0) { mod.warn('no target signatures'); return false; }
        mod.info(`watching wall — ${targetSigs.size} target signature(s)`);

        const seenClicked = new Set();   // skip glyphs we've already dispatched on
        const startCounter = readCounter();
        const startTime = Date.now();

        while (!root.__iceWallAbort) {
            // Bail conditions
            if (!document.querySelector(SEL.APP)) { mod.info('puzzle window closed'); return true; }
            const c = readCounter();
            if (c && c.current >= c.total) { mod.info(`solved: ${c.current}/${c.total}`); return true; }
            if (Date.now() - startTime > 180_000) { mod.warn('safety timeout (180s) — exiting solve loop'); return false; }

            // Re-scan wall every tick
            const wallGroups = Array.from(wall.querySelectorAll(':scope > g > g'));
            let dispatched = 0;
            for (const g of wallGroups) {
                if (root.__iceWallAbort) break;
                const transform = g.children[0]?.getAttribute('transform') || '';
                const id = transform;     // transform uniquely identifies a board cell
                if (seenClicked.has(id)) continue;
                if (!isGlyphLit(g)) continue;
                if (!targetSigs.has(glyphSignature(g))) continue;
                await attemptClick(g);
                seenClicked.add(id);
                dispatched++;
                await dom.sleep(80);
            }
            if (dispatched > 0) mod.debug(`dispatched ${dispatched} click(s) this tick`);
            await dom.sleep(250);
        }

        return false;
    }

    async function watchLoop(mod) {
        while (!root.__iceWallAbort) {
            await dom.sleep(300);
            const app = document.querySelector(SEL.APP);
            if (!app) continue;
            // Wait for stage to actually render (DecorativeIntro animation
            // runs first; WallBoard and TargetPreview only mount after).
            const ready = await dom.waitFor(
                () => document.querySelector(SEL.WALL) && document.querySelector(SEL.TARGET),
                { timeout: 8000 }
            );
            if (!ready) { mod.debug('stage never became ready'); continue; }

            const start = readCounter();
            const timer = readTimerSeconds();
            mod.info(`ice-wall puzzle detected (counter ${start?.current ?? '?'}/${start?.total ?? '?'}, ${timer ?? '?'}s left)`);
            await solveOnce(mod);

            // Wait for puzzle to close before resuming the watch
            while (!root.__iceWallAbort && document.querySelector(SEL.APP)) {
                await dom.sleep(400);
            }
            if (!root.__iceWallAbort) mod.debug('puzzle closed, watching for next one');
        }

        root.__iceWallActive = false;
        root.__iceWallAbort = false;
        mod.info('ice-wall solver stopped');
    }

    class IceWallSolverModule extends Module {
        constructor() {
            super({
                id: 'solver-ice-wall',
                name: 'Solver: ICE WALL Break',
                category: C.CATEGORY.SOLVER,
                owns: { busTypes: [MSG.SOLVER.START_ICE_WALL, MSG.SOLVER.STOP_ICE_WALL] },
            });
        }
        async start() {
            this.track(Bus.window.on(MSG.SOLVER.START_ICE_WALL, () => {
                if (root.__iceWallActive && !root.__iceWallAbort) {
                    this.debug('start ignored — already active');
                    return;
                }
                root.__iceWallAbort = false;
                root.__iceWallActive = true;
                this.info('ice-wall solver started');
                watchLoop(this);
            }));
            this.track(Bus.window.on(MSG.SOLVER.STOP_ICE_WALL, () => {
                root.__iceWallAbort = true;
                this.info('ice-wall solver stop requested');
            }));
        }
    }

    Registry.register(new IceWallSolverModule());
})();
