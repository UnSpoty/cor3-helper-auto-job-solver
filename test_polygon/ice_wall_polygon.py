#!/usr/bin/env python3
"""
ICE WALL Break test polygon.

Generates ICE WALL puzzles (Porter-lite r4 minigame from cor3.gg) and runs
a Python port of the cor3-helper extension's solver against them.
Visualizes the algorithm's state and collects success statistics.

Mirror of src/modules/solvers/ice-wall.js — see CLAUDE.md / ice-wall.js for
the source-of-truth algorithm description.

Run:
    python3 ice_wall_polygon.py
"""

import random
import time
import tkinter as tk
from dataclasses import dataclass
from typing import Optional


# ─── Geometry ─────────────────────────────────────────────────────────

NUM_ROWS = 10
TRI_W = 22       # half-width of triangle base (board cells)
TRI_H = 38       # triangle height (board cells)
TARGET_TRI_W = 32
TARGET_TRI_H = 56


def all_board_positions():
    """Every (col, row, mirror) on the triangular board. Row r has 2r+1 cells,
    cols (9-r)..(9+r), alternating up (mirror=False), down (mirror=True), …"""
    out = []
    for r in range(NUM_ROWS):
        start = (NUM_ROWS - 1) - r
        for i in range(2 * r + 1):
            col = start + i
            mirror = (i % 2 == 1)
            out.append((col, r, mirror))
    return out


BOARD_POSITIONS = all_board_positions()
BOARD_POS_SET = set(BOARD_POSITIONS)


def cell_polygon(col, row, mirror, tw, th, ox=0, oy=0):
    """Vertices for tk.Canvas.create_polygon."""
    if mirror:
        verts = [
            (col * tw,       (row + 1) * th),
            ((col - 1) * tw, row * th),
            ((col + 1) * tw, row * th),
        ]
    else:
        verts = [
            (col * tw,       row * th),
            ((col - 1) * tw, (row + 1) * th),
            ((col + 1) * tw, (row + 1) * th),
        ]
    flat = []
    for x, y in verts:
        flat.extend([x + ox, y + oy])
    return flat


def cell_center(col, row, mirror, tw, th, ox=0, oy=0):
    if mirror:
        cx = col * tw
        cy = row * th + th * 2 / 3
    else:
        cx = col * tw
        cy = row * th + th * 1 / 3
    return cx + ox, cy + oy


# ─── Models ───────────────────────────────────────────────────────────

@dataclass
class Cell:
    col: int
    row: int
    mirror: bool
    state: str = 'placeholder'   # 'empty' | 'placeholder' | 'revealed'
    glyph: Optional[str] = None
    future_glyph: Optional[str] = None  # what this cell reveals as (None = stays placeholder)


@dataclass
class Puzzle:
    board: list
    target: list
    solution_anchor_col: int     # board (col, row) where target's (0,0) lands
    solution_anchor_row: int
    target_click_col: int        # ground-truth click cell on board
    target_click_row: int
    target_click_mirror: bool


# ─── Puzzle generation ────────────────────────────────────────────────

GLYPH_POOL = [
    '▲', '▼', '◆', '●', '■', '★', '♥', '♣', '♦', '♠',
    '⬢', '⬣', '⬡', '✦', '✧', '✪', '✶', '❀', '❁', '❄',
    '◉', '◐', '◑', '◒', '◓', '◔',
    'Δ', 'Σ', 'Ω', 'Φ', '∞', '§', '¶', '∮',
]
GLYPH_FONT = ('DejaVu Sans', 13, 'bold')
GLYPH_FONT_TARGET = ('DejaVu Sans', 18, 'bold')


def _tri_neighbors(c, r, m):
    """Edge-adjacent triangles in the triangular grid (3 per cell)."""
    if not m:  # up
        return [(c - 1, r, True), (c + 1, r, True), (c, r + 1, True)]
    else:      # down
        return [(c - 1, r, False), (c + 1, r, False), (c, r - 1, False)]


def shape_arbitrary(rng, size):
    """Generate a random connected shape of `size` triangular cells.

    We do NOT assume any specific shape (triangle, rhombus, etc.) — the
    matcher is shape-agnostic, it iterates over whatever cells are in the
    target. The generator just walks the triangular grid from a random
    up-cell, picking neighbours until we have `size` cells.

    Normalized so first cell becomes (0,0,up). The triangular-grid mirror
    invariant `mirror == ((col + row) % 2 == 1)` is preserved by any
    translation rooted at an up-cell.
    """
    if size < 1:
        raise ValueError("size must be >= 1")
    valid_starts = [(c, r) for (c, r, m) in BOARD_POSITIONS if not m]
    # Try a few starts in case the chosen one can't grow to `size`.
    for _ in range(8):
        sc, sr = rng.choice(valid_starts)
        start = (sc, sr, False)
        chosen = [start]
        chosen_set = {start}
        frontier = [n for n in _tri_neighbors(*start) if n in BOARD_POS_SET]
        while len(chosen) < size and frontier:
            idx = rng.randrange(len(frontier))
            nxt = frontier.pop(idx)
            if nxt in chosen_set:
                continue
            chosen.append(nxt)
            chosen_set.add(nxt)
            for n in _tri_neighbors(*nxt):
                if n in BOARD_POS_SET and n not in chosen_set:
                    frontier.append(n)
        if len(chosen) == size:
            return [(c - sc, r - sr, m) for (c, r, m) in chosen]
    raise RuntimeError(f"could not grow connected shape of size {size}")


def can_place_shape(anchor_col, anchor_row, shape):
    for (oc, orr, om) in shape:
        if (anchor_col + oc, anchor_row + orr, om) not in BOARD_POS_SET:
            return False
    return True


def pick_click_target_offsets(shape_offsets):
    """Same rule as JS pickClickTarget but on (col, row, mirror) tuples relative to (0,0)."""
    cx = sum(c for c, r, m in shape_offsets) / len(shape_offsets)
    cy = sum(r for c, r, m in shape_offsets) / len(shape_offsets)
    def key(t):
        c, r, m = t
        d = (c - cx) ** 2 + (r - cy) ** 2
        # prefer UP (mirror=False), then lower row, then leftmost col
        return (d, m, -r, c)
    return min(shape_offsets, key=key)


