// Auto-solver for the SAI "Porter-lite r4" / ICE WALL Break minigame.
//
// Mechanic:
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
    // Confidence is measured in REVEALED ↔ REVEALED glyph matches
    // (`realMatch`). Target placeholders are wildcards and don't count
    // — separating them from realMatch fixed the original "fire on 2
    // confirmed glyphs" bug. Past that, the thresholds reflect the
    // user's gameplay intuition: ~⅓ to ~⅔ of the target shape's cells
    // confirmed at the candidate's offset is usually enough to lock in
    // the position, because the matcher's mismatch filter has already
    // eliminated wrong-anchor positions. We rely on:
    //
    //   • pre-click verification (re-check candidate vs latest board
    //     just before clicking, skip if a late reveal contradicts);
    //   • false-positive retry (counter doesn't tick → exclude anchor,
    //     re-search) for the rare wrong commit.
    //
    // Thresholds are computed from `total` (the target's cell count,
    // stable once known), not `revealedTotal` — small targets need a
    // higher fraction (2/3 → midTh=2), big targets a lower fraction
    // (3/9 → midTh=3, 4/9 → strongTh=4).
    //
    //   MIN_REVEALED_FOR_COMMIT: at least this many target cells must
    //     be revealed before any commit. Keeps the matcher from firing
    //     on revealedTotal=1 where any board cell with the anchor sig
    //     would match.
    //   MIN_PARTIAL_MATCH:    absolute floor for mid-partial threshold.
    //   STRONG_PARTIAL_MATCH: absolute floor for strong-partial — high
    //     enough to commit even when same-realMatch alternatives exist.
    //   STABLE_COMMIT_MS:     same leader held at midTh for this long
    //     → commit even without strict uniqueness/dominance.
    const MIN_PARTIAL_MATCH = 2;
    const STRONG_PARTIAL_MATCH = 4;
    const STRONG_PARTIAL_RATIO = 0.40;
    const MIN_PARTIAL_RATIO = 0.33;
    const MIN_REVEALED_FOR_COMMIT = 2;
    // Target shapes are variable-size (3 / 6 / 9 cells observed). A fixed
    // MIN_REVEALED_FOR_COMMIT=2 is too aggressive on 6-cell targets —
    // 2/6 = 33% revealed and the mid-partial branch (realMatch >= midTh=2)
    // would fire on the first plausible anchor and commit wrong. The
    // 40%-of-total floor below means a 6-cell target needs 3 reveals
    // before any commit, a 9-cell target needs 4, etc. The classic 3-cell
    // case still passes at 2/3.
    const MIN_REVEALED_RATIO = 0.40;
    const STABLE_COMMIT_MS = 3000;

    function adaptiveThresholds(total) {
        return {
            strong: Math.max(STRONG_PARTIAL_MATCH, Math.ceil(total * STRONG_PARTIAL_RATIO)),
            mid:    Math.max(MIN_PARTIAL_MATCH,    Math.ceil(total * MIN_PARTIAL_RATIO)),
            minRevealed: Math.max(MIN_REVEALED_FOR_COMMIT, Math.ceil(total * MIN_REVEALED_RATIO)),
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
     *                    AND no pure-glyph filled path
     *   - 'revealed':    has a pure-glyph filled path (the actual icon),
     *                    regardless of whether outline-only paths also
     *                    exist around it
     *
     * Each board cell goes empty → placeholder → revealed as the game
     * reveals new glyphs every ~1s. Target placeholder cells act as
     * wildcards in the matcher (any board state in that position
     * matches).
     *
     * Why hasFilledGlyph takes precedence: revealed cells sometimes
     * carry outline-only decorative strokes (May-2026 game update),
     * which would otherwise trip the outline-only check and classify
     * the cell as 'placeholder'. The matcher then treats the
     * misclassified cell as a wildcard, lets candidates whose shape
     * covers it survive even though it actually contains a non-target
     * glyph — i.e. the "candidate area contains a glyph not in the
     * target sequence" bug the user reported.
     *
     * The filled-glyph filter mirrors glyphSignature's criteria (fill
     * = COLOR_LIT, no stroke, no fill-opacity) so cellState and
     * glyphSignature stay in agreement: a cell that contributes a sig
     * is also a cell that's classified 'revealed'.
     */
    function cellState(glyphGroup) {
        let hasEmptyFill = false;
        let hasFilledGlyph = false;
        let hasOutlineOnly = false;
        for (const el of glyphGroup.querySelectorAll('path, rect')) {
            if (el.dataset && el.dataset.sentryComponent === 'GlyphBoundingTriangle') continue;
            const f = el.getAttribute('fill');
            const s = el.getAttribute('stroke');
            const fo = el.getAttribute('fill-opacity');
            if (f === COLOR_EMPTY) hasEmptyFill = true;
            if (f === COLOR_LIT && s === null && fo === null) hasFilledGlyph = true;
            if (f === null && s === COLOR_LIT) hasOutlineOnly = true;
        }
        if (hasEmptyFill) return 'empty';
        if (hasFilledGlyph) return 'revealed';
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

    // ─── Learned shape → click-cell DB ───────────────────────────────────
    // Built up over rounds; persisted by the isolated auto-ice-wall bridge (MAIN
    // can't touch chrome.storage). Canonical, position-independent key for a
    // TARGET shape: each cell relative to the topmost-leftmost cell + its mirror
    // + a revealed/placeholder flag — deliberately NOT the glyph icons (the
    // click cell is geometry-determined, so same-shape-different-icons collapse
    // to ONE entry; see the `key` line). The learned value is the click cell's
    // offset from that origin, so a recurring shape at ANY board position reuses
    // the cell the brute-force found instead of re-brute-forcing.
    function canonicalShape(targetCells) {
        if (!targetCells || !targetCells.length) return null;
        const origin = targetCells.reduce((a, b) => (b.row < a.row || (b.row === a.row && b.col < a.col)) ? b : a);
        const rel = targetCells.map((c) => ({
            dc: c.col - origin.col, dr: c.row - origin.row, mirror: !!c.mirror,
            revealed: c.state === 'revealed', g: c.state === 'revealed' ? c.sig : null,
        })).sort((a, b) => a.dr - b.dr || a.dc - b.dc || (a.mirror ? 1 : 0) - (b.mirror ? 1 : 0));
        // Key on GEOMETRY + revealed/placeholder layout ONLY — NOT the glyph
        // icons. The correct click cell is determined by the shape's
        // arrangement, not by which icons fill it (confirmed: same-geometry
        // shapes with different glyphs share the same click cell). Including the
        // glyph sig bloated the DB with one entry per icon-combination of the
        // same pattern. (The matcher still uses sigs to locate the board match;
        // that's separate from this click-offset key.)
        const key = rel.map((r) => `${r.dr},${r.dc},${r.mirror ? 1 : 0},${r.revealed ? 'R' : '_'}`).join(';');
        return { origin, rel, key };
    }
    // Target-grid coords of the learned click cell for the current target shape,
    // or null if the shape isn't in the DB yet.
    function learnedClickFor() {
        const db = root.__iceWallClickDB;
        if (!db) return null;
        const shape = canonicalShape(readTargetCells());
        if (!shape) return null;
        const entry = db[shape.key];
        if (!entry || !entry.click) return null;
        return { tCol: shape.origin.col + entry.click.dc, tRow: shape.origin.row + entry.click.dr, mirror: !!entry.click.mirror };
    }
    // Record (+ persist) that clicking `clickedCell` solved the SOLVED target
    // shape. clickedCell carries its TARGET coords (tCol/tRow). `solvedShape` MUST
    // be the shape snapshotted BEFORE the click — by the time the counter advances
    // the live target preview has swapped to the NEXT shape, so re-reading it here
    // would key the entry on the wrong shape (corrupting the DB). Callers pass the
    // pre-click snapshot; the canonicalShape(readTargetCells()) fallback is only
    // for safety if a caller omits it.
    function learnClick(clickedCell, solvedShape) {
        if (!clickedCell || clickedCell.tCol == null) return;
        const shape = solvedShape || canonicalShape(readTargetCells());
        if (!shape) return;
        const click = { dc: clickedCell.tCol - shape.origin.col, dr: clickedCell.tRow - shape.origin.row, mirror: !!clickedCell.mirror };
        const db = root.__iceWallClickDB || (root.__iceWallClickDB = {});
        const prev = db[shape.key];
        const entry = { cells: shape.rel, click, learnedAt: Date.now(), hits: ((prev && prev.hits) || 0) + 1 };
        db[shape.key] = entry;
        try { Bus.window.post(MSG.SOLVER.ICE_WALL_LEARN, { key: shape.key, entry }); } catch (_) { /* noop */ }
    }

    // The REVEALED (clickable) board cells of a confirmed candidate shape,
    // ordered: LEARNED cell first (instant for known shapes), then
    // pickClickTarget's guess, then bottom-left. The game completes the cycle
    // only on the SPECIFIC cell it treats as the shape's selection anchor —
    // NOT always the centroid — so solveRound tries these in order until the
    // counter ticks, learning the winner. Finds the right cell for ANY shape
    // without a per-shape override map.
    function candidateClickCells(cand) {
        const boardMap = makeBoardMap(readBoardCells());
        const cells = [];
        for (const c of cand.cells) {
            const bc = boardMap.get(`${c.col},${c.row},${c.mirror}`);
            if (bc && bc.state === 'revealed') cells.push({ col: c.col, row: c.row, mirror: c.mirror, isClick: c.isClick, tCol: c.tCol, tRow: c.tRow, group: bc.group });
        }
        const learned = learnedClickFor();
        const isLearned = (x) => !!learned && x.tCol === learned.tCol && x.tRow === learned.tRow && (!!x.mirror === !!learned.mirror);
        cells.sort((a, b) => {
            const lc = (isLearned(b) ? 1 : 0) - (isLearned(a) ? 1 : 0);  // learned cell first
            if (lc) return lc;
            const ic = (b.isClick ? 1 : 0) - (a.isClick ? 1 : 0);        // then pickClickTarget guess
            if (ic) return ic;
            if (a.row !== b.row) return b.row - a.row;                   // then bottom-most
            return a.col - b.col;                                       // then left-most
        });
        return cells;
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
        // Click target must be a REVEALED cell: picking over ALL target cells
        // (incl. placeholders) could land on a cell whose mapped board offset is
        // still empty/unrevealed, so the click misfires, the counter never
        // advances, and a correct match is wrongly discarded.
        const targetClick = pickClickTarget(revealedTargets);

        const boardCells = readBoardCells();
        const boardMap = makeBoardMap(boardCells);

        const out = [];
        for (const cand of boardCells) {
            if (cand.state !== 'revealed') continue;
            if (cand.mirror !== targetAnchor.mirror) continue;
            if (cand.sig !== targetAnchor.sig) continue;

            const candKey = `${cand.col},${cand.row}`;
            if (excludeKeys && excludeKeys.has(candKey)) continue;

            let realMatch = 0, wildMatch = 0, mismatch = 0, unknown = 0;
            const cells = [];
            for (const t of targetCells) {
                const cc = cand.col + (t.col - targetAnchor.col);
                const cr = cand.row + (t.row - targetAnchor.row);
                const bc = boardMap.get(`${cc},${cr},${t.mirror}`);
                cells.push({ col: cc, row: cr, mirror: t.mirror, isClick: t === targetClick, tCol: t.col, tRow: t.row });

                if (!bc) { mismatch++; continue; }

                if (t.state !== 'revealed') {
                    // Target placeholder/empty positions mark "blanks" in
                    // the pattern: that board cell must NOT be revealed
                    // with a different glyph. Accept board states empty
                    // or placeholder (both mean "no committed glyph
                    // there"). If board has revealed a unique glyph in
                    // that slot, this candidate is at the wrong position.
                    //
                    // Counted as `wildMatch`, NOT `realMatch` — wildcards
                    // are consistency checks, not positive evidence; they
                    // can't disambiguate between competing anchor positions.
                    if (bc.state === 'revealed') { mismatch++; continue; }
                    wildMatch++;
                    continue;
                }
                if (bc.state !== 'revealed') { unknown++; continue; }
                if (bc.sig !== t.sig) { mismatch++; continue; }
                realMatch++;
            }
            if (mismatch > 0) continue;
            if (realMatch === 0) continue;

            const clickCol = cand.col + (targetClick.col - targetAnchor.col);
            const clickRow = cand.row + (targetClick.row - targetAnchor.row);
            const clickCell = boardMap.get(`${clickCol},${clickRow},${targetClick.mirror}`);
            out.push({
                col: cand.col, row: cand.row,
                cells,
                clickGroup: clickCell ? clickCell.group : cand.group,
                clickCol, clickRow, clickMirror: targetClick.mirror,
                realMatch, wildMatch, unknown, mismatch,
                match: realMatch, // alias for logging / backward compat
                total: targetCells.length,
                revealedTotal: revealedTargets.length,
            });
        }
        out.sort((a, b) => {
            if (b.realMatch !== a.realMatch) return b.realMatch - a.realMatch;
            if (a.col !== b.col) return a.col - b.col;
            return a.row - b.row;
        });
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
        // Click target must be a REVEALED cell: picking over ALL target cells
        // (incl. placeholders) could land on a cell whose mapped board offset is
        // still empty/unrevealed, so the click misfires, the counter never
        // advances, and a correct match is wrongly discarded.
        const targetClick = pickClickTarget(revealedTargets);

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
                cells.push({ col: cc, row: cr, mirror: t.mirror, isClick: t === targetClick, tCol: t.col, tRow: t.row });
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
                realMatch: 0, wildMatch: 0, unknown: 0, mismatch: 0,
                match: 0, // alias for logging
                total: targetCells.length,
                revealedTotal: revealedTargets.length,
            });
        }
        return out;
    }

    // ─── Overlay ─────────────────────────────────────────────────────────
    //
    // Three z-stacked layers under a single `cor3-icewall-overlay` group:
    //   noise     — dim every revealed board cell whose glyph isn't in
    //               the target sequence. Pure UX: shows the user which
    //               cells the matcher has ruled out as irrelevant.
    //   rejected  — red marker on anchors that were committed-and-clicked
    //               but didn't advance the counter (false positives).
    //               Persists for the rest of the round so the user can
    //               see what the solver tried and discarded.
    //   candidate — the currently-leading match (yellow dashed when
    //               tentative, orange when confident-and-about-to-click)
    //               plus the red click target cell.
    //
    // Each layer keeps a `dataset.cor3Key` of its current contents and
    // skips redraws when the key is unchanged. That matters because we
    // attach this overlay inside the wall subtree the MutationObserver
    // is watching: an unconditional clear+redraw would retrigger the
    // observer in an 80ms loop.

    const OVERLAY_ID = 'cor3-icewall-overlay';
    const TRI_PATH = 'M60.6914 53.0305 H1.73242 L31.21 1.99927 Z';
    const LAYER_ORDER = ['noise', 'rejected', 'candidate']; // bottom → top

    function ensureOverlayLayers() {
        const wall = document.querySelector(SEL.WALL);
        if (!wall) return null;
        let overlay = wall.querySelector('#' + OVERLAY_ID);
        if (!overlay) {
            const renderG = wall.querySelector(':scope > g') || wall;
            const ns = 'http://www.w3.org/2000/svg';
            overlay = document.createElementNS(ns, 'g');
            overlay.setAttribute('id', OVERLAY_ID);
            overlay.setAttribute('pointer-events', 'none');
            for (const subId of LAYER_ORDER) {
                const g = document.createElementNS(ns, 'g');
                g.setAttribute('data-cor3-layer', subId);
                overlay.appendChild(g);
            }
            renderG.appendChild(overlay);
        }
        return overlay;
    }

    function getLayer(name) {
        const overlay = ensureOverlayLayers();
        if (!overlay) return null;
        return overlay.querySelector(`g[data-cor3-layer="${name}"]`);
    }

    function clearLayerContent(layer) {
        if (!layer) return;
        while (layer.firstChild) layer.removeChild(layer.firstChild);
    }

    function clearOverlay() {
        const wall = document.querySelector(SEL.WALL);
        if (!wall) return;
        const old = wall.querySelector('#' + OVERLAY_ID);
        if (old) old.remove();
    }

    function drawCellPath(layer, col, row, mirror, attrs) {
        const ns = 'http://www.w3.org/2000/svg';
        const px = col * COL_PX;
        const py = row * ROW_PX;
        const path = document.createElementNS(ns, 'path');
        const transform = mirror
            ? `translate(${px}, ${py}) scale(1, -1)`
            : `translate(${px}, ${py})`;
        path.setAttribute('transform', transform);
        path.setAttribute('d', TRI_PATH);
        for (const k in attrs) {
            const v = attrs[k];
            if (v !== null && v !== undefined) path.setAttribute(k, v);
        }
        layer.appendChild(path);
    }

    /**
     * Outline each cell of the matched shape; the click target gets a
     * solid red fill at high opacity. tentative = dashed yellow,
     * confident = solid orange.
     */
    function drawCandidateOverlay(candidate, confident) {
        const layer = getLayer('candidate');
        if (!layer) return;
        const cellsKey = candidate.cells
            .map((c) => `${c.col},${c.row},${c.mirror ? 1 : 0},${c.isClick ? 1 : 0}`)
            .join('|');
        const key = `${confident ? 1 : 0}::${cellsKey}`;
        if (layer.dataset.cor3Key === key) return;
        clearLayerContent(layer);
        layer.dataset.cor3Key = key;

        const contourColor = confident ? '#FFB857' : '#FFE066';
        const contourFill = confident ? '0.18' : '0.06';
        const dash = confident ? null : '6,4';
        const clickColor = '#FF3333';
        const clickFill = confident ? '0.70' : '0.55';

        for (const c of candidate.cells) {
            drawCellPath(layer, c.col, c.row, c.mirror, {
                fill: c.isClick ? clickColor : contourColor,
                'fill-opacity': c.isClick ? clickFill : contourFill,
                stroke: c.isClick ? '#FFFFFF' : contourColor,
                'stroke-width': '3',
                'stroke-linejoin': 'round',
                'stroke-dasharray': (dash && !c.isClick) ? dash : null,
            });
        }
    }

    /**
     * Dim every revealed board cell whose glyph doesn't appear anywhere
     * in the current target sequence. These cells are noise — the matcher
     * already ignores them, but showing the user which ones are "ruled
     * out" makes the solver's progress legible.
     */
    function drawNoiseOverlay() {
        const layer = getLayer('noise');
        if (!layer) return;

        // Key by glyph signature AND orientation (the cell `mirror` — up vs
        // down / scale(1,-1)). Glyph rotation/flip is NOT in the path transform
        // (verified live: paths carry transform=null); the up/down orientation
        // is the cell mirror, and an up-triangle and its flipped down-triangle
        // share the SAME `d` (same sig). Greying by sig ALONE therefore left a
        // board glyph that has a target ICON but the WRONG orientation
        // un-dimmed — the user-reported "same shape, wrong angle, not marked
        // wrong" bug. Including mirror greys those too. (The matcher already
        // keys on sig+mirror, so this only aligns the noise overlay with it.)
        const orientKey = (c) => c.sig + '|' + (c.mirror ? 1 : 0);
        const targetSigs = new Set();
        for (const t of readTargetCells()) {
            if (t.state === 'revealed') targetSigs.add(orientKey(t));
        }
        const noiseCells = [];
        if (targetSigs.size > 0) {
            for (const b of readBoardCells()) {
                if (b.state === 'revealed' && !targetSigs.has(orientKey(b))) {
                    noiseCells.push(b);
                }
            }
        }
        const key = noiseCells.map((b) => `${b.col},${b.row}`).sort().join('|');
        if (layer.dataset.cor3Key === key) return;
        clearLayerContent(layer);
        layer.dataset.cor3Key = key;

        for (const b of noiseCells) {
            drawCellPath(layer, b.col, b.row, b.mirror, {
                fill: '#000000',
                'fill-opacity': '0.45',
                stroke: '#404040',
                'stroke-width': '1',
            });
        }
    }

    /**
     * Mark anchors that were committed but failed to advance the counter
     * — i.e. positions the solver tried and ruled out. Persists for the
     * remainder of the round; cleared at round end via clearOverlay().
     */
    function drawRejectedOverlay(excludeKeys) {
        const layer = getLayer('rejected');
        if (!layer) return;
        const key = [...excludeKeys].sort().join('|');
        if (layer.dataset.cor3Key === key) return;
        clearLayerContent(layer);
        layer.dataset.cor3Key = key;
        if (excludeKeys.size === 0) return;

        const byKey = new Map();
        for (const b of readBoardCells()) byKey.set(`${b.col},${b.row}`, b);

        for (const ek of excludeKeys) {
            const cell = byKey.get(ek);
            if (!cell) continue;
            drawCellPath(layer, cell.col, cell.row, cell.mirror, {
                fill: '#FF1A1A',
                'fill-opacity': '0.45',
                stroke: '#FF1A1A',
                'stroke-width': '3',
                'stroke-dasharray': '4,3',
                'stroke-linejoin': 'round',
            });
        }
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
     * triangle. Bounding triangle has pointer-events:auto; if it ever
     * gets pointer-events:none we'd fall back to the parent <g>.
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
        // then MouseEvent click as a fallback.
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
            let periodicTimer = null;
            // Stable-partial state: track the identity of the current
            // leader and how long it has held that spot.
            let lastBestKey = null;
            let lastBestSince = Date.now();

            const finish = (val) => {
                if (done) return;
                done = true;
                if (observer) observer.disconnect();
                clearTimeout(debounceTimer);
                clearTimeout(hardTimer);
                clearInterval(periodicTimer);
                resolve(val);
            };

            const check = () => {
                if (done) return;
                const wall = document.querySelector(SEL.WALL);
                if (!wall) return finish(null);

                // Always-on UX overlays — both memoize internally so they
                // don't retrigger the MutationObserver when state is stable.
                drawNoiseOverlay();
                drawRejectedOverlay(excludeKeys);

                const { candidates, total, revealedTotal } = findShapeCandidates(excludeKeys);

                const best = candidates[0]; // sorted desc by realMatch, then col, row
                const second = candidates[1];
                const bestKey = best ? `${best.col},${best.row}` : null;
                if (bestKey !== lastBestKey) {
                    lastBestKey = bestKey;
                    lastBestSince = Date.now();
                }

                const { strong: strongTh, mid: midTh, minRevealed } = adaptiveThresholds(total);

                if (revealedTotal < minRevealed) {
                    if (onTentative && candidates.length > 0) onTentative(candidates[0]);
                    return;
                }

                // 1. Complete: every revealed target glyph maps to a
                //    revealed board cell, AND only this candidate is
                //    fully consistent. Uniqueness protects against
                //    early rounds where several positions are still
                //    feasible.
                const fullConfirms = candidates.filter((c) => c.realMatch === revealedTotal);
                if (fullConfirms.length === 1) return finish({ best: fullConfirms[0], reason: 'complete' });

                // 2. Strong partial — enough confirmed glyphs that the
                //    candidate wins even against same-anchor alternatives.
                //    strongTh === 4 for total=9; scales with target size.
                if (best && best.realMatch >= strongTh) {
                    return finish({ best, reason: 'strong-partial' });
                }

                // 3. Mid partial — at midTh AND either the only surviving
                //    candidate or dominating the runner-up by 2+ real
                //    matches. midTh === 3 for total=9, 2 for total=3.
                if (best && best.realMatch >= midTh) {
                    const isUnique = candidates.length === 1;
                    const isDominant = !second || best.realMatch - second.realMatch >= 2;
                    if (isUnique || isDominant) {
                        return finish({ best, reason: isUnique ? 'unique-partial' : 'dominant-partial' });
                    }
                }

                // 4. Elimination fallback — sig-anchor filtering returns
                //    zero positive candidates but elimination narrows
                //    everything else to one.
                if (candidates.length === 0) {
                    const elim = findByElimination(excludeKeys);
                    if (elim.length === 1) return finish({ best: elim[0], reason: 'elimination' });
                }

                // 5. Stable partial — same leader held at midTh for
                //    STABLE_COMMIT_MS. Breaks ties when several
                //    candidates share the lead and the board's reveal
                //    cadence has slowed.
                if (best && best.realMatch >= midTh && (Date.now() - lastBestSince) >= STABLE_COMMIT_MS) {
                    return finish({ best, reason: 'stable-partial' });
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

            // Safety-net periodic check so the stable-partial timer can
            // still fire when the board stops mutating (reveal cadence
            // slows or pauses near end of round).
            periodicTimer = setInterval(scheduleCheck, 500);

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
    const countRevealed = () => readBoardCells().reduce((n, c) => n + (c.state === 'revealed' ? 1 : 0), 0);

    async function solveRound(mod) {
        const excludeKeys = new Set();
        const roundStart = Date.now();
        // Exclusions are only valid for the board state they were made on. An
        // anchor whose click failed while the board was still SPARSE is almost
        // always failing because the shape's true selection-anchor cell hadn't
        // been revealed yet (candidateClickCells can only click revealed cells).
        // If we keep that anchor excluded, it stays barred even after it reveals
        // into the unique full match — the solver then sits idle on an empty
        // overlay until the timer kills the round (observed live: a perfect 5/5
        // match at one offset, never clicked, counter stuck 0/3). So: whenever
        // the board reveals NEW cells, drop all exclusions and re-evaluate with
        // the fresh information. On a STABLE (fully-revealed) board the exclude
        // mechanism still works normally — only new reveals reset it.
        let excludeRevCount = countRevealed();

        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            if (root.__iceWallAbort) return false;
            if (!document.querySelector(SEL.APP)) return false;
            const counter = readCounter();
            if (counter && counter.current >= counter.total) return true;

            const revNow = countRevealed();
            if (revNow > excludeRevCount) {
                if (excludeKeys.size) mod.debug(`board revealed ${revNow - excludeRevCount} new cell(s) — clearing ${excludeKeys.size} stale exclusion(s)`);
                excludeKeys.clear();
                excludeRevCount = revNow;
            }

            const remaining = Math.max(2000, ROUND_MAX_MS - (Date.now() - roundStart));
            const result = await waitForCandidate(
                excludeKeys, remaining,
                (tentative) => drawCandidateOverlay(tentative, false),
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

            // Pre-click verification — re-check the candidate against
            // the current board state. New reveals between waitForCandidate
            // resolving and this point may have introduced a mismatch
            // that makes the chosen anchor wrong. Cheaper to re-search
            // than to mis-click and burn 4s waiting for the counter.
            const refreshed = findShapeCandidates(excludeKeys).candidates
                .find((c) => c.col === best.col && c.row === best.row)
                || findByElimination(excludeKeys)
                    .find((c) => c.col === best.col && c.row === best.row);
            if (!refreshed) {
                mod.warn(`pre-click verify failed at (${best.col},${best.row}) — candidate eliminated by late reveal; re-searching`);
                continue;
            }
            best = refreshed; // refresh realMatch / unknown with latest state

            mod.info(`commit (${reason}): anchor=(${best.col},${best.row}) shape=${best.cells.length} cells realMatch=${best.realMatch}/${best.revealedTotal} unknown=${best.unknown} (target ${best.total}) attempt=${attempt + 1}/${MAX_RETRIES}`);
            drawCandidateOverlay(best, true);

            // Try each REVEALED cell of the confirmed shape as the click target
            // (pickClickTarget's guess first, then bottom-left), until the
            // counter advances. The game completes the cycle only on the cell it
            // uses as the shape's selection anchor — not always the centroid —
            // so brute-forcing the shape's own cells lands the right one for any
            // shape. Only if NO cell of the shape advances do we treat it as a
            // wrong shape and exclude the anchor.
            const clickCells = candidateClickCells(best);
            // Snapshot the CURRENT (about-to-be-solved) target shape NOW, before any
            // click advances the counter and swaps the preview to the next shape —
            // learnClick must key on this, not the post-advance live target.
            const solvedShape = canonicalShape(readTargetCells());
            let advanced = null;
            for (const cell of clickCells) {
                if (root.__iceWallAbort) return false;
                if (!document.querySelector(SEL.APP)) return false;
                const before = readCounter();
                mod.debug(`try click cell (${cell.col},${cell.row})${cell.isClick ? ' [pick]' : ''}`);
                await attemptClick(cell.group, mod);
                advanced = await dom.waitFor(() => {
                    const cc = readCounter();
                    return cc && before && cc.current > before.current ? cc : null;
                }, { timeout: 3000 });
                if (advanced) {
                    mod.info(`counter advanced via cell (${cell.col},${cell.row})${cell.isClick ? '' : ' [learned]'}: ${advanced.current}/${advanced.total}`);
                    learnClick(cell, solvedShape);   // remember this shape→cell so it's instant next time
                    clearOverlay();
                    return true;
                }
            }

            mod.warn(`no cell of shape at (${best.col},${best.row}) advanced (${clickCells.length} tried) — excluding & re-searching (${attempt + 1}/${MAX_RETRIES})`);
            excludeKeys.add(`${best.col},${best.row}`);
            drawRejectedOverlay(excludeKeys);
        }
        mod.warn(`exhausted ${MAX_RETRIES} retries on this round`);
        clearOverlay();
        return false;
    }

    async function watchLoop(mod) {
        // Outer try/finally guarantees flag reset even if anything
        // inside throws — otherwise __iceWallActive stays true and the
        // START handler refuses to restart the loop, manifesting as
        // "solver stopped detecting puzzles" after a one-off DOM hiccup.
        try {
            while (!root.__iceWallAbort) {
                try {
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
                    // Tell auto-jobs (and any other listener) that an
                    // ice-wall puzzle is being solved. Suppresses the
                    // solving-watchdog so a long puzzle doesn't trip the
                    // 5min state TTL before the actual job flow runs.
                    Bus.window.post(MSG.SOLVER.ICE_WALL_BUSY, { busy: true, ts: Date.now() });

                    try {
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
                    } finally {
                        Bus.window.post(MSG.SOLVER.ICE_WALL_BUSY, { busy: false, ts: Date.now() });
                    }
                    clearOverlay();
                    if (!root.__iceWallAbort) mod.debug('puzzle closed, watching for next one');
                } catch (err) {
                    mod.error(`iteration crashed: ${err?.message || err} — recovering`);
                    clearOverlay();
                    await dom.sleep(2000);
                }
            }
        } finally {
            clearOverlay();
            root.__iceWallActive = false;
            root.__iceWallAbort = false;
            mod.info('ice-wall solver stopped');
        }
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
            // Load the learned click DB from the isolated bridge (which owns the
            // chrome.storage copy). Request it once now; also accept pushes.
            this.track(Bus.window.on(MSG.SOLVER.ICE_WALL_DB, (env) => {
                if (env && env.db && typeof env.db === 'object') {
                    root.__iceWallClickDB = env.db;
                    this.debug(`ice-wall click DB loaded (${Object.keys(env.db).length} shape(s))`);
                }
            }));
            Bus.window.post(MSG.SOLVER.ICE_WALL_DB_REQUEST, null);

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
