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
     * Partial matcher — counts evidence per candidate apex without
     * requiring every cell to be lit. Dark (un-revealed) cells have a
     * different signature than lit ones (just an outline vs the full
     * glyph), so the old "all 9 must match" approach only converged once
     * every cell was rendered. The puzzle reveals cells gradually over
     * the 3-minute timer, and we have to commit BEFORE everything's lit
     * — there are 3 rounds and they share that one timer.
     *
     * For each candidate apex, walk the 9 target offsets and classify
     * each board cell as:
     *   • match     — lit AND same signature as target → strong evidence
     *   • mismatch  — lit AND different signature → contradicts; eliminates
     *   • unknown   — dark (not revealed yet) → no evidence either way
     *
     * Each candidate also carries a `clickTarget`: the actual cell to
     * dispatch the click on. Empirically this is NOT the apex of the
     * sub-triangle — it's the centre cell of the BOTTOM row (offset
     * +108 in Y, 0 in X from the apex). User confirmed: clicking the
     * apex is a no-op, clicking bottom-centre advances the counter.
     *
     * Returns feasible candidates (mismatch === 0) sorted by match count
     * descending. Caller decides confidence threshold.
     */
    function findApexCandidates() {
        const targetCells = readTargetCells();
        if (targetCells.length === 0) return [];
        const targetApex = targetCells.reduce((a, b) => (a.y <= b.y ? a : b));

        const boardCells = readBoardCells();
        const boardByPos = new Map();
        for (const c of boardCells) boardByPos.set(`${c.x},${c.y},${c.mirror}`, c);

        const out = [];
        for (const apex of boardCells) {
            if (apex.mirror) continue;     // apex must be up-pointing
            let match = 0, mismatch = 0, unknown = 0;
            for (const t of targetCells) {
                const key = `${apex.x + (t.x - targetApex.x)},${apex.y + (t.y - targetApex.y)},${t.mirror}`;
                const found = boardByPos.get(key);
                if (!found) { mismatch++; continue; } // out-of-bounds = elim
                if (!found.lit) { unknown++; continue; }
                if (found.sig === t.sig) match++;
                else mismatch++;
            }
            if (mismatch > 0) continue;
            // Pure unknowns (no evidence at all) aren't useful
            if (match === 0) continue;
            // Click target = bottom-row centre cell (apex_x, apex_y + 108)
            const clickKey = `${apex.x},${apex.y + 108},false`;
            const clickCell = boardByPos.get(clickKey);
            out.push({
                x: apex.x, y: apex.y, group: apex.group,
                clickGroup: clickCell ? clickCell.group : apex.group,
                clickX: apex.x, clickY: apex.y + 108,
                match, unknown, mismatch,
            });
        }
        out.sort((a, b) => b.match - a.match);
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

    // ─── Overlay: highlight the matched apex + sub-triangle ──────────────
    // The puzzle isn't accepting our synthetic clicks (yet), so the most
    // useful thing the solver can do is SHOW WHERE TO CLICK. We append an
    // SVG overlay <g> inside the WallBoard's render group so it inherits
    // the same coordinate space as the glyphs themselves.
    //
    // Each glyph's bounding triangle path is roughly a 60×54 isoceles
    // triangle with vertices at (~1.7, 53), (~60.7, 53), (~31.2, 2)
    // (relative to its translate origin). For a 3-row sub-triangle
    // (apex + row 1 [Y+54] + row 2 [Y+108]), the bottom-left cell is at
    // (apex.x - 63, apex.y + 108) and the bottom-right is at
    // (apex.x + 63, apex.y + 108).
    const OVERLAY_ID = 'cor3-icewall-overlay';
    const APEX_TRI_W = 60.7, APEX_TRI_H = 51, APEX_TRI_TOP_X = 31.2, APEX_TRI_TOP_Y = 2;

    function clearOverlay() {
        const wall = document.querySelector(SEL.WALL);
        if (!wall) return;
        const old = wall.querySelector('#' + OVERLAY_ID);
        if (old) old.remove();
    }

    /**
     * Draw the predicted sub-triangle plus a brighter highlight on the
     * actual click target (bottom-row centre cell, not the apex).
     * Two visual modes:
     *   • tentative — dim yellow outline, dashed
     *   • confident — solid orange, filled click cell
     */
    function drawOverlay(apex, confident) {
        const wall = document.querySelector(SEL.WALL);
        if (!wall) return;
        clearOverlay();
        const renderG = wall.querySelector(':scope > g') || wall;
        const ns = 'http://www.w3.org/2000/svg';
        const overlay = document.createElementNS(ns, 'g');
        overlay.setAttribute('id', OVERLAY_ID);
        overlay.setAttribute('pointer-events', 'none');

        const topX = apex.x + APEX_TRI_TOP_X;
        const topY = apex.y + APEX_TRI_TOP_Y;
        const blX  = apex.x - 63 + 1.7;
        const blY  = apex.y + 108 + 53;
        const brX  = apex.x + 63 + APEX_TRI_W;
        const brY  = blY;

        const color = confident ? '#FFB857' : '#FFE066';
        const fillOp = confident ? '0.10' : '0.05';
        const dash = confident ? null : '6,4';

        const bigPath = document.createElementNS(ns, 'path');
        bigPath.setAttribute('d', `M ${topX} ${topY} L ${blX} ${blY} L ${brX} ${brY} Z`);
        bigPath.setAttribute('fill', color);
        bigPath.setAttribute('fill-opacity', fillOp);
        bigPath.setAttribute('stroke', color);
        bigPath.setAttribute('stroke-width', '3');
        bigPath.setAttribute('stroke-linejoin', 'round');
        if (dash) bigPath.setAttribute('stroke-dasharray', dash);
        overlay.appendChild(bigPath);

        // Highlight the CLICK target (bottom-row centre cell), not the apex.
        // The puzzle accepts the click on this cell; the apex highlight in
        // the previous version was misleading — empirically clicks there
        // are no-ops.
        const clickX = apex.clickX !== undefined ? apex.clickX : apex.x;
        const clickY = apex.clickY !== undefined ? apex.clickY : apex.y + 108;
        const clickPath = document.createElementNS(ns, 'path');
        clickPath.setAttribute('transform', `translate(${clickX}, ${clickY})`);
        clickPath.setAttribute('d', 'M60.6914 53.0305 H1.73242 L31.21 1.99927 Z');
        clickPath.setAttribute('fill', color);
        clickPath.setAttribute('fill-opacity', confident ? '0.45' : '0.20');
        clickPath.setAttribute('stroke', '#FFFFFF');
        clickPath.setAttribute('stroke-width', '2');
        if (dash) clickPath.setAttribute('stroke-dasharray', dash);
        overlay.appendChild(clickPath);

        renderG.appendChild(overlay);
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
    // A candidate is "confident" once it has the unique highest match
    // count among feasible candidates AND has at least this many cells
    // matched. With 5 unique signatures across 9 target slots, ~3-4
    // matches with 0 mismatches and a clear lead almost always pin the
    // unique answer; waiting for higher confidence costs us seconds we
    // need for rounds 2 and 3.
    const MIN_CONFIDENT_MATCH = 3;
    const MIN_LEAD = 1;     // best.match - second_best.match must be >=

    async function solveOnce(mod) {
        const startTime = Date.now();
        let lastDrawnApexKey = null;
        let lastClickedApexKey = null;

        while (!root.__iceWallAbort) {
            if (!document.querySelector(SEL.APP)) { mod.info('puzzle window closed'); return true; }
            const c = readCounter();
            if (c && c.current >= c.total) { mod.info(`solved: ${c.current}/${c.total}`); clearOverlay(); return true; }
            if (Date.now() - startTime > 180_000) { mod.warn('safety timeout (180s)'); clearOverlay(); return false; }

            const candidates = findApexCandidates();
            if (candidates.length === 0) { await dom.sleep(250); continue; }

            const best = candidates[0];
            const second = candidates[1] || null;
            const lead = best.match - (second ? second.match : 0);
            const confident = best.match >= MIN_CONFIDENT_MATCH && lead >= MIN_LEAD;
            const apexKey = `${best.x},${best.y}`;

            // Always keep the overlay reflecting the current best guess.
            // While not-yet-confident, draw it tentatively (yellow); when
            // confident, switch to the strong orange.
            if (apexKey !== lastDrawnApexKey || /* tentativeness changed */ true) {
                drawOverlay(best, confident);
                if (apexKey !== lastDrawnApexKey) {
                    mod.info(`apex hint (${best.x}, ${best.y}) — match=${best.match} unknown=${best.unknown} lead=${lead} confident=${confident}`);
                    lastDrawnApexKey = apexKey;
                }
            }

            if (!confident) { await dom.sleep(250); continue; }

            if (apexKey === lastClickedApexKey) { await dom.sleep(300); continue; }

            const counterCur = readCounter();
            mod.info(`commit: apex (${best.x}, ${best.y}) → click bottom-centre (${best.clickX}, ${best.clickY}) — match ${best.match}/9, unknown ${best.unknown}, counter ${counterCur?.current}/${counterCur?.total}`);
            await attemptClick(best.clickGroup, mod);
            lastClickedApexKey = apexKey;

            const ticked = await dom.waitFor(() => {
                const cc = readCounter();
                return cc && counterCur && cc.current > counterCur.current ? cc : null;
            }, { timeout: 4000 });
            if (!ticked) {
                mod.warn(`counter did not advance after click — likely click dispatch was ignored. Hand-click the highlighted apex.`);
                await dom.sleep(3000);
                lastClickedApexKey = null;
            } else {
                mod.info(`counter advanced: ${ticked.current}/${ticked.total}`);
                lastClickedApexKey = null;
                lastDrawnApexKey = null;
                clearOverlay();
            }
        }
        clearOverlay();
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
            clearOverlay();
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