def generate_puzzle(num_wildcards=2, target_size=9, seed=None,
                     custom_shape=None, custom_wildcards=None):
    """Generate a puzzle with a target shape of `target_size` cells (or
    `custom_shape` when provided).

    The shape is arbitrary (any connected pattern in the triangular grid) —
    the matcher does not assume triangles or any fixed layout, it derives
    the shape dynamically from the target preview.

    In line with the actual ICE WALL game:
      - target cells are 'revealed' from the start (with their final glyph),
        except wildcard cells which stay 'placeholder' forever;
      - only BOARD cells reveal gradually over time.
    """
    rng = random.Random(seed)

    # 1. Pick / accept shape
    if custom_shape is not None:
        shape = list(custom_shape)
    else:
        shape = shape_arbitrary(rng, target_size)

    # 2. Choose anchor: any board position where the shape fits.
    # The first shape cell is the placement anchor; its mirror dictates which
    # board mirror the anchor must land on (works for both up- and down-anchors).
    valid_anchors = []
    for (col, row, mirror) in BOARD_POSITIONS:
        if mirror != shape[0][2]:
            continue
        if all((col + oc, row + orr, om) in BOARD_POS_SET
               for (oc, orr, om) in shape):
            valid_anchors.append((col, row))
    if not valid_anchors:
        raise RuntimeError("No valid anchor positions for shape")
    anchor_col, anchor_row = rng.choice(valid_anchors)

    # 3. Pick wildcard indices
    if custom_wildcards is not None:
        wildcards = set(custom_wildcards)
    else:
        wildcards = set(rng.sample(range(len(shape)),
                                    min(num_wildcards, len(shape) - 1)))

    # Need at least one revealed (non-wildcard) target cell — algorithm
    # cannot anchor on a pure-wildcard target.
    if all(i in wildcards for i in range(len(shape))):
        wildcards.discard(next(iter(wildcards)))

    # 4. Assign unique glyphs to non-wildcard cells. Sample from a pool large
    # enough to make accidental cross-board matches rare.
    glyphs = rng.sample(GLYPH_POOL, len(shape))
    target_cells = []
    for i, (oc, orr, om) in enumerate(shape):
        if i in wildcards:
            # Wildcard: shown as placeholder in the target preview from start.
            target_cells.append(Cell(oc, orr, om, state='placeholder',
                                      glyph=None, future_glyph=None))
        else:
            # Revealed target cell: visible from start with its final glyph.
            target_cells.append(Cell(oc, orr, om, state='revealed',
                                      glyph=glyphs[i], future_glyph=glyphs[i]))

    # 5. Build board cells, predetermining each cell's future_glyph.
    target_offset_to_glyph = {}
    for i, (oc, orr, om) in enumerate(shape):
        target_offset_to_glyph[(oc, orr, om)] = None if i in wildcards else glyphs[i]

    board = []
    for (col, row, mirror) in BOARD_POSITIONS:
        rel = (col - anchor_col, row - anchor_row, mirror)
        if rel in target_offset_to_glyph:
            fg = target_offset_to_glyph[rel]
        else:
            fg = rng.choice(GLYPH_POOL)
        board.append(Cell(col, row, mirror, state='placeholder', future_glyph=fg))

    # 5. Ground-truth click target
    click_off = pick_click_target_offsets(shape)
    click_col = anchor_col + click_off[0]
    click_row = anchor_row + click_off[1]
    click_mirror = click_off[2]

    return Puzzle(
        board=board, target=target_cells,
        solution_anchor_col=anchor_col, solution_anchor_row=anchor_row,
        target_click_col=click_col, target_click_row=click_row,
        target_click_mirror=click_mirror,
    )


def build_reveal_queue(puzzle, rng):
    """Shuffled list of BOARD cells that reveal over time. Target cells are
    already in their final state (revealed-with-glyph or wildcard placeholder)
    and stay frozen, matching the real game where the target preview is fully
    visible from the start."""
    queue = [c for c in puzzle.board
             if c.future_glyph is not None and c.state == 'placeholder']
    rng.shuffle(queue)
    return queue


# ─── Algorithm port (mirror of ice-wall.js) ───────────────────────────

# JS-original thresholds were tuned for total=9 cells (55% / 33%). For
# arbitrary target sizes we scale them proportionally — keep a floor so
# tiny targets still demand high % match, and the ratio dominates for
# larger targets to avoid premature commit.
STRONG_PARTIAL_MATCH = 5     # absolute floor
MIN_PARTIAL_MATCH = 3        # absolute floor
STRONG_PARTIAL_RATIO = 0.55
MIN_PARTIAL_RATIO = 0.33
MAX_RETRIES = 20


def adaptive_thresholds(total):
    """Returns (strong, mid) thresholds adapted to target size. The matcher
    is shape-agnostic; thresholds need to scale so partial-match heuristics
    stay meaningful for sizes other than the JS-default 9."""
    strong = max(STRONG_PARTIAL_MATCH, round(total * STRONG_PARTIAL_RATIO))
    mid = max(MIN_PARTIAL_MATCH, round(total * MIN_PARTIAL_RATIO))
    return strong, mid


def pick_click_target(target_cells):
    if not target_cells:
        return None
    cx = sum(c.col for c in target_cells) / len(target_cells)
    cy = sum(c.row for c in target_cells) / len(target_cells)
    def key(c):
        d = (c.col - cx) ** 2 + (c.row - cy) ** 2
        return (d, c.mirror, -c.row, c.col)
    return min(target_cells, key=key)


def _select_anchor(revealed_targets):
    counts = {}
    for t in revealed_targets:
        counts[t.glyph] = counts.get(t.glyph, 0) + 1
    for t in revealed_targets:
        if counts[t.glyph] == 1:
            return t
    return revealed_targets[0]


def find_shape_candidates(target_cells, board_cells, exclude_keys=None):
    if not target_cells:
        return [], 0, 0
    revealed_targets = [c for c in target_cells if c.state == 'revealed']
    if not revealed_targets:
        return [], len(target_cells), 0

    anchor_t = _select_anchor(revealed_targets)
    click_t = pick_click_target(target_cells)
    board_map = {(c.col, c.row, c.mirror): c for c in board_cells}

    out = []
    for cand in board_cells:
        if cand.state != 'revealed':
            continue
        if cand.mirror != anchor_t.mirror:
            continue
        if cand.glyph != anchor_t.glyph:
            continue
        if exclude_keys and (cand.col, cand.row) in exclude_keys:
            continue

        match = mismatch = unknown = 0
        cells = []
        for t in target_cells:
            cc = cand.col + (t.col - anchor_t.col)
            cr = cand.row + (t.row - anchor_t.row)
            bc = board_map.get((cc, cr, t.mirror))
            cells.append({'col': cc, 'row': cr, 'mirror': t.mirror, 'is_click': t is click_t})
            if bc is None:
                mismatch += 1
                continue
            if t.state != 'revealed':
                # Wildcard position — board must NOT be revealed
                if bc.state == 'revealed':
                    mismatch += 1
                    continue
                match += 1
                continue
            if bc.state != 'revealed':
                unknown += 1
                continue
            if bc.glyph != t.glyph:
                mismatch += 1
                continue
            match += 1

        if mismatch > 0:
            continue
        if match == 0:
            continue

        click_col = cand.col + (click_t.col - anchor_t.col)
        click_row = cand.row + (click_t.row - anchor_t.row)
        out.append({
            'anchor_col': cand.col, 'anchor_row': cand.row,
            'click_col': click_col, 'click_row': click_row,
            'click_mirror': click_t.mirror,
            'cells': cells,
            'match': match, 'unknown': unknown, 'mismatch': mismatch,
            'total': len(target_cells),
        })
    out.sort(key=lambda c: -c['match'])
    return out, len(target_cells), len(revealed_targets)


