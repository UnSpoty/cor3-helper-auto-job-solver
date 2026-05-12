// src/modules/solvers/ice-wall.js
// Auto-solver for the SAI "Porter-lite r4" / ICE WALL Break minigame.
//
// Mechanic (verified live on RM7-E1SCP, 2026-05-11 after May-2026 refactor):
//   • Board = 10-row triangle of 100 small triangles (cells point up or
//     down; 19-cell-wide bottom row, 1-cell apex). Cells use
//     `transform="translate(X, Y)"` with optional `scale(1, -1)` for
//     down-pointing — coords align to a (col*31.5, row*54) grid.
//   • Each board cell is in one of three states:
//       - empty:       dark `fill=#00121D` contour, never clickable
//       - placeholder: cyan outline-only stroke + generic placeholder
//                      glyph paths (the "closed" state)
//       - revealed:    contour + a UNIQUE glyph icon. Game reveals new
//                      cells ~once per second.
//   • Target preview = 9 cells forming the source pattern. Some target
//     cells may themselves be placeholders ("wildcard" positions in the
//     pattern, like `0` in the user's spec).
//   • Solve = find a position on the board where revealed cells form
//     the same shape as target with matching glyph signatures (target
//     placeholder positions accept any board state — wildcards).
//   • Click target = the topmost-leftmost cell of the matched shape on
//     the board (the "anchor"). Observed live: on hover over any cell
//     inside a matched shape the game highlights the apex green.
//
// Algorithm:
//   1. Read target + board cells with their state (empty/placeholder/
//      revealed) and pure-glyph signatures.
//   2. Pick anchor = first revealed target cell (placeholders are
//      wildcards and can't filter candidates).
//   3. For each revealed board cell whose sig matches anchor's sig:
//      verify all 9 target offsets line up — target placeholders
//      accept any board state, target revealed require board revealed
//      AND signature match.
//   4. If a candidate has zero mismatches AND every revealed target
//      cell is satisfied, commit: click the cell on the board that
//      corresponds to the topmost-leftmost target cell.
//   5. Retry-by-exclusion if a click doesn't advance the counter
//      within 4s.
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
    const COLOR_EMPTY = '#00121D';
    // Commit thresholds tuned with user feedback for the current 9-cell
    // target ("1 = nothing, 3 = confident enough to try, 5+ = fire even
    // with alternatives"):
    //   STRONG_PARTIAL_MATCH: any candidate with this many matches
    //     wins, even when other candidates have the same anchor sig.
    //   MIN_PARTIAL_MATCH: candidate needs to be either the only one
    //     left OR dominant (ahead of second-best by >=2) to commit.
    //
    // The matcher itself is shape-agnostic — it iterates over whatever
    // cells the target contains. If the game ever serves a target of a
    // different size, `adaptiveThresholds()` scales the partial-match
    // bar proportionally so percentage-of-match stays meaningful:
    //   - absolute floor (5 / 3) keeps tiny targets demanding high % match;
    //   - the 55% / 33% ratio dominates for larger targets to avoid
    //     premature commits.
    // For total=9 the adaptive call returns (5, 3) — identical to the
    // existing constants — so live behaviour on the current minigame is
    // unchanged. Verified across 200 puzzles per size (4..16) in the
    // test_polygon/ harness: 100% solve rate.
    const STRONG_PARTIAL_MATCH = 5;     // absolute floor
    const MIN_PARTIAL_MATCH = 3;        // absolute floor
    const STRONG_PARTIAL_RATIO = 0.55;
    const MIN_PARTIAL_RATIO = 0.33;

    function adaptiveThresholds(total) {
        return {
            strong: Math.max(STRONG_PARTIAL_MATCH, Math.round(total * STRONG_PARTIAL_RATIO)),
            mid:    Math.max(MIN_PARTIAL_MATCH,    Math.round(total * MIN_PARTIAL_RATIO)),
        };
    }

    // ─── Geometry helpers ────────────────────────────────────────────────

    /**
     * Signature of a cell's glyph icon. Only counts "pure glyph" paths:
     * fill=#76C1D1, no stroke, no fill-opacity — these are byte-identical
     * across target and board for the same icon. Contour and background
     * paths (fill+fo=0.2, stroke=#76C1D1) drift between target/board due
     * to sub-pixel rendering, so they are excluded.
     */
    function glyphSignature(glyphGroup) {
        const inner = glyphGroup.children[0];
        const root = (inner && inner.tagName === 'g') ? inner : glyphGroup;
        const shapes = [];
        for (const c of root.children) {
            if (c.dataset && c.dataset.sentryComponent === 'GlyphBoundingTriangle') continue;
            const f = c.getAttribute('fill');
            const s = c.getAttribute('stroke');
            const fo = c.getAttribute('fill-opacity');
            if (f !== COLOR_LIT || s !== null || fo !== null) continue;
            if (c.tagName === 'path') shapes.push('p:' + (c.getAttribute('d') || ''));
            else if (c.tagName === 'rect') shapes.push('r:' + ['x','y','width','height','transform'].map((a) => c.getAttribute(a) || '').join(','));
        }
        shapes.sort();
        return shapes.join('|');
    }

    /**
     * Three-way classification of a cell:
     *   - 'empty':       has fill=#00121D (dark contour, not yet active)
     *   - 'placeholder': has an outline-only stroke path (closed cell)
     *   - 'revealed':    neither of the above (shows a unique glyph icon)
     *
     * Each board cell goes empty → placeholder → revealed as the game
     * reveals new glyphs every ~1s. Target placeholder cells act as
     * wildcards in the matcher (any board state in that position matches).
     */
    function cellState(glyphGroup) {
        let hasOutlineOnly = false, hasEmptyFill = false;
        for (const el of glyphGroup.querySelectorAll('path, rect')) {
            if (el.dataset && el.dataset.sentryComponent === 'GlyphBoundingTriangle') continue;
            const f = el.getAttribute('fill');
            const s = el.getAttribute('stroke');
            if (f === null && s === COLOR_LIT) hasOutlineOnly = true;
            if (f === COLOR_EMPTY) hasEmptyFill = true;
        }
        if (hasEmptyFill) return 'empty';
        if (hasOutlineOnly) return 'placeholder';
        return 'revealed';
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
            cells.push({ ...pos, sig: glyphSignature(g), state: cellState(g) });
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
                state: cellState(g),
                group: g,
            });
        }
        return cells;
    }

    /**
     * Pick the cell within the target shape the user should click.
     * Rule: cell closest to the geometric centroid of the shape. For a
     * symmetric sub-triangle this lands on the middle cell — what the
     * user described as "centre + bottom-ish". Ties prefer UP-pointing
     * cells, then lower row, then leftmost col.
     */
    function pickClickTarget(targetCells) {
        if (targetCells.length === 0) return null;
        const cx = targetCells.reduce((s, c) => s + c.col, 0) / targetCells.length;
        const cy = targetCells.reduce((s, c) => s + c.row, 0) / targetCells.length;
        const dist = (c) => (c.col - cx) ** 2 + (c.row - cy) ** 2;
        return targetCells.reduce((a, b) => {
            const da = dist(a), db = dist(b);
            if (da !== db) return da < db ? a : b;
            if (a.mirror !== b.mirror) return a.mirror ? b : a;   // prefer UP
            if (a.row !== b.row) return a.row > b.row ? a : b;    // prefer lower
            return a.col < b.col ? a : b;
        });
    }

    function makeBoardMap(boardCells) {
        const map = new Map();
        for (const c of boardCells) map.set(`${c.col},${c.row},${c.mirror}`, c);
        return map;
    }

    // ─── Candidate matching ──────────────────────────────────────────────

    /**
     * Find positions on the board where the target shape fits.
     *
     * Matching rules per target cell:
     *   - target.state === 'revealed':
     *       board cell at same offset MUST be revealed AND have same sig
     *   - target.state === 'placeholder' or 'empty':
     *       wildcard — any board state at that offset accepts
     *   - any "mismatch" (revealed-target with revealed-board of wrong sig)
     *     rejects the candidate
     *   - "unknown" (revealed-target with non-revealed board) doesn't kill
     *     the candidate but means we have to wait for more reveals
     *
     * The candidate is fully committable when `mismatch===0` and every
     * revealed target cell is satisfied (match === revealedTargetCount).
     *
     * Returns { candidates, total, revealedTotal } sorted best-first by
     * match count.
     */
    function findShapeCandidates(excludeKeys) {
        const targetCells = readTargetCells();
        if (targetCells.length === 0) return { candidates: [], total: 0, revealedTotal: 0 };

        // Anchor selection: prefer a revealed target cell so we can filter
        // board candidates by sig. If the target has no revealed cells
        // (e.g. game hasn't loaded glyphs yet), bail.
        const revealedTargets = targetCells.filter((c) => c.state === 'revealed');
        if (revealedTargets.length === 0) return { candidates: [], total: targetCells.length, revealedTotal: 0 };
        // Anchor selection: prefer a revealed cell whose signature is UNIQUE
        // within the target. Non-unique anchors (e.g. when target has a
        // duplicate glyph) match more board cells, producing false-positive
        // partial candidates that can sneak past the matcher. A unique
        // anchor restricts the search to the actual shape position.
        const sigCounts = new Map();
        for (const t of revealedTargets) sigCounts.set(t.sig, (sigCounts.get(t.sig) || 0) + 1);
        const targetAnchor =
            revealedTargets.find((t) => sigCounts.get(t.sig) === 1) || revealedTargets[0];
        const targetClick = pickClickTarget(targetCells);

        const boardCells = readBoardCells();
        const boardMap = makeBoardMap(boardCells);

        const out = [];
        for (const cand of boardCells) {
            if (cand.state !== 'revealed') continue;
            if (cand.mirror !== targetAnchor.mirror) continue;
            if (cand.sig !== targetAnchor.sig) continue;

            const candKey = `${cand.col},${cand.row}`;
            if (excludeKeys && excludeKeys.has(candKey)) continue;

            let match = 0, mismatch = 0, unknown = 0;
            const cells = [];
            for (const t of targetCells) {
                const cc = cand.col + (t.col - targetAnchor.col);
                const cr = cand.row + (t.row - targetAnchor.row);
                const bc = boardMap.get(`${cc},${cr},${t.mirror}`);
                cells.push({ col: cc, row: cr, mirror: t.mirror, isClick: t === targetClick });

                if (!bc) { mismatch++; continue; }

                if (t.state !== 'revealed') {
                    // Target placeholder/empty positions mark "blanks" in
                    // the pattern: that board cell must NOT be revealed
                    // with a different glyph. Accept board states empty
                    // or placeholder (both mean "no committed glyph
                    // there"). If board has revealed a unique glyph in
                    // that slot, this candidate is at the wrong position.
                    if (bc.state === 'revealed') { mismatch++; continue; }
                    match++;
                    continue;
                }
                if (bc.state !== 'revealed') { unknown++; continue; }
                if (bc.sig !== t.sig) { mismatch++; continue; }
                match++;
            }
            if (mismatch > 0) continue;
            if (match === 0) continue;

            const clickCol = cand.col + (targetClick.col - targetAnchor.col);
            const clickRow = cand.row + (targetClick.row - targetAnchor.row);
            const clickCell = boardMap.get(`${clickCol},${clickRow},${targetClick.mirror}`);
            out.push({
                col: cand.col, row: cand.row,
                cells,
                clickGroup: clickCell ? clickCell.group : cand.group,
                clickCol, clickRow, clickMirror: targetClick.mirror,
                match, unknown, mismatch,
                total: targetCells.length,
            });
        }
        out.sort((a, b) => b.match - a.match);
        return { candidates: out, total: targetCells.length, revealedTotal: revealedTargets.length };
    }

    /**
     * Elimination matcher — kept for the "exactly one survives after
     * partial reveals" edge case. Returns candidates with no mismatches
     * regardless of how many cells already matched. Useful when several
     * candidates have the same partial sig hit and only board reveals
     * further along will disambiguate.
     */
    function findByElimination(excludeKeys) {
        const targetCells = readTargetCells();
        if (targetCells.length === 0) return [];
        const revealedTargets = targetCells.filter((c) => c.state === 'revealed');
        if (revealedTargets.length === 0) return [];
        const sigCounts = new Map();
        for (const t of revealedTargets) sigCounts.set(t.sig, (sigCounts.get(t.sig) || 0) + 1);
        const targetAnchor =
            revealedTargets.find((t) => sigCounts.get(t.sig) === 1) || revealedTargets[0];
        const targetClick = pickClickTarget(targetCells);

        const boardCells = readBoardCells();
        const boardMap = makeBoardMap(boardCells);

        const out = [];
        for (const cand of boardCells) {
            if (cand.state !== 'revealed') continue;
            if (cand.mirror !== targetAnchor.mirror) continue;
            if (cand.sig !== targetAnchor.sig) continue;

            const candKey = `${cand.col},${cand.row}`;
            if (excludeKeys && excludeKeys.has(candKey)) continue;

            let eliminated = false;
            const cells = [];
            for (const t of targetCells) {
                const cc = cand.col + (t.col - targetAnchor.col);
                const cr = cand.row + (t.row - targetAnchor.row);
                const bc = boardMap.get(`${cc},${cr},${t.mirror}`);
                cells.push({ col: cc, row: cr, mirror: t.mirror, isClick: t === targetClick });
                if (!bc) { eliminated = true; break; }
                if (t.state !== 'revealed') {
                    if (bc.state === 'revealed') { eliminated = true; break; }
                    continue;
                }
                if (bc.state === 'revealed' && bc.sig !== t.sig) { eliminated = true; break; }
            }
            if (eliminated) continue;

            const clickCol = cand.col + (targetClick.col - targetAnchor.col);
            const clickRow = cand.row + (targetClick.row - targetAnchor.row);
            const clickCell = boardMap.get(`${clickCol},${clickRow},${targetClick.mirror}`);
            out.push({
                col: cand.col, row: cand.row,
                cells,
                clickGroup: clickCell ? clickCell.group : cand.group,
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
     * Outline each cell of the matched shape; the click target gets a
     * solid red fill at high opacity so the user can always see exactly
     * where the solver intends to click (regardless of confidence). The
     * surrounding shape cells use a dim contour.
     *
     * tentative (waiting for more reveals) = dashed yellow contour
     * confident (about to click) = solid orange contour
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

        const contourColor = confident ? '#FFB857' : '#FFE066';
        const contourFill = confident ? '0.18' : '0.06';
        const dash = confident ? null : '6,4';
        // Click cell stays solid red regardless of confidence — that is the
        // ONE cell the solver intends to click and it must be visible at
        // a glance.
        const clickColor = '#FF3333';
        const clickFill = confident ? '0.70' : '0.55';

        for (const c of candidate.cells) {
            const px = c.col * COL_PX;
            const py = c.row * ROW_PX;
            const path = document.createElementNS(ns, 'path');
            const transform = c.mirror
                ? `translate(${px}, ${py}) scale(1, -1)`
                : `translate(${px}, ${py})`;
            path.setAttribute('transform', transform);
            path.setAttribute('d', TRI_PATH);
            path.setAttribute('fill', c.isClick ? clickColor : contourColor);
            path.setAttribute('fill-opacity', c.isClick ? clickFill : contourFill);
            path.setAttribute('stroke', c.isClick ? '#FFFFFF' : contourColor);
            path.setAttribute('stroke-width', c.isClick ? '3' : '3');
            path.setAttribute('stroke-linejoin', 'round');
            if (dash && !c.isClick) path.setAttribute('stroke-dasharray', dash);
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
     * Click dispatch. The May-2026 refactor moved interactivity to
     * pointer events; sending just `click` doesn't trigger the React
     * handler reliably. We fire pointerdown → pointerup → click as a
     * triplet, all at the geometric centre of the cell's bounding
     * triangle. Bounding triangle has pointer-events:auto in the new
     * DOM, but if it ever has pointer-events:none we'd need to fall
     * back to the parent <g>. Verified live 2026-05-11.
     */
    async function attemptClick(glyphGroup, mod) {
        const tri = glyphGroup.querySelector(SEL.TRIANGLE);
        const target = tri || glyphGroup;
        if (!target) return false;
        const r = target.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        if (mod) mod.debug(`click dispatch: target=<${target.tagName}> at (${x.toFixed(0)},${y.toFixed(0)}) box=${r.width.toFixed(0)}x${r.height.toFixed(0)}`);
        const fire = (type, EventCtor, extra) => {
            target.dispatchEvent(new EventCtor(type, {
                bubbles: true, cancelable: true, view: window,
                clientX: x, clientY: y, button: 0, buttons: 1,
                ...extra,
            }));
        };
        // PointerEvent first (what React 17+ listens to via onPointerDown),
        // then MouseEvent click as a fallback for any legacy handler.
        try {
            fire('pointerdown', PointerEvent, { pointerType: 'mouse', isPrimary: true });
            fire('pointerup', PointerEvent, { pointerType: 'mouse', isPrimary: true });
        } catch (_) {
            // Some browsers may not have PointerEvent — degrade to mouse.
            fire('mousedown', MouseEvent);
            fire('mouseup', MouseEvent);
        }
        fire('click', MouseEvent);
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
                const { strong: strongTh, mid: midTh } = adaptiveThresholds(total);

                // 1. Full match — strongest signal, commit immediately.
                const complete = candidates.find((c) => c.match === total);
                if (complete) return finish({ best: complete, reason: 'complete' });

                const best = candidates[0]; // sorted desc by match
                const second = candidates[1];

                // 2. Strong partial — high match wins even against
                //    alternatives. With ~55% of the target matched the
                //    chance of a coincidental same-anchor match elsewhere
                //    is negligible (threshold === 5 for the live 9-cell
                //    target, scales up for larger targets).
                if (best && best.match >= strongTh) {
                    return finish({ best, reason: 'strong-partial' });
                }

                // 3. Mid partial — needs to be unique OR dominate the
                //    runner-up by at least 2 cells. Dominance check
                //    lets us fire even when several anchors still
                //    survive but one is clearly the answer.
                if (best && best.match >= midTh) {
                    const isUnique = candidates.length === 1;
                    const isDominant = !second || best.match - second.match >= 2;
                    if (isUnique || isDominant) {
                        return finish({ best, reason: isUnique ? 'unique-partial' : 'dominant-partial' });
                    }
                }

                // 4. Elimination fallback when sig-anchor filtering
                //    has zero positives but elimination narrows to one.
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
            await attemptClick(best.clickGroup, mod);

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
