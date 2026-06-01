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

    // Module logger ref (set when the watch loop starts) so the diagnostic dumps
    // emitted from non-`mod` scopes (waitForCandidate's check()) also reach the
    // Logger — they then show up in the popup Logs panel under id 'solver-ice-wall',
    // alongside the console output, so they can be copied/shared.
    let logRef = null;

    const SEL = {
        APP:        '[data-sentry-component="IceWallBreakApplication"]',
        WALL:       '[data-sentry-component="WallBoard"]',
        TARGET:     '[data-sentry-component="TargetPreview"]',
        TRIANGLE:   '[data-sentry-component="GlyphBoundingTriangle"]',
        COUNTER:    '[data-sentry-element="SidebarCounterStyled"]',
        TIMER:      '[data-sentry-element="TimerBoxesStyled"]',
        EVENT_LOG:  '[data-sentry-element="EventLogStyled"]',
        // The intro log block ("Initializing ICE WALL Break… [CONNECTED]…") — a
        // stable, always-visible text panel OUTSIDE the watched WALL subtree. We
        // append the diagnostic HUD line here (bright) instead of as SVG text on
        // the board, which overflowed the window and read faintly.
        INTRO:      '[data-sentry-component="DecorativeIntro"]',
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
        return { tCol: shape.origin.col + entry.click.dc, tRow: shape.origin.row + entry.click.dr, mirror: !!entry.click.mirror, pinned: !!entry.pinned };
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
        const db = root.__iceWallClickDB || (root.__iceWallClickDB = {});
        const prev = db[shape.key];
        // PINNED entries are user-authoritative — never auto-overwrite the click
        // cell from a solve. (Counter still advanced, but the user owns this shape.)
        if (prev && prev.pinned) return;
        const click = { dc: clickedCell.tCol - shape.origin.col, dr: clickedCell.tRow - shape.origin.row, mirror: !!clickedCell.mirror };
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
        // PINNED shape → click ONLY the user-chosen cell (when it's revealed on the
        // board). No brute-force through the shape's other cells — each miss costs a
        // real -16s, and the user has declared this the right cell.
        if (learned && learned.pinned) {
            return cells.filter(isLearned).map((x) => Object.assign({}, x, { pinned: true }));
        }
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
        if (targetCells.length === 0) return { candidates: [], total: 0, revealedTotal: 0, anchorHits: 0 };

        const revealedTargets = targetCells.filter((c) => c.state === 'revealed');
        if (revealedTargets.length === 0) return { candidates: [], total: targetCells.length, revealedTotal: 0, anchorHits: 0 };

        // MULTI-ANCHOR. Anchor on EVERY revealed target cell whose sig is UNIQUE in
        // the target (non-unique sigs match too many board cells → false partials).
        // Trying ALL unique glyphs — not just the first — makes the shape found via
        // WHICHEVER glyph happens to be revealed on the board at its position, instead
        // of stalling until one specific anchor glyph reveals (reveal-order
        // independence — confirmed needed: a board where only the 'first' anchor was
        // revealed at the bottom edge gave cand 0 while the other unique glyphs were
        // already placeable). Each (anchor, matching board cell) defines a placement
        // offset (ocol,orow); placements are de-duped and each is validated in full,
        // so multi-anchor adds no false positives (mismatch>0 still rejects).
        const sigCounts = new Map();
        for (const t of revealedTargets) sigCounts.set(t.sig, (sigCounts.get(t.sig) || 0) + 1);
        const anchors = revealedTargets.filter((t) => sigCounts.get(t.sig) === 1);
        const anchorSet = anchors.length ? anchors : [revealedTargets[0]];
        const ref = revealedTargets[0];   // stable per-placement identity cell
        // Click target must be a REVEALED cell (a placeholder's board offset may be
        // unrevealed → the click misfires and a correct match is wrongly discarded).
        const targetClick = pickClickTarget(revealedTargets);

        const boardCells = readBoardCells();
        const boardMap = makeBoardMap(boardCells);
        // Index revealed board cells by sig+mirror for fast anchor lookup.
        const bySigMir = new Map();
        for (const b of boardCells) {
            if (b.state !== 'revealed') continue;
            const k = b.sig + '|' + (b.mirror ? 1 : 0);
            let arr = bySigMir.get(k); if (!arr) bySigMir.set(k, arr = []); arr.push(b);
        }

        // Collect unique placement offsets (ocol,orow) from all anchors.
        const placements = new Map();   // "ocol,orow" -> [ocol, orow]
        let anchorHits = 0;
        for (const a of anchorSet) {
            const hits = bySigMir.get(a.sig + '|' + (a.mirror ? 1 : 0)) || [];
            for (const b of hits) {
                anchorHits++;
                const ocol = b.col - a.col, orow = b.row - a.row;
                const key = `${ocol},${orow}`;
                if (!placements.has(key)) placements.set(key, [ocol, orow]);
            }
        }

        const out = [];
        for (const [ocol, orow] of placements.values()) {
            const refCol = ref.col + ocol, refRow = ref.row + orow;   // placement identity
            const candKey = `${refCol},${refRow}`;
            if (excludeKeys && excludeKeys.has(candKey)) continue;

            let realMatch = 0, wildMatch = 0, mismatch = 0, unknown = 0;
            const cells = [];
            for (const t of targetCells) {
                const cc = t.col + ocol, cr = t.row + orow;
                const bc = boardMap.get(`${cc},${cr},${t.mirror}`);
                cells.push({ col: cc, row: cr, mirror: t.mirror, isClick: t === targetClick, tCol: t.col, tRow: t.row });
                if (!bc) { mismatch++; continue; }
                if (t.state !== 'revealed') {
                    // Target blank: that board cell must NOT carry a revealed glyph.
                    // Counted as wildMatch (consistency check, not positive evidence).
                    if (bc.state === 'revealed') { mismatch++; continue; }
                    wildMatch++; continue;
                }
                if (bc.state !== 'revealed') { unknown++; continue; }
                if (bc.sig !== t.sig) { mismatch++; continue; }
                realMatch++;
            }
            if (mismatch > 0) continue;
            if (realMatch === 0) continue;

            const clickCol = targetClick.col + ocol, clickRow = targetClick.row + orow;
            const clickCell = boardMap.get(`${clickCol},${clickRow},${targetClick.mirror}`);
            out.push({
                col: refCol, row: refRow,
                cells,
                clickGroup: clickCell ? clickCell.group : null,
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
        return { candidates: out, total: targetCells.length, revealedTotal: revealedTargets.length, anchorHits };
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
        // Same MULTI-ANCHOR placement enumeration as findShapeCandidates (so both
        // share ONE coordinate basis — candidate col/row = the `ref` cell's board
        // position), but accepts a placement with NO mismatch regardless of how many
        // cells matched (realMatch may be 0). Used as the disambiguation fallback.
        const sigCounts = new Map();
        for (const t of revealedTargets) sigCounts.set(t.sig, (sigCounts.get(t.sig) || 0) + 1);
        const anchors = revealedTargets.filter((t) => sigCounts.get(t.sig) === 1);
        const anchorSet = anchors.length ? anchors : [revealedTargets[0]];
        const ref = revealedTargets[0];
        const targetClick = pickClickTarget(revealedTargets);

        const boardCells = readBoardCells();
        const boardMap = makeBoardMap(boardCells);
        const bySigMir = new Map();
        for (const b of boardCells) {
            if (b.state !== 'revealed') continue;
            const k = b.sig + '|' + (b.mirror ? 1 : 0);
            let arr = bySigMir.get(k); if (!arr) bySigMir.set(k, arr = []); arr.push(b);
        }
        const placements = new Map();
        for (const a of anchorSet) {
            const hits = bySigMir.get(a.sig + '|' + (a.mirror ? 1 : 0)) || [];
            for (const b of hits) {
                const key = `${b.col - a.col},${b.row - a.row}`;
                if (!placements.has(key)) placements.set(key, [b.col - a.col, b.row - a.row]);
            }
        }

        const out = [];
        for (const [ocol, orow] of placements.values()) {
            const refCol = ref.col + ocol, refRow = ref.row + orow;
            if (excludeKeys && excludeKeys.has(`${refCol},${refRow}`)) continue;
            let eliminated = false;
            const cells = [];
            for (const t of targetCells) {
                const cc = t.col + ocol, cr = t.row + orow;
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

            const clickCol = targetClick.col + ocol, clickRow = targetClick.row + orow;
            const clickCell = boardMap.get(`${clickCol},${clickRow},${targetClick.mirror}`);
            out.push({
                col: refCol, row: refRow,
                cells,
                clickGroup: clickCell ? clickCell.group : null,
                clickCol, clickRow, clickMirror: targetClick.mirror,
                realMatch: 0, wildMatch: 0, unknown: 0, mismatch: 0,
                match: 0, // alias for logging
                total: targetCells.length,
                revealedTotal: revealedTargets.length,
            });
        }
        return out;
    }

    // Diagnostic for the "cand 0 but anchorHits>0" stall: the anchor glyph IS on
    // the board but the shape fits NOWHERE. Dumps the target shape's layout
    // (relative to the anchor) and, for every board cell carrying the anchor
    // sig+mirror, a per-target-cell outcome string so the geometry break is
    // visible without the DOM. Legend per cell (in target order):
    //   =  match (board revealed, same sig)        #  wrong sig (board revealed, different)
    //   ?  unknown (target revealed, board not)     X  NO board cell at that offset+mirror
    //   .  wildcard ok (target blank, board blank)  !  wildcard violated (target blank, board revealed)
    // All-X rows ⇒ coordinate/parity mapping is off (offsets land off-grid);
    // all-# rows ⇒ glyphs differ (wrong position / sig mis-read); ? ⇒ wait for reveals.
    function diagnoseNoMatch() {
        const targetCells = readTargetCells();
        const revealed = targetCells.filter((c) => c.state === 'revealed');
        if (!revealed.length) return null;
        const sigCounts = new Map();
        for (const t of revealed) sigCounts.set(t.sig, (sigCounts.get(t.sig) || 0) + 1);
        const anchor = revealed.find((t) => sigCounts.get(t.sig) === 1) || revealed[0];
        const boardMap = makeBoardMap(readBoardCells());
        const sigIdx = new Map();
        const sid = (s) => { if (!sigIdx.has(s)) sigIdx.set(s, sigIdx.size); return 'g' + sigIdx.get(s); };
        const shape = targetCells.map((t) => `${t.col - anchor.col},${t.row - anchor.row}/${t.mirror ? 'D' : 'U'}/${t.state[0]}/${t.state === 'revealed' ? sid(t.sig) : '-'}`);
        const hits = readBoardCells().filter((c) => c.state === 'revealed' && c.mirror === anchor.mirror && c.sig === anchor.sig);
        const perHit = hits.map((h) => {
            const out = targetCells.map((t) => {
                const cc = h.col + (t.col - anchor.col), cr = h.row + (t.row - anchor.row);
                const bc = boardMap.get(`${cc},${cr},${t.mirror}`);
                if (!bc) return 'X';
                if (t.state !== 'revealed') return bc.state === 'revealed' ? '!' : '.';
                if (bc.state !== 'revealed') return '?';
                return bc.sig === t.sig ? '=' : '#';
            }).join('');
            return `(${h.col},${h.row})=${out}`;
        });
        return { anchor: `(${anchor.col},${anchor.row})/${anchor.mirror ? 'D' : 'U'}/${sid(anchor.sig)}`, shape, hits: perHit };
    }

    // FULL raw-geometry dump — the data needed to understand the preview's (non-
    // obvious) coordinate encoding and fix the parse instead of guessing. Prints,
    // for BOTH the target preview and the board, each cell's raw `translate`, its
    // tx/ty, the UNROUNDED tx/COL_PX & ty/ROW_PX (so a half-step packing shows as
    // .5), the rounded col/row, mirror, state and a short sig id. Manual trigger:
    //   window.__cor3IceWallDumpGeometry()
    // Also auto-fired once per ~30s while a target is stuck (cand 0).
    function dumpGeometry() {
        const sigIdx = new Map();
        const sid = (s) => { if (!s) return '-'; if (!sigIdx.has(s)) sigIdx.set(s, sigIdx.size); return 'g' + sigIdx.get(s); };
        const parse = (g, tstr) => {
            const t = tstr || '';
            const m = t.match(/translate\(\s*([^,]+),\s*([^)]+)\)/);
            const tx = m ? parseFloat(m[1]) : null;
            const ty = m ? parseFloat(m[2]) : null;
            return {
                tx, ty,
                fc: tx == null ? null : +(tx / COL_PX).toFixed(3),
                fr: ty == null ? null : +(ty / ROW_PX).toFixed(3),
                c: tx == null ? null : Math.round(tx / COL_PX),
                r: ty == null ? null : Math.round(ty / ROW_PX),
                m: /scale\(1\s*,\s*-1\)/.test(t) ? 1 : 0,
                st: cellState(g)[0],
                sig: sid(glyphSignature(g)),
            };
        };
        const target = document.querySelector(SEL.TARGET);
        const wall = document.querySelector(SEL.WALL);
        const tCells = target ? [...target.querySelectorAll(':scope > g')].map((g) => Object.assign(parse(g, g.getAttribute('transform')), { raw: g.getAttribute('transform') })) : [];
        const bCells = wall ? [...wall.querySelectorAll(':scope > g > g')].map((g) => parse(g, g.children[0] && g.children[0].getAttribute('transform'))) : [];
        console.log(`[ICE WALL GEOM] COL_PX=${COL_PX} ROW_PX=${ROW_PX} · TARGET ${tCells.length} cells:`);
        for (let i = 0; i < tCells.length; i++) {
            const c = tCells[i];
            console.log(`  T${i}: tx=${c.tx} ty=${c.ty} | tx/COL=${c.fc} ty/ROW=${c.fr} | col=${c.c} row=${c.r} ${c.m ? 'D' : 'U'} st=${c.st} ${c.sig} | "${c.raw}"`);
        }
        console.log(`[ICE WALL GEOM] BOARD ${bCells.length} cells [tx,ty,col,row,mir,state,sig]:`);
        console.log(JSON.stringify(bCells.map((c) => [c.tx, c.ty, c.c, c.r, c.m, c.st, c.sig])));
        return { target: tCells, board: bCells };
    }
    root.__cor3IceWallDumpGeometry = dumpGeometry;

    // Per-cell board-match readout for an ALREADY-committed candidate (the one we
    // are about to click). Same legend as diagnoseNoMatch, with `*` on the click
    // cell: shows exactly what the matched shape looks like against the board so a
    // "clicked the right cell but counter didn't move" case is inspectable.
    //   =match  #wrong-sig  ?unknown  Xno-cell  .blank-ok  !blank-violated
    function describeCandidate(best) {
        const boardMap = makeBoardMap(readBoardCells());
        const tMap = new Map();
        for (const t of readTargetCells()) tMap.set(`${t.col},${t.row},${t.mirror ? 1 : 0}`, t);
        return (best.cells || []).map((c) => {
            const bc = boardMap.get(`${c.col},${c.row},${c.mirror ? 1 : 0}`);
            const t = tMap.get(`${c.tCol},${c.tRow},${c.mirror ? 1 : 0}`);
            let o;
            if (!bc) o = 'X';
            else if (!t || t.state !== 'revealed') o = (bc.state === 'revealed') ? '!' : '.';
            else if (bc.state !== 'revealed') o = '?';
            else o = (bc.sig === t.sig) ? '=' : '#';
            return `(${c.col},${c.row})${c.mirror ? 'D' : 'U'}${c.isClick ? '*' : ''}:${o}`;
        }).join(' ');
    }
    let lastFieldDumpAt = 0;   // throttle the full field dump fired at commit time

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
    const HUD_ID = 'cor3-icewall-hud';
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
        if (wall) {
            const old = wall.querySelector('#' + OVERLAY_ID);
            if (old) old.remove();
        }
        // The HUD lives in the intro block (outside WALL) — drop it too.
        const hud = document.getElementById(HUD_ID);
        if (hud) hud.remove();
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

    /**
     * Diagnostic HUD — a bright line appended to the intro log block (SEL.INTRO),
     * showing the matcher's live numbers so a stall is screenshot-able:
     *   target Nc      — how many cells the solver READ from the target preview
     *                    (far below the visible preview ⇒ under-reading the shape)
     *   rm X/Y         — best candidate's realMatch / revealed target cells
     *   cand N         — surviving positive candidates (0 ⇒ shape can't be placed)
     *   gate …         — mid / strong / minRevealed thresholds
     * Lives in the intro panel (outside the watched WALL subtree, so it never
     * retriggers the MutationObserver and never overflows the board like the
     * earlier SVG text did). Idempotent + self-healing: re-creates its span if a
     * React re-render drops it, and only writes when the text actually changes.
     */
    function drawHud(text) {
        const host = document.querySelector(SEL.INTRO);
        if (!host) return;
        let span = document.getElementById(HUD_ID);
        if (!text) { if (span) span.remove(); return; }
        if (!span || !host.contains(span)) {
            if (span) span.remove();
            span = document.createElement('span');
            span.id = HUD_ID;
            span.style.cssText = 'color:#7CFF6B;font-weight:700;text-shadow:0 0 4px rgba(0,0,0,0.95);';
            host.appendChild(span);
        }
        if (span.textContent !== text) span.textContent = text;
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

    // Resolve which BOARD cell a viewport pixel actually lands on — for verifying
    // that the click reaches the intended cell (and isn't intercepted by an
    // overlay or off by geometry). Hit-tests with elementFromPoint and walks up to
    // the nearest cell <g> inside the wall, returning "(col,row)U|D" or an <element> tag.
    function cellAtPoint(x, y) {
        const el = document.elementFromPoint(x, y);
        if (!el) return 'none';
        const wall = document.querySelector(SEL.WALL);
        let node = el;
        while (node && node !== document.body) {
            if (node.tagName && node.tagName.toLowerCase() === 'g' && node.children[0]
                && wall && wall.contains(node)) {
                const pos = parseGridPos(node.children[0].getAttribute('transform'));
                if (pos) return `(${pos.col},${pos.row})${pos.mirror ? 'D' : 'U'}`;
            }
            node = node.parentElement;
        }
        return `<${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}>`;
    }

    /**
     * Click dispatch. The May-2026 refactor moved interactivity to
     * pointer events; sending just `click` doesn't trigger the React
     * handler reliably. We fire pointerdown → pointerup → click as a
     * triplet, all at the geometric centre of the cell's bounding
     * triangle. Bounding triangle has pointer-events:auto; if it ever
     * gets pointer-events:none we'd fall back to the parent <g>.
     * Returns { x, y, landed, tag } describing the actual dispatch — the
     * caller logs WANT (intended cell) vs ACTUAL (pixel + the cell that
     * pixel hits) so any divergence is visible.
     */
    async function attemptClick(glyphGroup, mod) {
        const tri = glyphGroup.querySelector(SEL.TRIANGLE);
        const target = tri || glyphGroup;
        if (!target) return null;
        const r = target.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        const landed = cellAtPoint(x, y);   // which cell the pixel hits, BEFORE the click mutates the DOM
        if (mod) mod.debug(`click dispatch: target=<${target.tagName}> at (${x.toFixed(0)},${y.toFixed(0)}) box=${r.width.toFixed(0)}x${r.height.toFixed(0)} landed=${landed}`);
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
        return { x: Math.round(x), y: Math.round(y), landed, tag: target.tagName.toLowerCase() };
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
            let lastDiagAt = 0;   // throttle the no-match per-anchor dump
            let lastGeomAt = 0;   // throttle the full raw-geometry dump

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

                let { candidates, total, revealedTotal, anchorHits } = findShapeCandidates(excludeKeys);
                if (candidates.length === 0 && excludeKeys.size > 0) {
                    // STARVED: a position excluded after a failed click (while it was
                    // still partial) may have since revealed into the ONLY valid match,
                    // but the exclusion never cleared because the board stopped
                    // revealing (excludeKeys clears only on NEW reveals). The DIAG
                    // confirmed this — a full '======' match sitting excluded → cand 0
                    // → hang. Drop the stale per-position exclusions and re-evaluate;
                    // badClicks (per-cell, persistent) still bars the exact cells that
                    // actually failed, so this can't re-earn the same -16s.
                    excludeKeys.clear();
                    ({ candidates, total, revealedTotal, anchorHits } = findShapeCandidates(excludeKeys));
                }

                const best = candidates[0]; // sorted desc by realMatch, then col, row
                const second = candidates[1];
                const bestKey = best ? `${best.col},${best.row}` : null;
                if (bestKey !== lastBestKey) {
                    lastBestKey = bestKey;
                    lastBestSince = Date.now();
                }

                const { strong: strongTh, mid: midTh, minRevealed } = adaptiveThresholds(total);

                // Live diagnostic line (see drawHud). `target ${total}c` is the key
                // tell for under-reading; `anchorHits` (shown only when cand 0)
                // splits sig-mismatch (0) from coordinate-misalignment (>0).
                const a0 = candidates.length === 0 ? ` · anchorHits ${anchorHits || 0}` : '';
                drawHud(`ICE WALL  target ${total}c · revealed ${revealedTotal} · best rm ${best ? best.realMatch : 0}/${revealedTotal} · cand ${candidates.length}${a0} · gate mid${midTh}/str${strongTh}/minRev${minRevealed}`);

                // No positive candidate → clear the stale tentative highlight so the
                // board doesn't show a dashed shape the matcher no longer backs.
                if (candidates.length === 0) {
                    const cl = getLayer('candidate');
                    if (cl) { clearLayerContent(cl); cl.dataset.cor3Key = ''; }
                    // cand 0 BUT the anchor glyph is on the board (anchorHits>0): the
                    // shape can't be placed anywhere → geometry/coordinate mismatch.
                    // Dump the layout + per-anchor outcomes (throttled) to the console
                    // so the break is diagnosable without the DOM.
                    if (anchorHits > 0 && Date.now() - lastDiagAt > 3000) {
                        lastDiagAt = Date.now();
                        const d = diagnoseNoMatch();
                        if (d) {
                            console.log('[ICE WALL DIAG] no-match · anchor', d.anchor, '· shape[', d.shape.join('  '), '] · hits', d.hits);
                            if (logRef) logRef.warn(`DIAG no-match · anchor ${d.anchor} · shape[ ${d.shape.join(' ')} ] · hits ${JSON.stringify(d.hits)}`);
                        }
                        // Auto-emit the full raw geometry once per stall episode so the
                        // preview's coordinate encoding can be read off without manual action.
                        if (Date.now() - lastGeomAt > 30000) { lastGeomAt = Date.now(); try { dumpGeometry(); } catch (_) { /* noop */ } }
                    }
                }

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

    async function solveRound(mod, badClicks) {
        const excludeKeys = new Set();
        // `badClicks` (passed in, owned by watchLoop and reset when the counter
        // advances) is the blacklist of physical board cells (col,row,mirror) we
        // CLICKED for THIS target without the counter advancing — confirmed-wrong
        // selection anchors. A wrong-anchor click is a property of (cell, current
        // target): re-clicking it with the same unsolved target only reproduces the
        // -16s "Pattern mismatch". Unlike excludeKeys it is NEVER cleared on a reveal
        // and PERSISTS across solveRound retries of the same target, so the solver
        // never re-hammers the same wrong glyph.
        const cellKey = (c) => `${c.col},${c.row},${c.mirror ? 1 : 0}`;
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

            // Resolve the click order FIRST (learned → pick → bottom-left, REVEALED
            // board cells only), THEN re-tag the overlay's red "click" cell to the
            // cell we will ACTUALLY click first. The painted isClick came from
            // pickClickTarget on the TARGET preview, but the real first click is
            // candidateClickCells[0] — a learned cell, or a revealed fallback when
            // the pick maps to an unrevealed board cell. Re-tagging keeps "where we
            // want to click" (red) in sync with "where we click" (this was the
            // observed divergence).
            // Click order: learned/PINNED → pick → bottom-left, REVEALED cells only.
            // A PINNED shape yields exactly ONE cell (no brute-force — each miss is a
            // real -16s and the user owns the choice). Drop any cell already proven
            // wrong for THIS target (badClicks) so we never re-click the same glyph.
            const clickCells = candidateClickCells(best).filter((c) => !badClicks.has(cellKey(c)));
            const firstClick = clickCells[0] || null;
            if (clickCells.length === 0) {
                // Every clickable cell of this candidate is already blacklisted →
                // re-clicking would only re-earn -16s. Exclude the anchor & re-search.
                mod.debug(`commit @(${best.col},${best.row}): all ${best.cells.length} cells already blacklisted this target — skipping`);
                excludeKeys.add(`${best.col},${best.row}`);
                continue;
            }

            mod.info(`commit (${reason}): anchor=(${best.col},${best.row}) shape=${best.cells.length} cells realMatch=${best.realMatch}/${best.revealedTotal} unknown=${best.unknown} (target ${best.total}) click=${firstClick ? `(${firstClick.col},${firstClick.row})` : 'none'} cells=${clickCells.length}${firstClick && firstClick.pinned ? ' PINNED' : ''} attempt=${attempt + 1}/${MAX_RETRIES}`);
            // Field dump at commit: the matched shape vs board (per-cell), plus the
            // full raw geometry (throttled). Lets us see WHAT is being clicked and why
            // a correct-looking click may not advance the counter.
            const commitLine = `COMMIT ${reason} @(${best.col},${best.row}) rm ${best.realMatch}/${best.revealedTotal} unk ${best.unknown} click=${firstClick ? `(${firstClick.col},${firstClick.row})` : 'none'} · ${describeCandidate(best)}`;
            console.log(`[ICE WALL ${commitLine}]`);
            mod.info(commitLine);   // also to the Logger (Logs panel · solver-ice-wall)
            if (Date.now() - lastFieldDumpAt > 8000) { lastFieldDumpAt = Date.now(); try { dumpGeometry(); } catch (_) { /* noop */ } }

            // Snapshot the CURRENT (about-to-be-solved) target shape NOW, before any
            // click advances the counter and swaps the preview to the next shape —
            // learnClick must key on this, not the post-advance live target.
            const solvedShape = canonicalShape(readTargetCells());
            let advanced = null;
            for (let ci = 0; ci < clickCells.length; ci++) {
                if (root.__iceWallAbort) return false;
                if (!document.querySelector(SEL.APP)) return false;
                const cell = clickCells[ci];
                // Keep the overlay + HUD on the cell we are ACTUALLY clicking RIGHT
                // NOW — re-tag the red cell per iteration. Previously only the first
                // cell was painted while the brute-force clicked later ones, so "where
                // we show" diverged from "where we click" (the reported bug).
                for (const c of best.cells) c.isClick = (c.col === cell.col && c.row === cell.row && (!!c.mirror === !!cell.mirror));
                drawCandidateOverlay(best, true);
                drawHud(`CLICK ${reason} @(${best.col},${best.row}) · cell (${cell.col},${cell.row}) [${ci + 1}/${clickCells.length}]${cell.pinned ? ' PINNED' : ''} · rm ${best.realMatch}/${best.revealedTotal} · unk ${best.unknown}`);
                const before = readCounter();
                // WANT (the cell we chose) vs ACTUAL (the pixel we dispatch + the cell
                // that pixel actually hits). A ✗ means the click does NOT land on the
                // chosen cell (overlay interception / geometry offset).
                const want = `(${cell.col},${cell.row})${cell.mirror ? 'D' : 'U'}`;
                const src = cell.pinned ? 'pinned' : (cell.isClick ? 'pick' : 'fallback');
                const ac = await attemptClick(cell.group, mod);
                const actual = ac ? `px(${ac.x},${ac.y}) on ${ac.landed}` : 'no-target';
                const ok = ac && ac.landed === want;
                console.log(`[ICE WALL CLICK] WANT ${want} [${src}] → ACTUAL ${actual} ${ok ? '✓' : '✗ MISMATCH'}`);
                mod.info(`click WANT ${want} [${src}] → ACTUAL ${actual} ${ok ? 'OK' : 'MISMATCH'}`);
                advanced = await dom.waitFor(() => {
                    const cc = readCounter();
                    return cc && before && cc.current > before.current ? cc : null;
                }, { timeout: 3000 });
                if (advanced) {
                    mod.info(`counter advanced via cell (${cell.col},${cell.row}): ${advanced.current}/${advanced.total}`);
                    learnClick(cell, solvedShape);   // remember this shape→cell (skipped if pinned)
                    clearOverlay();
                    return true;
                }
                // Clicked, counter didn't move → confirmed-wrong anchor for THIS
                // target. Blacklist the exact cell so it's never clicked again until
                // the target changes (survives the reveal-driven excludeKeys reset).
                badClicks.add(cellKey(cell));
                mod.debug(`click miss (${cell.col},${cell.row}) → blacklisted for this target (${badClicks.size} bad)`);
            }

            mod.warn(`no cell of shape at (${best.col},${best.row}) advanced (${clickCells.length} tried) — excluding & re-searching (${attempt + 1}/${MAX_RETRIES})`);
            drawHud(`NO ADVANCE @(${best.col},${best.row}) · tried ${clickCells.length} cell(s) · target ${best.total}c rm ${best.realMatch} — excluding (${attempt + 1}/${MAX_RETRIES})`);
            excludeKeys.add(`${best.col},${best.row}`);
            drawRejectedOverlay(excludeKeys);
        }
        mod.warn(`exhausted ${MAX_RETRIES} retries on this round`);
        clearOverlay();
        return false;
    }

    async function watchLoop(mod) {
        logRef = mod;   // expose to non-`mod` scopes for Logger-routed diagnostics
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
                        // Per-TARGET click blacklist: persists across solveRound
                        // retries of the SAME target (so a wrong glyph isn't re-clicked
                        // for -16s on every retry), and resets the moment the counter
                        // advances to the next target.
                        let badClicks = new Set();
                        let badTarget = -1;
                        // Solve all rounds within this puzzle
                        while (!root.__iceWallAbort && document.querySelector(SEL.APP)) {
                            const c = readCounter();
                            if (c && c.current >= c.total) {
                                mod.info(`puzzle solved: ${c.current}/${c.total}`);
                                break;
                            }
                            if (c && c.current !== badTarget) { badClicks = new Set(); badTarget = c.current; }
                            const ok = await solveRound(mod, badClicks);
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
            // Lost-wakeup guard: if an owner re-armed us in the narrow window
            // between the abort being detected and this teardown, restart
            // instead of dying (mirrors solver-decrypt).
            if (root.__iceWallOwners && root.__iceWallOwners.size > 0) {
                mod.debug(`owner present after teardown ([${[...root.__iceWallOwners].join(', ')}]) — restarting watch loop`);
                root.__iceWallActive = true;
                watchLoop(mod);
                return;
            }
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

            // Owner-aware lifecycle (mirrors solver-decrypt). Two independent
            // owners can ask this solver to run: 'user' (the standalone Auto
            // ICE WALL toggle, auto-ice-wall.js) and 'flow' (an Auto Jobs flow
            // / the Open-SAI hack path that needs the minigame solved). The
            // watch loop runs while ANY owner is present; a STOP removes only
            // that one owner and aborts the loop only once the set is empty. So
            // a flow ending (owner 'flow') leaves a user's standalone watcher
            // running — but a flow that STARTED it with the user toggle OFF
            // (no 'user' owner) correctly stops it again.
            root.__iceWallOwners = root.__iceWallOwners || new Set();

            this.track(Bus.window.on(MSG.SOLVER.START_ICE_WALL, (env) => {
                const owner = (env && env.owner) ? env.owner : 'user';
                root.__iceWallOwners.add(owner);
                root.__iceWallAbort = false;          // cancel any pending abort
                if (root.__iceWallActive) { this.debug(`start ignored — already active (owner ${owner})`); return; }
                root.__iceWallActive = true;
                this.info(`ice-wall solver started (owner ${owner})`);
                watchLoop(this);
            }));
            this.track(Bus.window.on(MSG.SOLVER.STOP_ICE_WALL, (env) => {
                const owner = (env && env.owner) ? env.owner : 'user';
                root.__iceWallOwners.delete(owner);
                if (root.__iceWallOwners.size > 0) { this.debug(`stop from '${owner}' ignored — still owned by [${[...root.__iceWallOwners].join(', ')}]`); return; }
                root.__iceWallAbort = true;
                this.info(`ice-wall solver stop requested (owner ${owner})`);
            }));
        }
    }

    Registry.register(new IceWallSolverModule());
})();