def find_by_elimination(target_cells, board_cells, exclude_keys=None):
    if not target_cells:
        return []
    revealed_targets = [c for c in target_cells if c.state == 'revealed']
    if not revealed_targets:
        return []
    anchor_t = _select_anchor(revealed_targets)
    click_t = pick_click_target(target_cells)
    board_map = {(c.col, c.row, c.mirror): c for c in board_cells}

    out = []
    for cand in board_cells:
        if cand.state != 'revealed':
            continue
        if cand.mirror != anchor_t.mirror:
            continue
        if cand.glyph != anchor_t.glyph:
            continue
        if exclude_keys and (cand.col, cand.row) in exclude_keys:
            continue

        eliminated = False
        cells = []
        for t in target_cells:
            cc = cand.col + (t.col - anchor_t.col)
            cr = cand.row + (t.row - anchor_t.row)
            bc = board_map.get((cc, cr, t.mirror))
            cells.append({'col': cc, 'row': cr, 'mirror': t.mirror, 'is_click': t is click_t})
            if bc is None:
                eliminated = True
                break
            if t.state != 'revealed':
                if bc.state == 'revealed':
                    eliminated = True
                    break
                continue
            if bc.state == 'revealed' and bc.glyph != t.glyph:
                eliminated = True
                break
        if eliminated:
            continue

        click_col = cand.col + (click_t.col - anchor_t.col)
        click_row = cand.row + (click_t.row - anchor_t.row)
        out.append({
            'anchor_col': cand.col, 'anchor_row': cand.row,
            'click_col': click_col, 'click_row': click_row,
            'click_mirror': click_t.mirror,
            'cells': cells,
            'match': 0, 'unknown': 0, 'mismatch': 0,
            'total': len(target_cells),
        })
    return out


def algorithm_step(target_cells, board_cells, exclude_keys):
    """Returns dict with keys:
        'decision': 'commit' | 'wait'
        'candidate': best/tentative candidate (or None)
        'reason': 'complete' | 'strong-partial' | 'unique-partial' |
                  'dominant-partial' | 'elimination' | None (when waiting)
        'all_candidates': list of positive candidates (for visualization)
    """
    candidates, total, _ = find_shape_candidates(target_cells, board_cells, exclude_keys)
    strong_th, mid_th = adaptive_thresholds(total)

    # 1. Full match
    for c in candidates:
        if c['match'] == total:
            return {'decision': 'commit', 'candidate': c, 'reason': 'complete',
                    'all_candidates': candidates}

    best = candidates[0] if candidates else None
    second = candidates[1] if len(candidates) > 1 else None

    if best and best['match'] >= strong_th:
        return {'decision': 'commit', 'candidate': best, 'reason': 'strong-partial',
                'all_candidates': candidates}

    if best and best['match'] >= mid_th:
        is_unique = len(candidates) == 1
        is_dominant = (second is None) or (best['match'] - second['match'] >= 2)
        if is_unique or is_dominant:
            return {'decision': 'commit', 'candidate': best,
                    'reason': 'unique-partial' if is_unique else 'dominant-partial',
                    'all_candidates': candidates}

    if not candidates:
        elim = find_by_elimination(target_cells, board_cells, exclude_keys)
        if len(elim) == 1:
            return {'decision': 'commit', 'candidate': elim[0], 'reason': 'elimination',
                    'all_candidates': []}

    return {'decision': 'wait', 'candidate': best, 'reason': None,
            'all_candidates': candidates}


def click_is_correct(puzzle, click_col, click_row, click_mirror):
    return (click_col, click_row, click_mirror) == (
        puzzle.target_click_col, puzzle.target_click_row, puzzle.target_click_mirror
    )


# ─── Tk UI ────────────────────────────────────────────────────────────

# Visual palette
BG = '#0B1622'
COLOR_EMPTY = '#0F1F2E'
COLOR_PLACEHOLDER_FILL = '#142B3D'
COLOR_PLACEHOLDER_OUTLINE = '#76C1D1'
COLOR_REVEALED_FILL = '#1B3850'
COLOR_GLYPH = '#76C1D1'
COLOR_TENTATIVE = '#FFE066'
COLOR_CONFIDENT = '#FFB857'
COLOR_CLICK = '#FF3333'
COLOR_GROUND_TRUTH = '#36F39E'


