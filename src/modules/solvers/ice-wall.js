// src/modules/solvers/ice-wall.js
// Auto-solver for the SAI "Porter-lite r4" / ICE WALL Break minigame.
//
// Mechanic (verified live, May 2026):
//   • Board = 10-row triangle of 100 small triangles (cells point up or
//     down; 19-cell-wide bottom row, 1-cell apex). Cells use
//     `transform="translate(X, Y)"` with optional `scale(1, -1)` for
//     down-pointing — coords align to a (col*31.5, row*54) grid.
//   • Target preview = arbitrary shape of N cells. Each cell carries
//     its own glyph signature.
//   • Solve = find where on the board the same N cells appear at the
//     same relative grid positions and matching signatures. 3 rounds
//     per puzzle (counter 0/3 → 3/3).
//   • Click target = LOWEST cell (max row) of the matched shape, tie-
//     broken by closest-to-median col. For a 3-row sub-triangle this is
//     "bottom-row centre". Verified empirically for the legacy 9-cell
//     case and matches the centroid-closest-UP rule used by competing
//     solvers in the cases we tested.
//
// Algorithm (this rewrite, adapted from competitor solver):
//   1. Read target + board cells in grid coords (col, row, mirror).
//   2. For each board cell with matching mirror and not in `excludeSet`,
//      treat it as candidate-anchor and check whether each target cell's
//      signature appears at the corresponding grid offset.
//   3. Wait (MutationObserver, 80ms debounce) until either:
//        a) some candidate has full match → commit
//        b) exactly one candidate from positive matching → commit
//        c) elimination matcher narrows to a unique survivor → commit
//   4. Click the lowest cell of the matched shape. If the counter doesn't
//      advance within 4s, mark the anchor as bad in `excludeSet` and
//      retry — up to 20 attempts per round. This is the key robustness
//      win: even if the click rule is occasionally wrong, retry-by-
//      exclusion eventually lands on the correct anchor.
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
    const COL_PX = 31.5;
    const ROW_PX = 54;
    const COLOR_LIT = '#76C1D1';
    const MIN_LIT_PATHS = 4;     // a fully-rendered glyph has 4-9 cyan paths

    // ─── Geometry helpers ────────────────────────────────────────────────

    function glyphSignature(glyphGroup) {
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

    function parseGridPos(transformStr) {
        const t = transformStr || '';
        const m = t.match(/translate\(\s*([^,]+),\s*([^)]+)\)/);
        if (!m) return null;
        return {
            col: Math.round(parseFloat(m[1]) / COL_PX),
            row: Math.round(parseFloat(m[2]) / ROW_PX),
            mirror: /scale\(1\s*,\s*-1\)/.test(t),
        };
    }

    function readTargetCells() {
        const target = document.querySelector(SEL.TARGET);
        if (!target) return [];
        const cells = [];
        for (const g of target.querySelectorAll(':scope > g')) {
            const pos = parseGridPos(g.getAttribute('transform'));
            if (!pos) continue;
            cells.push({ ...pos, sig: glyphSignature(g) });
        }
        return cells;
    }

    function readBoardCells() {
        const wall = document.querySelector(SEL.WALL);
        if (!wall) return [];
        const cells = [];
        for (const g of wall.querySelectorAll(':scope > g > g')) {
            const pos = parseGridPos(g.children[0]?.getAttribute('transform'));
            if (!pos) continue;
            cells.push({
                ...pos,
                sig: glyphSignature(g),
                lit: isGlyphLit(g),
                group: g,
            });
        }
        return cells;
    }

    /**
     * Pick the cell within the target shape that the user should click.
     * Rule: lowest cell (max row), tie-broken by col closest to the
     * median col of the bottom row. For the legacy 3-row sub-triangle
     * this picks the bottom-centre cell.
     */
    function pickClickTarget(targetCells) {
        if (targetCells.length === 0) return null;
        const maxRow = Math.max(...targetCells.map((c) => c.row));
        const bottom = targetCells.filter((c) => c.row === maxRow);
        if (bottom.length === 1) return bottom[0];
        const meanCol = bottom.reduce((s, c) => s + c.col, 0) / bottom.length;
        return bottom.reduce((a, b) => (Math.abs(a.col - meanCol) <= Math.abs(b.col - meanCol) ? a : b));
    }

    function makeBoardMap(boardCells) {
        const map = new Map();
        for (const c of boardCells) map.set(`${c.col},${c.row},${c.mirror}`, c);
        return map;
    }

    // ─── Candidate matching ──────────────────────────────────────────────

    /**
     * Positive matcher — cells where the board's lit signature matches
     * the target. Returns { candidates, total } sorted by match count.
     * Anchors in `excludeKeys` are skipped (used by the retry loop).
     */
    function findShapeCandidates(excludeKeys) {
        const targetCells = readTargetCells();
        if (targetCells.length === 0) return { candidates: [], total: 0 };
        const targetAnchor = targetCells.reduce((a, b) => (a.row <= b.row ? a : b));
        const targetClick = pickClickTarget(targetCells);

        const boardCells = readBoardCells();
        const boardMap = makeBoardMap(boardCells);

        const out = [];
        for (const anchor of boardCells) {
            if (anchor.mirror !== targetAnchor.mirror) continue;
            const anchorKey = `${anchor.col},${anchor.row}`;
            if (excludeKeys && excludeKeys.has(anchorKey)) continue;

            let match = 0, mismatch = 0, unknown = 0;
            const cells = [];
            for (const t of targetCells) {
                const cc = anchor.col + (t.col - targetAnchor.col);
                const cr = anchor.row + (t.row - targetAnchor.row);
                const found = boardMap.get(`${cc},${cr},${t.mirror}`);
                cells.push({ col: cc, row: cr, mirror: t.mirror, isClick: t === targetClick });
                if (!found) { mismatch++; continue; }
                if (!found.lit) { unknown++; continue; }
                if (found.sig === t.sig) match++;
                else mismatch++;
            }
            if (mismatch > 0) continue;
            if (match === 0) continue;

            const clickCol = anchor.col + (targetClick.col - targetAnchor.col);
            const clickRow = anchor.row + (targetClick.row - targetAnchor.row);
            const clickCell = boardMap.get(`${clickCol},${clickRow},${targetClick.mirror}`);
            out.push({
                col: anchor.col, row: anchor.row,
                cells,
                clickGroup: clickCell ? clickCell.group : anchor.group,
                clickCol, clickRow, clickMirror: targetClick.mirror,
                match, unknown, mismatch,
                total: targetCells.length,
            });
        }
        out.sort((a, b) => b.match - a.match);
        return { candidates: out, total: targetCells.length };
    }

    /**
     * Elimination matcher — returns candidates with NO mismatches and
     * all neighbours present, regardless of match count. When positive
     * matching gives 0 candidates, this can still uniquely identify the
     * answer if partial reveals already eliminated everything else.
     */
    function findByElimination(excludeKeys) {
        const targetCells = readTargetCells();
        if (targetCells.length === 0) return [];
        const targetAnchor = targetCells.reduce((a, b) => (a.row <= b.row ? a : b));
        const targetClick = pickClickTarget(targetCells);

        const boardCells = readBoardCells();
        const boardMap = makeBoardMap(boardCells);

        const out = [];
        for (const anchor of boardCells) {
            if (anchor.mirror !== targetAnchor.mirror) continue;
            const anchorKey = `${anchor.col},${anchor.row}`;
            if (excludeKeys && excludeKeys.has(anchorKey)) continue;

            let eliminated = false;
            const cells = [];
            for (const t of targetCells) {
                const cc = anchor.col + (t.col - targetAnchor.col);
                const cr = anchor.row + (t.row - targetAnchor.row);
                const found = boardMap.get(`${cc},${cr},${t.mirror}`);
                cells.push({ col: cc, row: cr, mirror: t.mirror, isClick: t === targetClick });
                if (!found) { eliminated = true; break; }
                if (found.lit && found.sig !== t.sig) { eliminated = true; break; }
            }
            if (eliminated) continue;

            const clickCol = anchor.col + (targetClick.col - targetAnchor.col);
            const clickRow = anchor.row + (targetClick.row - targetAnchor.row);
            const clickCell = boardMap.get(`${clickCol},${clickRow},${targetClick.mirror}`);
            out.push({
                col: anchor.col, row: anchor.row,
                cells,
                clickGroup: clickCell ? clickCell.group : anchor.group,
                clickCol, clickRow, clickMirror: targetClick.mirror,
                match: 0, unknown: 0, mismatch: 0,
                total: targetCells.length,
            });
        }
        return out;
    }

    // ─── Overlay ─────────────────────────────────────────────────────────

    const OVERLAY_ID = 'cor3-icewall-overlay';
    const TRI_PATH = 'M60.6914 53.0305 H1.73242 L31.21 1.99927 Z';

    function clearOverlay() {
        const wall = document.querySelector(SEL.WALL);
        if (!wall) return;
        const old = wall.querySelector('#' + OVERLAY_ID);
        if (old) old.remove();
    }

    /**
     * Outline each cell of the matched shape; brighten the click target.
     * tentative = dim yellow / dashed; confident = solid orange.
     */
    function drawOverlay(candidate, confident) {
        const wall = document.querySelector(SEL.WALL);
        if (!wall) return;
        clearOverlay();
        const renderG = wall.querySelector(':scope > g') || wall;
        const ns = 'http://www.w3.org/2000/svg';
        const overlay = document.createElementNS(ns, 'g');
        overlay.setAttribute('id', OVERLAY_ID);
        overlay.setAttribute('pointer-events', 'none');

        const color = confident ? '#FFB857' : '#FFE066';
        const cellFill = confident ? '0.10' : '0.05';
        const clickFill = confident ? '0.45' : '0.20';
        const dash = confident ? null : '6,4';

        for (const c of candidate.cells) {
            const px = c.col * COL_PX;
            const py = c.row * ROW_PX;
            const path = document.createElementNS(ns, 'path');
            const transform = c.mirror
                ? `translate(${px}, ${py}) scale(1, -1)`
                : `translate(${px}, ${py})`;
            path.setAttribute('transform', transform);
            path.setAttribute('d', TRI_PATH);
            path.setAttribute('fill', color);
            path.setAttribute('fill-opacity', c.isClick ? clickFill : cellFill);
            path.setAttribute('stroke', c.isClick ? '#FFFFFF' : color);
            path.setAttribute('stroke-width', c.isClick ? '2' : '3');
            path.setAttribute('stroke-linejoin', 'round');
            if (dash) path.setAttribute('stroke-dasharray', dash);
            overlay.appendChild(path);
        }

        renderG.appendChild(overlay);
    }

    // ─── State probes + click ────────────────────────────────────────────

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

    /**
     * Single `click` dispatch with proper coords. The legacy
     * mousedown/mouseup/click triplet was unnecessary — competitors
     * dispatch just one click. Using one event also eliminates any
     * chance of double-trigger.
     */
    async function attemptClick(glyphGroup) {
        const tri = glyphGroup.querySelector(SEL.TRIANGLE);
        if (!tri) return false;
        const r = tri.getBoundingClientRect();
        tri.dispatchEvent(new MouseEvent('click', {
            bubbles: true, cancelable: true, view: window,
            clientX: r.left + r.width / 2,
            clientY: r.top + r.height / 2,
            button: 0,
        }));
        return true;
    }

    // ─── Reactive matching loop ──────────────────────────────────────────

    /**
     * Watch the board (MutationObserver, 80ms debounce) until we have a
     * confident candidate. Resolves with `{best, reason}` on success,
     * `{timedOut: true}` on timeout, or `null` on app close.
     *
     * Confidence rules (in order):
     *   • some candidate has full match (best.match === total) → commit
     *   • exactly one candidate from positive matching → commit
     *   • positive: 0 candidates BUT elimination narrows to 1 → commit
     *   • otherwise wait
     */
    function waitForCandidate(excludeKeys, timeoutMs, onTentative) {
        return new Promise((resolve) => {
            let done = false;
            let observer = null;
            let debounceTimer = null;
            let hardTimer = null;

            const finish = (val) => {
                if (done) return;
                done = true;
                if (observer) observer.disconnect();
                clearTimeout(debounceTimer);
                clearTimeout(hardTimer);
                resolve(val);
            };

            const check = () => {
                if (done) return;
                const wall = document.querySelector(SEL.WALL);
                if (!wall) return finish(null);

                const { candidates, total } = findShapeCandidates(excludeKeys);

                const complete = candidates.find((c) => c.match === total);
                if (complete) return finish({ best: complete, reason: 'complete' });

                if (candidates.length === 1) return finish({ best: candidates[0], reason: 'unique' });

                if (candidates.length === 0) {
                    const elim = findByElimination(excludeKeys);
                    if (elim.length === 1) return finish({ best: elim[0], reason: 'elimination' });
                }

                if (onTentative && candidates.length > 0) onTentative(candidates[0]);
            };

            const scheduleCheck = () => {
                if (done) return;
                clearTimeout(debounceTimer);
                debounceTimer = setTimeout(check, 80);
            };

            const wall = document.querySelector(SEL.WALL);
            if (!wall) return finish(null);

            observer = new MutationObserver(scheduleCheck);
            observer.observe(wall, { subtree: true, childList: true, attributes: true });

            hardTimer = setTimeout(() => finish({ timedOut: true }), timeoutMs);
            scheduleCheck();
        });
    }

    // ─── Round + main loop ───────────────────────────────────────────────

    const MAX_RETRIES = 20;
    const ROUND_MAX_MS = 240_000;

    /**
     * Solve one round: keep clicking until the counter advances or we
     * exhaust retries. Each click that fails to advance the counter
     * excludes that anchor from future matching, forcing the matcher to
     * find a different candidate next time.
     *
     * Returns true if the counter advanced (round complete), false on
     * retry exhaustion / timeout / app close / abort.
     */
    async function solveRound(mod) {
        const excludeKeys = new Set();
        const roundStart = Date.now();

        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            if (root.__iceWallAbort) return false;
            if (!document.querySelector(SEL.APP)) return false;
            const counter = readCounter();
            if (counter && counter.current >= counter.total) return true;

            const remaining = Math.max(2000, ROUND_MAX_MS - (Date.now() - roundStart));
            const result = await waitForCandidate(
                excludeKeys, remaining,
                (tentative) => drawOverlay(tentative, false),
            );

            if (root.__iceWallAbort) return false;
            if (result === null) return false;     // app closed mid-watch

            let best = result.best;
            let reason = result.reason;
            if (result.timedOut) {
                const { candidates } = findShapeCandidates(excludeKeys);
                if (candidates.length > 0) {
                    best = candidates[0];
                    reason = 'timeout-best';
                } else {
                    const elim = findByElimination(excludeKeys);
                    if (elim.length > 0) {
                        best = elim[0];
                        reason = 'timeout-elim';
                    } else {
                        mod.warn(`round timeout, no candidate (${excludeKeys.size} excluded)`);
                        clearOverlay();
                        return false;
                    }
                }
            }

            const counterCur = readCounter();
            mod.info(`commit (${reason}): anchor=(${best.col},${best.row}) click=(${best.clickCol},${best.clickRow}) match=${best.match ?? 0}/${best.total} attempt=${attempt + 1}/${MAX_RETRIES}`);
            drawOverlay(best, true);
            await attemptClick(best.clickGroup);

            const ticked = await dom.waitFor(() => {
                const cc = readCounter();
                return cc && counterCur && cc.current > counterCur.current ? cc : null;
            }, { timeout: 4000 });

            if (ticked) {
                mod.info(`counter advanced: ${ticked.current}/${ticked.total}`);
                clearOverlay();
                return true;
            }

            mod.warn(`false positive at anchor (${best.col},${best.row}) — excluding & retrying (${attempt + 1}/${MAX_RETRIES})`);
            excludeKeys.add(`${best.col},${best.row}`);
        }
        mod.warn(`exhausted ${MAX_RETRIES} retries on this round`);
        clearOverlay();
        return false;
    }

    async function watchLoop(mod) {
        while (!root.__iceWallAbort) {
            await dom.sleep(300);
            const app = document.querySelector(SEL.APP);
            if (!app) continue;

            const ready = await dom.waitFor(
                () => document.querySelector(SEL.WALL) && document.querySelector(SEL.TARGET),
                { timeout: 8000 }
            );
            if (!ready) { mod.debug('stage never became ready'); continue; }

            const start = readCounter();
            const timer = readTimerSeconds();
            mod.info(`ice-wall puzzle detected (counter ${start?.current ?? '?'}/${start?.total ?? '?'}, ${timer ?? '?'}s left)`);

            // Solve all rounds within this puzzle
            while (!root.__iceWallAbort && document.querySelector(SEL.APP)) {
                const c = readCounter();
                if (c && c.current >= c.total) {
                    mod.info(`puzzle solved: ${c.current}/${c.total}`);
                    break;
                }
                const ok = await solveRound(mod);
                if (!ok) await dom.sleep(1500);     // brief pause before retry
            }

            // Wait for the puzzle window to close before resuming watch
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
