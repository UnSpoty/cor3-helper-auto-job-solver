// src/modules/solvers/ice-wall.js
// Auto-solver for the SAI "Porter-lite r4" / ICE WALL Break minigame.
//
// Mechanic (verified live, May 2026):
//   • Board = 10-row triangle of 100 small triangles (cells point up or
//     down; 19-cell-wide bottom row, 1-cell apex). Cells are <g> groups
//     with `transform="translate(X, Y)"` and optional `scale(1, -1)` for
//     down-pointing.
//   • Target preview = a 3-row SUB-triangle of 9 cells, drawn as a
//     scaled-down preview on the sidebar.
//   • The puzzle's challenge is to find WHERE on the big board a 3-row
//     sub-triangle has the exact 9 cells (signature + orientation)
//     matching the target preview. Three rounds total → counter 0/3 → 3/3.
//   • To answer, click the apex (top up-pointing cell) of the matching
//     sub-triangle.
//
// Algorithm — position-aware matching:
//   1. Read all 9 target cells; record their (x, y, mirror, signature)
//      and offsets relative to the target apex.
//   2. For each non-mirrored board cell as a candidate apex, check
//      whether all 9 target cells appear at the corresponding
//      board offset with matching signature AND matching mirror flag.
//   3. There's typically exactly ONE such apex per round. Click it.
//
// Status (May 2026): the matcher is verified live — finds a unique
// apex per round with 100% accuracy. Click DISPATCH is still the open
// problem: MouseEvent / PointerEvent sequences, hover+down+up,
// elementFromPoint, native .click(), AND directly invoking the React
// onClick prop via __reactProps$<key> all fail to advance the counter.
// The puzzle apparently requires `event.isTrusted === true`, which
// JS-dispatched events can't satisfy from inside the page. Possible
// next steps: chrome.debugger Input.dispatchMouseEvent from the SW, or
// inspecting cor3.gg's onClick handler to find a state-setter we can
// call instead of the event handler. `attemptClick()` is wired up so
// the rest of the pipeline is exercisable end-to-end the moment the
// click trigger is figured out.
//
// Lives in MAIN world. Logger forwards via Bus.

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

    function parseTransform(tStr) {
        const t = tStr || '';
        const m = t.match(/translate\(([^,]+),\s*([^)]+)\)/);
        return {
            x: m ? parseFloat(m[1]) : 0,
            y: m ? parseFloat(m[2]) : 0,
            mirror: /scale\(1\s*,\s*-1\)/.test(t),
        };
    }

    function readTargetCells() {
        const target = document.querySelector(SEL.TARGET);
        if (!target) return [];
        return Array.from(target.querySelectorAll(':scope > g')).map((g) => ({
            ...parseTransform(g.getAttribute('transform')),
            sig: glyphSignature(g),
        }));
    }

    function readBoardCells() {
        const wall = document.querySelector(SEL.WALL);
        if (!wall) return [];
        return Array.from(wall.querySelectorAll(':scope > g > g')).map((g) => ({
            ...parseTransform(g.children[0]?.getAttribute('transform')),
            sig: glyphSignature(g),
            lit: isGlyphLit(g),
            group: g,
        }));
    }

    /**
     * Find every (apex_x, apex_y) on the board where the target's 9-cell
     * pattern matches exactly: same signature AND same up/down orientation
     * at every offset from the apex. Typically returns 0 or 1 candidates;
     * 1 means "click here", 0 means "wait for more cells to render".
     */
    function findApexCandidates() {
        const targetCells = readTargetCells();
        if (targetCells.length === 0) return [];
        // Pick the target cell with the smallest Y as the apex anchor
        const targetApex = targetCells.reduce((a, b) => (a.y <= b.y ? a : b));

        const boardCells = readBoardCells();
        const boardByPos = new Map();
        for (const c of boardCells) boardByPos.set(`${c.x},${c.y},${c.mirror}`, c);

        const out = [];
        for (const apex of boardCells) {
            if (apex.mirror) continue;     // apex must be an up-pointing cell
            let allMatch = true;
            let allLit = true;
            for (const t of targetCells) {
                const key = `${apex.x + (t.x - targetApex.x)},${apex.y + (t.y - targetApex.y)},${t.mirror}`;
                const found = boardByPos.get(key);
                if (!found || found.sig !== t.sig) { allMatch = false; break; }
                if (!found.lit) allLit = false;
            }
            if (allMatch) out.push({ x: apex.x, y: apex.y, allLit, group: apex.group });
        }
        return out;
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
     * Best-effort click on the apex cell. We try four escalating tactics:
     *   1. Native .click() on the bounding triangle (cheapest)
     *   2. PointerEvent + MouseEvent down/up/click sequence
     *   3. Native .click() on each ancestor up to the wrapper g
     *   4. Locate the React onClick prop via __reactProps$<key> and call it
     *      with a synthetic event
     *
     * NONE of these worked against the May 2026 build — the puzzle
     * apparently checks event.isTrusted or routes input through some
     * channel our dispatched events don't reach. Logging the apex
     * coordinates is currently the most useful output of this function;
     * the user can hand-click the apex while we figure out the trigger.
     */
    async function attemptClick(glyphGroup, mod) {
        const tri = glyphGroup.querySelector(SEL.TRIANGLE);
        if (!tri) return false;
        const r = tri.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const evtBase = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0, buttons: 1 };

        // 1. Native .click() on triangle and wrapper
        try { tri.click(); } catch (_) {}
        try { glyphGroup.click(); } catch (_) {}

        // 2. PointerEvent + MouseEvent dance
        try {
            tri.dispatchEvent(new PointerEvent('pointerdown', { ...evtBase, pointerType: 'mouse', pointerId: 1 }));
            tri.dispatchEvent(new PointerEvent('pointerup',   { ...evtBase, pointerType: 'mouse', pointerId: 1, buttons: 0 }));
        } catch (_) {}
        tri.dispatchEvent(new MouseEvent('mousedown', evtBase));
        tri.dispatchEvent(new MouseEvent('mouseup',   { ...evtBase, buttons: 0 }));
        tri.dispatchEvent(new MouseEvent('click',     { ...evtBase, buttons: 0 }));

        // 3. React fiber onClick (often bound to the wrapper g at depth ~2)
        let p = tri;
        for (let d = 0; d < 12 && p; d++) {
            const key = Object.keys(p).find((k) => k.startsWith('__reactProps$'));
            const props = key ? p[key] : null;
            if (props && typeof props.onClick === 'function') {
                try {
                    props.onClick({
                        type: 'click', currentTarget: p, target: tri,
                        preventDefault: () => {}, stopPropagation: () => {},
                        isDefaultPrevented: () => false, isPropagationStopped: () => false,
                        nativeEvent: new MouseEvent('click', evtBase),
                        clientX: cx, clientY: cy, button: 0, buttons: 0,
                    });
                } catch (e) { mod.debug(`fiber onClick threw at depth ${d}: ${e.message}`); }
                break;
            }
            p = p.parentElement;
        }

        return true;
    }

    // ─── Main loop ───────────────────────────────────────────────────────
    /**
     * Run rounds until the counter shows N/N or the window closes. Each
     * round: poll for the unique apex match, attempt-click, wait for the
     * counter to tick over (which signals the puzzle has accepted our
     * answer and rolled a new target).
     */
    async function solveOnce(mod) {
        const startTime = Date.now();
        let lastApexKey = null;

        while (!root.__iceWallAbort) {
            if (!document.querySelector(SEL.APP)) { mod.info('puzzle window closed'); return true; }
            const c = readCounter();
            if (c && c.current >= c.total) { mod.info(`solved: ${c.current}/${c.total}`); return true; }
            if (Date.now() - startTime > 180_000) { mod.warn('safety timeout (180s)'); return false; }

            const candidates = findApexCandidates();
            if (candidates.length === 0) {
                // Not enough cells revealed yet — wait and re-scan
                await dom.sleep(300);
                continue;
            }
            if (candidates.length > 1) {
                mod.debug(`ambiguous: ${candidates.length} candidates, waiting for more glyphs to reveal`);
                await dom.sleep(300);
                continue;
            }

            const apex = candidates[0];
            const apexKey = `${apex.x},${apex.y}`;
            // De-dupe — don't re-click the same apex within one round
            const counterCur = readCounter();
            if (apexKey === lastApexKey) {
                await dom.sleep(300);
                continue;
            }
            mod.info(`match: apex (${apex.x}, ${apex.y}) — counter ${counterCur?.current}/${counterCur?.total}, allLit=${apex.allLit}`);
            await attemptClick(apex.group, mod);
            lastApexKey = apexKey;

            // Wait up to 4s for the counter to tick over (= server accepted)
            const ticked = await dom.waitFor(() => {
                const cc = readCounter();
                return cc && counterCur && cc.current > counterCur.current ? cc : null;
            }, { timeout: 4000 });
            if (!ticked) {
                mod.warn(`counter did not advance after click — likely click dispatch was ignored (event.isTrusted check?)`);
                // Wait a bit so we don't spam re-clicks while the puzzle
                // potentially regenerates its target.
                await dom.sleep(2000);
                lastApexKey = null;
            } else {
                mod.info(`counter advanced: ${ticked.current}/${ticked.total}`);
                lastApexKey = null;
            }
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