class PatternEditorWindow:
    """Modal-ish editor for drawing a custom target pattern on a triangular grid.

    Left-click toggles a cell as "revealed" (part of the pattern).
    Right-click marks a cell as a wildcard (✱) — accepted by the matcher
    regardless of which glyph lands at that position on the board.

    On Apply, the chosen cells are normalized so the first revealed cell
    becomes (0,0) and handed to the parent as (shape, wildcards) where
    `shape` is a list of (col, row, mirror) and `wildcards` is the list of
    indices of wildcard cells within `shape`.
    """

    GRID_TRI_W = 32
    GRID_TRI_H = 56
    CANVAS_W = 620
    CANVAS_H = 480
    # Visible editor area — rows 0..6, cols -3..3 gives 49 valid offsets.
    ROW_RANGE = range(0, 7)
    COL_RANGE = range(-3, 4)

    def __init__(self, parent_root, on_apply,
                 initial_shape=None, initial_wildcards=None):
        self.on_apply = on_apply
        # cells: (col, row, mirror) -> 'revealed' | 'wildcard'
        self.cells = {}
        if initial_shape:
            wc_set = set(initial_wildcards or [])
            for i, (c, r, m) in enumerate(initial_shape):
                self.cells[(c, r, m)] = 'wildcard' if i in wc_set else 'revealed'
        else:
            # Seed with the anchor cell so the editor isn't empty on open.
            self.cells[(0, 0, False)] = 'revealed'

        self.top = tk.Toplevel(parent_root)
        self.top.title('Pattern Editor — draw your target shape')
        self.top.configure(bg=BG)
        self.top.transient(parent_root)
        self.top.grab_set()
        self._build_ui()
        self.refresh()

    # ── UI ─────────────────────────────────────────────────────────────

    def _build_ui(self):
        header = tk.Frame(self.top, bg=BG)
        header.pack(fill=tk.X, padx=10, pady=(10, 4))
        tk.Label(header, text='✎  Pattern Editor', bg=BG, fg='#E8F1F8',
                 font=('DejaVu Sans', 14, 'bold')).pack(side=tk.LEFT)
        tk.Label(header, text='   Left-click: toggle cell   ·   Right-click: toggle ✱ wildcard',
                 bg=BG, fg='#A8C7E0').pack(side=tk.LEFT, padx=12)

        self.info_var = tk.StringVar()
        tk.Label(self.top, textvariable=self.info_var, bg=BG, fg='#FFB857',
                 font=('DejaVu Sans', 11, 'bold')).pack(pady=(0, 4))

        # Canvas
        self.canvas = tk.Canvas(self.top, bg=BG,
                                 width=self.CANVAS_W, height=self.CANVAS_H,
                                 highlightthickness=0)
        self.canvas.pack(padx=10, pady=4)
        self.canvas.bind('<Button-1>', self._on_left)
        self.canvas.bind('<Button-3>', self._on_right)

        # Legend
        legend = tk.Frame(self.top, bg=BG)
        legend.pack(pady=(2, 2))
        tk.Label(legend, text='● revealed', bg=BG, fg=COLOR_GLYPH,
                 font=('DejaVu Sans', 10, 'bold')).pack(side=tk.LEFT, padx=8)
        tk.Label(legend, text='✱ wildcard', bg=BG, fg=COLOR_CONFIDENT,
                 font=('DejaVu Sans', 10, 'bold')).pack(side=tk.LEFT, padx=8)
        tk.Label(legend, text='○ empty (click to add)', bg=BG, fg='#446B82',
                 font=('DejaVu Sans', 10)).pack(side=tk.LEFT, padx=8)

        # Buttons
        btns = tk.Frame(self.top, bg=BG)
        btns.pack(pady=(6, 12))

        def mk(text, cmd, **kw):
            return tk.Button(btns, text=text, command=cmd,
                              font=('DejaVu Sans', 11, 'bold'),
                              relief=tk.FLAT, padx=12, pady=6, **kw)

        mk('🗙  Clear', self._on_clear,
            bg='#3A2A2A', fg='#E8C9C9').pack(side=tk.LEFT, padx=6)
        mk('✕  Cancel', self.top.destroy,
            bg='#2A4156', fg='#E8F1F8').pack(side=tk.LEFT, padx=6)
        mk('✓  Apply', self._on_apply_clicked,
            bg='#1F6B35', fg='white').pack(side=tk.LEFT, padx=6)

    # ── Coordinates ────────────────────────────────────────────────────

    def _origin(self):
        # Anchor (0,0,False) gets its apex at the top-center of the canvas.
        return self.CANVAS_W / 2, 40

    def _grid_positions(self):
        for r in self.ROW_RANGE:
            for c in self.COL_RANGE:
                mirror = ((c + r) % 2 == 1)
                yield (c, r, mirror)

    def _hit_test(self, x, y):
        ox, oy = self._origin()
        best = None
        bd = float('inf')
        for pos in self._grid_positions():
            cx, cy = cell_center(pos[0], pos[1], pos[2],
                                  self.GRID_TRI_W, self.GRID_TRI_H, ox, oy)
            d = (x - cx) ** 2 + (y - cy) ** 2
            if d < bd:
                bd = d
                best = pos
        # Cap: must be reasonably close to a cell center
        if bd > (self.GRID_TRI_W ** 2) * 1.2:
            return None
        return best

    # ── Event handlers ─────────────────────────────────────────────────

    def _on_left(self, event):
        pos = self._hit_test(event.x, event.y)
        if pos is None:
            return
        if pos in self.cells:
            del self.cells[pos]
        else:
            self.cells[pos] = 'revealed'
        self.refresh()

    def _on_right(self, event):
        pos = self._hit_test(event.x, event.y)
        if pos is None:
            return
        cur = self.cells.get(pos)
        if cur is None or cur == 'revealed':
            self.cells[pos] = 'wildcard'
        else:
            self.cells[pos] = 'revealed'
        self.refresh()

    def _on_clear(self):
        self.cells = {}
        self.refresh()

    def _on_apply_clicked(self):
        revealed = [(c, r, m) for (c, r, m), v in self.cells.items() if v == 'revealed']
        wildcard = [(c, r, m) for (c, r, m), v in self.cells.items() if v == 'wildcard']
        if not revealed:
            self.info_var.set('⚠ Need at least one revealed cell — pure-wildcard targets cannot be anchored.')
            return

        # Normalize so the first revealed cell becomes (0,0) — its mirror
        # may be either up or down; the matcher copes with either anchor.
        revealed.sort(key=lambda p: (p[1], p[0]))   # top-to-bottom, left-to-right
        ac = revealed[0]
        sc, sr, sm = ac
        shape = [(0, 0, sm)]
        wildcards_idx = []
        for (c, r, m) in revealed[1:]:
            shape.append((c - sc, r - sr, m))
        for (c, r, m) in wildcard:
            wildcards_idx.append(len(shape))
            shape.append((c - sc, r - sr, m))

        # Sanity: every shape offset must be placeable somewhere on the board.
        # Try to find any valid anchor.
        ok = False
        for (col, row, mirror) in BOARD_POSITIONS:
            if mirror != shape[0][2]:
                continue
            if all((col + oc, row + orr, om) in BOARD_POS_SET
                   for (oc, orr, om) in shape):
                ok = True
                break
        if not ok:
            self.info_var.set('⚠ Shape too large or off-grid — does not fit on the 10-row board anywhere.')
            return

        # Pool size constraint: each non-wildcard cell needs a unique glyph
        if len(shape) > len(GLYPH_POOL):
            self.info_var.set(f'⚠ Too many cells ({len(shape)}) — glyph pool only has {len(GLYPH_POOL)}.')
            return

        self.on_apply(shape, wildcards_idx)
        self.top.destroy()

    # ── Drawing ────────────────────────────────────────────────────────

    def refresh(self):
        c = self.canvas
        c.delete('all')
        ox, oy = self._origin()

        for (col, row, mirror) in self._grid_positions():
            poly = cell_polygon(col, row, mirror,
                                 self.GRID_TRI_W, self.GRID_TRI_H, ox, oy)
            state = self.cells.get((col, row, mirror))
            if state == 'revealed':
                c.create_polygon(*poly, fill=COLOR_REVEALED_FILL,
                                  outline=COLOR_GLYPH, width=2)
                cx, cy = cell_center(col, row, mirror,
                                      self.GRID_TRI_W, self.GRID_TRI_H, ox, oy)
                c.create_text(cx, cy, text='●', fill=COLOR_GLYPH,
                              font=('DejaVu Sans', 14, 'bold'))
            elif state == 'wildcard':
                c.create_polygon(*poly, fill='#1A2030',
                                  outline=COLOR_CONFIDENT, width=2,
                                  dash=(4, 3))
                cx, cy = cell_center(col, row, mirror,
                                      self.GRID_TRI_W, self.GRID_TRI_H, ox, oy)
                c.create_text(cx, cy, text='✱', fill=COLOR_CONFIDENT,
                              font=('DejaVu Sans', 14, 'bold'))
            else:
                c.create_polygon(*poly, fill=BG,
                                  outline='#2A4156', width=1)

        # Anchor hint: outline (0,0,False) subtly
        poly = cell_polygon(0, 0, False, self.GRID_TRI_W, self.GRID_TRI_H, ox, oy)
        c.create_polygon(*poly, fill='', outline=COLOR_GROUND_TRUTH,
                          width=1, dash=(2, 4))

        n = len(self.cells)
        nw = sum(1 for v in self.cells.values() if v == 'wildcard')
        nr = n - nw
        self.info_var.set(f'{n} cells   ·   {nr} revealed   ·   {nw} ✱ wildcards')


class IceWallPolygonApp:
    def __init__(self, root):
        self.root = root
        root.title('ICE WALL Break — Test Polygon')
        root.configure(bg=BG)
        root.geometry('1180x780')

        self.puzzle = None
        self.reveal_queue = []
        self.exclude_keys = set()
        self.rng = random.Random()
        self.running = False
        self.start_time = None
        self.attempts = 0
        self.reveals_done = 0
        self.last_result = None
        self.solved = False
        self.failed = False
        self.last_reveal_ms = 0
        self.batch_stats = None
        self.log_lines = []

        # Custom pattern state (set via the Pattern Editor)
        self.custom_shape = None        # list of (col, row, mirror) offsets
        self.custom_wildcards = None    # list of indices into custom_shape

        # Stats across runs
        self.stats_total = 0
        self.stats_solved = 0
        self.stats_false_positives_total = 0
        self.stats_attempts_total = 0
        self.stats_reveals_at_solve_total = 0
        self.stats_wrong_clicks = 0

        self._build_ui()
        self.new_puzzle()

    # ─── UI construction ──────────────────────────────────────────────

    def _build_ui(self):
        # Two-row control bar — playback on top, generation params below.
        ctrl_top = tk.Frame(self.root, bg=BG)
        ctrl_top.pack(side=tk.TOP, fill=tk.X, padx=8, pady=(6, 2))
        ctrl_bot = tk.Frame(self.root, bg=BG)
        ctrl_bot.pack(side=tk.TOP, fill=tk.X, padx=8, pady=(2, 6))

        btn_font = ('DejaVu Sans', 11, 'bold')

        def make_btn(parent, text, cmd, **kw):
            return tk.Button(parent, text=text, command=cmd, font=btn_font,
                             activebackground='#2A4A66', relief=tk.FLAT,
                             borderwidth=1, padx=8, pady=4, **kw)

        # ── Top row: playback controls ──
        self.btn_new = make_btn(ctrl_top, '⟳  New', self.new_puzzle,
                                 bg='#243A50', fg='#E8F1F8')
        self.btn_new.pack(side=tk.LEFT, padx=2)
        self.btn_start = make_btn(ctrl_top, '▶  Start', self.start,
                                   bg='#1F6B35', fg='white')
        self.btn_start.pack(side=tk.LEFT, padx=2)
        self.btn_pause = make_btn(ctrl_top, '⏸  Pause', self.pause,
                                   bg='#6B4F1F', fg='white')
        self.btn_pause.pack(side=tk.LEFT, padx=2)
        self.btn_step = make_btn(ctrl_top, '⏵  Step', self.step,
                                  bg='#2A4156', fg='#E8F1F8')
        self.btn_step.pack(side=tk.LEFT, padx=2)

        tk.Frame(ctrl_top, bg='#1A2B3D', width=2, height=24).pack(side=tk.LEFT, padx=8)

        tk.Label(ctrl_top, text='⏱', bg=BG, fg='#9FB7C9',
                 font=('DejaVu Sans', 12)).pack(side=tk.LEFT)
        tk.Label(ctrl_top, text='Reveal (ms):', bg=BG, fg='#A8C7E0').pack(side=tk.LEFT, padx=(2, 4))
        self.var_interval = tk.IntVar(value=1000)
        tk.Spinbox(ctrl_top, from_=50, to=5000, increment=50,
                    textvariable=self.var_interval, width=6).pack(side=tk.LEFT, padx=2)

        tk.Frame(ctrl_top, bg='#1A2B3D', width=2, height=24).pack(side=tk.LEFT, padx=8)

        # Batch controls live on the top row, far right
        tk.Label(ctrl_top, text='⚡', bg=BG, fg='#9FB7C9',
                 font=('DejaVu Sans', 12)).pack(side=tk.LEFT)
        tk.Label(ctrl_top, text='Batch:', bg=BG, fg='#A8C7E0').pack(side=tk.LEFT, padx=(2, 4))
        self.var_batch_n = tk.IntVar(value=200)
        tk.Spinbox(ctrl_top, from_=10, to=5000, increment=10,
                    textvariable=self.var_batch_n, width=6).pack(side=tk.LEFT, padx=2)
        make_btn(ctrl_top, '⚡  Run', self.run_batch,
                  bg='#5C3D8C', fg='white').pack(side=tk.LEFT, padx=2)
        make_btn(ctrl_top, '✕  Reset Stats', self.reset_stats,
                  bg='#3A2A2A', fg='#E8C9C9').pack(side=tk.LEFT, padx=2)

        # ── Bottom row: target / pattern config ──
        tk.Label(ctrl_bot, text='✱', bg=BG, fg='#FFB857',
                 font=('DejaVu Sans', 12)).pack(side=tk.LEFT)
        tk.Label(ctrl_bot, text='Wildcards:', bg=BG, fg='#A8C7E0').pack(side=tk.LEFT, padx=(2, 4))
        self.var_wildcards = tk.IntVar(value=2)
        tk.Spinbox(ctrl_bot, from_=0, to=8, textvariable=self.var_wildcards,
                    width=4).pack(side=tk.LEFT, padx=2)

        tk.Frame(ctrl_bot, bg='#1A2B3D', width=2, height=24).pack(side=tk.LEFT, padx=8)

        tk.Label(ctrl_bot, text='◆', bg=BG, fg='#76C1D1',
                 font=('DejaVu Sans', 11)).pack(side=tk.LEFT)
        tk.Label(ctrl_bot, text='Target cells (min..max):', bg=BG, fg='#A8C7E0').pack(side=tk.LEFT, padx=(2, 4))
        self.var_size_min = tk.IntVar(value=6)
        tk.Spinbox(ctrl_bot, from_=3, to=20, textvariable=self.var_size_min,
                    width=4).pack(side=tk.LEFT, padx=1)
        tk.Label(ctrl_bot, text='..', bg=BG, fg='#A8C7E0').pack(side=tk.LEFT)
        self.var_size_max = tk.IntVar(value=12)
        tk.Spinbox(ctrl_bot, from_=3, to=20, textvariable=self.var_size_max,
                    width=4).pack(side=tk.LEFT, padx=1)

        tk.Frame(ctrl_bot, bg='#1A2B3D', width=2, height=24).pack(side=tk.LEFT, padx=8)

        # Custom pattern controls
        make_btn(ctrl_bot, '✎  Draw Pattern', self.open_pattern_editor,
                  bg='#4A4A8C', fg='white').pack(side=tk.LEFT, padx=2)
        self.pattern_status_var = tk.StringVar(value='Pattern: random')
        tk.Label(ctrl_bot, textvariable=self.pattern_status_var,
                 bg=BG, fg='#A8C7E0', padx=8).pack(side=tk.LEFT)
        self.btn_clear_pattern = make_btn(ctrl_bot, '✕  Clear', self.clear_custom_pattern,
                                            bg='#3A2A2A', fg='#E8C9C9')
        self.btn_clear_pattern.pack(side=tk.LEFT, padx=2)

        # Main area: board (left), right column (target + stats + log)
        main = tk.Frame(self.root, bg=BG)
        main.pack(fill=tk.BOTH, expand=True, padx=8, pady=4)

        # Board canvas
        board_frame = tk.LabelFrame(main, text='Board', bg=BG, fg='white', labelanchor='n')
        board_frame.pack(side=tk.LEFT, fill=tk.BOTH, expand=True, padx=(0, 4))
        self.board_canvas = tk.Canvas(board_frame, bg=BG, highlightthickness=0,
                                       width=520, height=440)
        self.board_canvas.pack(fill=tk.BOTH, expand=True, padx=8, pady=8)

        # Right column
        right = tk.Frame(main, bg=BG, width=560)
        right.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        right.pack_propagate(False)

        target_frame = tk.LabelFrame(right, text='Target Preview', bg=BG, fg='white', labelanchor='n')
        target_frame.pack(side=tk.TOP, fill=tk.X)
        self.target_canvas = tk.Canvas(target_frame, bg=BG, highlightthickness=0,
                                        width=540, height=240)
        self.target_canvas.pack(padx=8, pady=8)

        # Stats panel
        stats_frame = tk.LabelFrame(right, text='Statistics', bg=BG, fg='white', labelanchor='n')
        stats_frame.pack(side=tk.TOP, fill=tk.X, pady=(6, 0))
        self.stats_text = tk.Text(stats_frame, height=8, bg='#0E1B28', fg='#A8C7E0',
                                   font=('monospace', 10), borderwidth=0)
        self.stats_text.pack(fill=tk.X, padx=8, pady=8)

        # Log
        log_frame = tk.LabelFrame(right, text='Log', bg=BG, fg='white', labelanchor='n')
        log_frame.pack(side=tk.TOP, fill=tk.BOTH, expand=True, pady=(6, 0))
        self.log_text = tk.Text(log_frame, bg='#0E1B28', fg='#A8C7E0',
                                 font=('monospace', 9), borderwidth=0, wrap='word')
        self.log_text.pack(fill=tk.BOTH, expand=True, padx=8, pady=8)

        # Status bar
        self.status_var = tk.StringVar(value='Ready.')
        tk.Label(self.root, textvariable=self.status_var, bg='#08111B', fg='#9FB7C9',
                 anchor='w').pack(side=tk.BOTTOM, fill=tk.X)

    # ─── Logging / stats display ──────────────────────────────────────

    def log(self, msg):
        ts = time.strftime('%H:%M:%S')
        line = f'[{ts}] {msg}'
        self.log_lines.append(line)
        if len(self.log_lines) > 500:
            self.log_lines = self.log_lines[-400:]
        self.log_text.delete('1.0', tk.END)
        self.log_text.insert(tk.END, '\n'.join(self.log_lines[-200:]))
        self.log_text.see(tk.END)

    def render_stats(self):
        total = self.stats_total
        solved = self.stats_solved
        rate = (solved / total * 100) if total else 0.0
        avg_att = (self.stats_attempts_total / solved) if solved else 0.0
        avg_fp = (self.stats_false_positives_total / total) if total else 0.0
        avg_rev = (self.stats_reveals_at_solve_total / solved) if solved else 0.0
        text = (
            f'Puzzles played   : {total}\n'
            f'Solved           : {solved}  ({rate:.1f}%)\n'
            f'Wrong clicks     : {self.stats_wrong_clicks}\n'
            f'Avg attempts/win : {avg_att:.2f}\n'
            f'Avg false-pos    : {avg_fp:.2f}\n'
            f'Avg reveals/win  : {avg_rev:.1f}\n'
        )
        self.stats_text.delete('1.0', tk.END)
        self.stats_text.insert(tk.END, text)

    def reset_stats(self):
        self.stats_total = 0
        self.stats_solved = 0
        self.stats_false_positives_total = 0
        self.stats_attempts_total = 0
        self.stats_reveals_at_solve_total = 0
        self.stats_wrong_clicks = 0
        self.render_stats()
        self.log('Stats reset.')

    # ─── Puzzle lifecycle ─────────────────────────────────────────────

    def new_puzzle(self):
        self.running = False
        self.solved = False
        self.failed = False
        self.attempts = 0
        self.reveals_done = 0
        self.exclude_keys = set()
        self.last_result = None
        self.start_time = None

        seed = self.rng.randrange(1 << 30)
        try:
            if self.custom_shape is not None:
                self.puzzle = generate_puzzle(
                    seed=seed,
                    custom_shape=self.custom_shape,
                    custom_wildcards=self.custom_wildcards,
                )
                target_size = len(self.custom_shape)
                kind = 'custom'
            else:
                smin = max(3, int(self.var_size_min.get()))
                smax = max(smin, int(self.var_size_max.get()))
                target_size = random.Random(seed).randint(smin, smax)
                self.puzzle = generate_puzzle(
                    num_wildcards=int(self.var_wildcards.get()),
                    target_size=target_size,
                    seed=seed,
                )
                kind = 'random'
        except Exception as e:
            self.log(f'Generation error: {e}')
            return
        self.reveal_queue = build_reveal_queue(self.puzzle, random.Random(seed + 1))
        strong_th, mid_th = adaptive_thresholds(target_size)
        wc_count = sum(1 for t in self.puzzle.target if t.state == 'placeholder')
        self.log(f'New puzzle ({kind}, seed={seed}, target_size={target_size}, '
                 f'wildcards={wc_count}, '
                 f'thresholds: strong>={strong_th} mid>={mid_th}, '
                 f'anchor=({self.puzzle.solution_anchor_col},{self.puzzle.solution_anchor_row}), '
                 f'click=({self.puzzle.target_click_col},{self.puzzle.target_click_row},'
                 f'{"D" if self.puzzle.target_click_mirror else "U"}))')
        self.status_var.set('Puzzle generated. Hit Start to run algorithm.')
        self.draw()

    # ─── Custom pattern handling ──────────────────────────────────────

    def open_pattern_editor(self):
        was_running = self.running
        if was_running:
            self.pause()
        PatternEditorWindow(
            self.root,
            on_apply=self._apply_custom_pattern,
            initial_shape=self.custom_shape,
            initial_wildcards=self.custom_wildcards,
        )

    def _apply_custom_pattern(self, shape, wildcards):
        self.custom_shape = shape
        self.custom_wildcards = list(wildcards)
        nrev = len(shape) - len(wildcards)
        self.pattern_status_var.set(
            f'Pattern: custom ({len(shape)} cells, {nrev} revealed, {len(wildcards)} ✱)'
        )
        self.log(f'Custom pattern applied: {len(shape)} cells, {len(wildcards)} wildcards')
        self.new_puzzle()

    def clear_custom_pattern(self):
        if self.custom_shape is None:
            return
        self.custom_shape = None
        self.custom_wildcards = None
        self.pattern_status_var.set('Pattern: random')
        self.log('Custom pattern cleared — back to random generation')
        self.new_puzzle()

    def start(self):
        if self.puzzle is None:
            self.new_puzzle()
        if self.solved or self.failed:
            self.new_puzzle()
        if not self.running:
            self.running = True
            self.start_time = time.time()
            self.last_reveal_ms = self._now_ms()
            self.status_var.set('Running…')
            self.tick()

    def pause(self):
        self.running = False
        self.status_var.set('Paused.')

    def step(self):
        if self.puzzle is None:
            return
        if self.solved or self.failed:
            return
        self.do_reveal()
        self.run_algorithm_step()
        self.draw()

    def _now_ms(self):
        return int(time.time() * 1000)

    def tick(self):
        if not self.running:
            return
        if self.solved or self.failed:
            self.running = False
            return

        # Reveal if interval elapsed
        now = self._now_ms()
        interval = max(50, int(self.var_interval.get()))
        if now - self.last_reveal_ms >= interval:
            self.do_reveal()
            self.last_reveal_ms = now

        # Always try to run algorithm
        self.run_algorithm_step()

        # Redraw + schedule
        self.draw()
        # Tick frequency: 60ms — fast enough to feel reactive
        self.root.after(60, self.tick)

    def do_reveal(self):
        # Reveal one cell from the queue (board or target — both share the queue)
        while self.reveal_queue:
            c = self.reveal_queue.pop()
            if c.state == 'placeholder' and c.future_glyph is not None:
                c.state = 'revealed'
                c.glyph = c.future_glyph
                self.reveals_done += 1
                return c
        return None

    def run_algorithm_step(self):
        if self.puzzle is None or self.solved or self.failed:
            return
        result = algorithm_step(self.puzzle.target, self.puzzle.board, self.exclude_keys)
        self.last_result = result
        if result['decision'] == 'commit':
            cand = result['candidate']
            reason = result['reason']
            self.attempts += 1
            ok = click_is_correct(self.puzzle, cand['click_col'], cand['click_row'], cand['click_mirror'])
            if ok:
                self.solved = True
                self.running = False
                elapsed = time.time() - (self.start_time or time.time())
                self.log(f'SOLVED ({reason}) anchor=({cand["anchor_col"]},{cand["anchor_row"]}) '
                         f'click=({cand["click_col"]},{cand["click_row"]}) '
                         f'attempts={self.attempts} reveals={self.reveals_done} '
                         f't={elapsed:.2f}s')
                self.status_var.set(
                    f'Solved on attempt #{self.attempts} ({reason}) after {self.reveals_done} reveals.'
                )
                self.stats_total += 1
                self.stats_solved += 1
                self.stats_attempts_total += self.attempts
                self.stats_false_positives_total += (self.attempts - 1)
                self.stats_reveals_at_solve_total += self.reveals_done
                self.render_stats()
            else:
                self.exclude_keys.add((cand['anchor_col'], cand['anchor_row']))
                self.log(f'FALSE POSITIVE ({reason}) anchor=({cand["anchor_col"]},{cand["anchor_row"]}) '
                         f'click=({cand["click_col"]},{cand["click_row"]}) — excluding')
                self.stats_wrong_clicks += 1
                if self.attempts >= MAX_RETRIES:
                    self.failed = True
                    self.running = False
                    self.log(f'GIVE UP after {self.attempts} attempts')
                    self.status_var.set('Failed: max retries exhausted.')
                    self.stats_total += 1
                    self.stats_false_positives_total += self.attempts
                    self.render_stats()

    # ─── Drawing ──────────────────────────────────────────────────────

    def draw(self):
        self._draw_board()
        self._draw_target()

    def _draw_board(self):
        c = self.board_canvas
        c.delete('all')
        if self.puzzle is None:
            return

        # Board spans cols 0..18 (19 columns) horizontally; center on canvas
        canvas_w = int(c.winfo_width()) or 520
        board_w = 19 * TRI_W
        ox = (canvas_w - board_w) / 2
        oy = 20

        # Draw cells
        for cell in self.puzzle.board:
            poly = cell_polygon(cell.col, cell.row, cell.mirror, TRI_W, TRI_H, ox, oy)
            if cell.state == 'empty':
                fill = COLOR_EMPTY
                outline = '#1A2B3D'
            elif cell.state == 'placeholder':
                fill = COLOR_PLACEHOLDER_FILL
                outline = COLOR_PLACEHOLDER_OUTLINE
            else:  # revealed
                fill = COLOR_REVEALED_FILL
                outline = COLOR_PLACEHOLDER_OUTLINE
            c.create_polygon(*poly, fill=fill, outline=outline, width=1)

            if cell.state == 'revealed':
                cx, cy = cell_center(cell.col, cell.row, cell.mirror, TRI_W, TRI_H, ox, oy)
                c.create_text(cx, cy, text=cell.glyph or '?', fill=COLOR_GLYPH,
                              font=GLYPH_FONT)

        # Draw ground-truth click (subtle green marker — always visible)
        gtx, gty = cell_center(
            self.puzzle.target_click_col, self.puzzle.target_click_row,
            self.puzzle.target_click_mirror, TRI_W, TRI_H, ox, oy
        )
        c.create_oval(gtx - 5, gty - 5, gtx + 5, gty + 5,
                      outline=COLOR_GROUND_TRUTH, width=2, dash=(2, 2))

        # Draw all candidates faintly
        if self.last_result:
            cands = self.last_result.get('all_candidates') or []
            # Skip the best — drawn solo later
            best = self.last_result.get('candidate')
            for cand in cands:
                if cand is best:
                    continue
                for cc in cand['cells']:
                    poly = cell_polygon(cc['col'], cc['row'], cc['mirror'], TRI_W, TRI_H, ox, oy)
                    c.create_polygon(*poly, fill='', outline='#5A4400', width=1)

            # Draw best (tentative or confident)
            if best:
                committed = (self.last_result.get('decision') == 'commit')
                outline = COLOR_CONFIDENT if committed else COLOR_TENTATIVE
                for cc in best['cells']:
                    poly = cell_polygon(cc['col'], cc['row'], cc['mirror'], TRI_W, TRI_H, ox, oy)
                    fill = ''
                    width = 2
                    if cc['is_click']:
                        fill = COLOR_CLICK
                        # Stipple = pseudo-transparency on classic Tk
                        c.create_polygon(*poly, fill=fill, outline='white',
                                          width=2, stipple='gray50')
                    c.create_polygon(*poly, fill='', outline=outline, width=width)

        # Mark excluded anchors with a small red X over the cell glyph
        for (ec, er) in self.exclude_keys:
            for cell in self.puzzle.board:
                if cell.col == ec and cell.row == er and cell.state == 'revealed':
                    cx2, cy2 = cell_center(cell.col, cell.row, cell.mirror, TRI_W, TRI_H, ox, oy)
                    c.create_text(cx2 + 6, cy2 - 6, text='✕', fill='#FF6666',
                                  font=('Helvetica', 10, 'bold'))
                    break

    def _draw_target(self):
        c = self.target_canvas
        c.delete('all')
        if self.puzzle is None:
            return
        canvas_w = int(c.winfo_width()) or 540
        canvas_h = int(c.winfo_height()) or 240

        # Compute target bbox
        min_c = min(t.col for t in self.puzzle.target)
        max_c = max(t.col for t in self.puzzle.target)
        min_r = min(t.row for t in self.puzzle.target)
        max_r = max(t.row for t in self.puzzle.target)
        # Each col occupies TARGET_TRI_W horizontal; pattern width
        pat_w = (max_c - min_c + 2) * TARGET_TRI_W
        pat_h = (max_r - min_r + 1) * TARGET_TRI_H
        ox = (canvas_w - pat_w) / 2 - min_c * TARGET_TRI_W
        oy = (canvas_h - pat_h) / 2 - min_r * TARGET_TRI_H

        click_t = pick_click_target(self.puzzle.target)
        for t in self.puzzle.target:
            poly = cell_polygon(t.col, t.row, t.mirror, TARGET_TRI_W, TARGET_TRI_H, ox, oy)
            if t.state == 'placeholder':
                # Wildcard cell — distinct dashed orange border, no glyph
                fill = '#1A2030'
                outline = COLOR_CONFIDENT
                c.create_polygon(*poly, fill=fill, outline=outline, width=2, dash=(4, 3))
            else:
                fill = COLOR_REVEALED_FILL
                outline = COLOR_GLYPH
                c.create_polygon(*poly, fill=fill, outline=outline, width=2)
            cx, cy = cell_center(t.col, t.row, t.mirror, TARGET_TRI_W, TARGET_TRI_H, ox, oy)
            if t.state == 'revealed':
                c.create_text(cx, cy, text=t.glyph, fill=COLOR_GLYPH,
                              font=GLYPH_FONT_TARGET)
            else:
                # Wildcard glyph: a faint asterisk so user sees "any allowed here"
                c.create_text(cx, cy, text='✱', fill=COLOR_CONFIDENT,
                              font=('DejaVu Sans', 14))
            # Mark the click target
            if t is click_t:
                c.create_oval(cx - 4, cy + 14, cx + 4, cy + 22,
                              fill=COLOR_CLICK, outline='white', width=1)

    # ─── Batch run (headless, fast) ───────────────────────────────────

    def run_batch(self):
        n = int(self.var_batch_n.get())
        wildcards = int(self.var_wildcards.get())
        smin = max(3, int(self.var_size_min.get()))
        smax = max(smin, int(self.var_size_max.get()))
        self.log(f'Batch: running {n} puzzles (size {smin}..{smax}, wildcards={wildcards})…')
        self.status_var.set(f'Running batch of {n}…')
        self.root.update_idletasks()

        local_solved = 0
        local_attempts = 0
        local_fp = 0
        local_reveals = 0
        local_wrong = 0
        t0 = time.time()
        for i in range(n):
            seed = self.rng.randrange(1 << 30)
            size = random.Random(seed).randint(smin, smax)
            try:
                puzzle = generate_puzzle(num_wildcards=wildcards,
                                          target_size=size, seed=seed)
            except Exception:
                continue
            queue = build_reveal_queue(puzzle, random.Random(seed + 1))
            exclude = set()
            attempts = 0
            reveals = 0
            solved = False
            # Solve until success or queue exhausted
            while True:
                # Try algorithm step now
                res = algorithm_step(puzzle.target, puzzle.board, exclude)
                if res['decision'] == 'commit':
                    cand = res['candidate']
                    attempts += 1
                    if click_is_correct(puzzle, cand['click_col'], cand['click_row'],
                                         cand['click_mirror']):
                        solved = True
                        break
                    else:
                        exclude.add((cand['anchor_col'], cand['anchor_row']))
                        local_wrong += 1
                        if attempts >= MAX_RETRIES:
                            break
                        continue  # try again with new exclude
                # Need more reveals
                if not queue:
                    break
                c = queue.pop()
                if c.state == 'placeholder' and c.future_glyph is not None:
                    c.state = 'revealed'
                    c.glyph = c.future_glyph
                    reveals += 1
            if solved:
                local_solved += 1
                local_attempts += attempts
                local_fp += (attempts - 1)
                local_reveals += reveals
            self.stats_total += 1
            if solved:
                self.stats_solved += 1
                self.stats_attempts_total += attempts
                self.stats_false_positives_total += (attempts - 1)
                self.stats_reveals_at_solve_total += reveals
            else:
                self.stats_false_positives_total += attempts
            self.stats_wrong_clicks += (attempts - 1 if solved else attempts)
            if i % 50 == 49:
                self.status_var.set(f'Batch: {i+1}/{n} (solved so far: {local_solved})')
                self.root.update_idletasks()
        dt = time.time() - t0
        rate = local_solved / n * 100 if n else 0.0
        self.log(
            f'Batch done in {dt:.1f}s. solved={local_solved}/{n} ({rate:.1f}%), '
            f'avg_attempts={(local_attempts/local_solved if local_solved else 0):.2f}, '
            f'avg_false_pos={(local_fp/n):.2f}, '
            f'avg_reveals={(local_reveals/local_solved if local_solved else 0):.1f}'
        )
        self.render_stats()
        self.status_var.set('Batch complete.')


def main():
    root = tk.Tk()
    IceWallPolygonApp(root)
    root.mainloop()


if __name__ == '__main__':
    main()
