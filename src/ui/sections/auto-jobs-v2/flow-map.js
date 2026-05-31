// Auto-Jobs v2 — Flow Map (pipeline flowchart + live progress).
//
// A Network-Map-style pan/zoom SVG canvas that draws the v2 pipeline as the
// flowchart it actually is: module boxes, a decision diamond (QUEUE:EMPTY?),
// DELAY pills, branch labels (YES/NO) and a loop-back edge. The node ids come
// from COR3.constants.AJV2.NODE — the SAME ids the orchestrator stamps onto
// AJV2_PIPELINE_STATE — so this map can highlight exactly which stage the
// runtime is executing right now.
//
// Layout is hand-placed (the graph is small, fixed, and cyclic — a generic
// auto-layout fights the loop edge). The orchestrator owns the execution
// order; this file owns the picture.
//
// Exposes attach() on COR3.uiComponentsV2.flowMap (NOT v1's uiComponents).

(function () {
    const root = window;
    if (!root.COR3 || !root.COR3.constants) return;
    const C = root.COR3.constants;
    const { Store } = root.COR3;
    const NODE = C.AJV2.NODE;
    const SL = C.STORAGE_LOCAL;
    const SVG_NS = 'http://www.w3.org/2000/svg';

    // ── Geometry ──────────────────────────────────────────────────────────
    const MODULE_H = 34;
    const DECISION_W = 132, DECISION_H = 66;
    const DELAY_W = 100, DELAY_H = 28;
    const TERMINAL_W = 116, TERMINAL_H = 30;
    const CHAR_W = 6.2;     // approx px per char at the node font
    const MODULE_PAD = 26;
    const MODULE_MIN_W = 132;

    const CX = 230;         // centre column x (main descent + delays)
    const COL_2 = 470;      // mid-right lane: NO-branch execution chain
    const COL_3 = 690;      // BUGGED? decision
    const COL_4 = 900;      // JOB:SKIP
    const LOOP_X = 46;      // far-left lane for the loop-back edge
    const ROW_DECISION = 486;  // top decision row (all four diamonds/skip)
    const ROW_DELAY = 1260;    // bottom convergence row — DELAY_CYCLE (the cycle wait)
    const RETURN_X = 985;      // far-right return lane: JOB:SKIP routes around MARK_AS_BUGGED

    // type: 'terminal' | 'delay' | 'module' | 'decision'
    // x/y are box CENTRES.
    //
    // Lanes: centre = main descent + the "queue empty → wait" YES bypass;
    // mid-right = the NO-branch execution chain; the two right lanes hold the
    // in-progress BUGGED? detour. All four decision/skip boxes share one row so
    // their branches are clean horizontals.
    const NODES = [
        { id: NODE.START,           label: 'START',                       type: 'terminal', x: CX,    y: 36 },
        { id: NODE.DELAY_INITIAL,   label: 'DELAY 10s',                   type: 'delay',    x: CX,    y: 96 },
        { id: NODE.GET_SERVERS,     label: 'GET_SERVERS',                 type: 'module',   x: CX,    y: 156 },
        { id: NODE.CHECK_ACCESS,    label: 'CHECK_SERVERS_ACCESABILITY',  type: 'module',   x: CX,    y: 216 },
        { id: NODE.UPDATE_MARKETS,  label: 'UPDATE_MARKETS',              type: 'module',   x: CX,    y: 276 },
        { id: NODE.JOB_QUEUE,       label: 'JOB_QUEUE',                   type: 'module',   x: CX,    y: 336 },
        { id: NODE.READY_TO_COMPLETE, label: 'READY TO COMPLETE',         type: 'module',   x: CX,    y: 408 },
        { id: NODE.QUEUE_EMPTY,     label: 'QUEUE EMPTY?',                type: 'decision', x: CX,    y: ROW_DECISION },
        { id: NODE.HAVE_TASKS_IN_PROGRESS, label: 'IN PROGRESS?',         type: 'decision', x: COL_2, y: ROW_DECISION },
        { id: NODE.BUGGED_JOBS,     label: 'BUGGED?',                     type: 'decision', x: COL_3, y: ROW_DECISION },
        { id: NODE.JOB_SKIP,        label: 'JOB:SKIP',                    type: 'module',   x: COL_4, y: ROW_DECISION },
        { id: NODE.CHECK_CONDITION, label: 'CHECK_JOBS_CONDITION',        type: 'module',   x: COL_2, y: 626 },
        { id: NODE.JOB_ACCEPTION,   label: 'JOB_ACCEPTION',               type: 'module',   x: COL_2, y: 694 },
        { id: NODE.JOB_FLOW,        label: 'JOB_FLOW',                    type: 'module',   x: COL_2, y: 762 },

        // JOB_FLOW : file_decryption sub-flow (lit live via FLOW_STEP). Lives in
        // the COL_3 lane, branching right off JOB_FLOW.
        { id: NODE.FD_READ_FORMAT,    label: 'READ FORMAT',     type: 'module',   x: COL_3, y: 762 },
        { id: NODE.FD_CHECK_LOADOUT,  label: 'DECRYPT SW?',     type: 'decision', x: COL_3, y: 866 },
        { id: NODE.MARK_AS_BUGGED,    label: 'MARK_AS_BUGGED',  type: 'module',   x: COL_4, y: 866 },
        { id: NODE.FD_INSTALL_SW,     label: 'INSTALL/SWAP SW', type: 'module',   x: COL_3, y: 960 },
        { id: NODE.FD_OPEN_DOWNLOADS, label: 'OPEN DOWNLOADS',  type: 'module',   x: COL_3, y: 1032 },
        { id: NODE.FD_SOLVE,          label: 'SOLVE MINIGAME',  type: 'module',   x: COL_3, y: 1104 },
        { id: NODE.FD_COMPLETE,       label: 'COMPLETE JOB',    type: 'module',   x: COL_3, y: 1176 },

        { id: NODE.DELAY_CYCLE,     label: 'DELAY 30s',                   type: 'delay',    x: CX,    y: ROW_DELAY },
    ];

    // All edges route orthogonally (right-angle elbows, rounded corners).
    // kind: 'down' (A.bottom → B.top), 'right' (A.right → B.left),
    //       'merge', 'loop' (far-left lane).
    //
    // A 'merge' edge converging into DELAY_CYCLE carries a hand-placed `route`
    // { dropX, turnY, enterX, exitRight? }: the branch drops straight out of
    // its block down to `turnY` (a LOW rail just above DELAY, so no line floats
    // sideways under the source box), jogs across to `enterX` on DELAY's top
    // edge, then descends into the top. turnY/enterX are staggered per branch
    // so the four converging arrows enter at distinct points and never share a
    // segment — leftmost entry turns highest, giving a clean non-crossing fan.
    // `exitRight` sends JOB:SKIP out its right side into the RETURN_X lane so it
    // clears the MARK_AS_BUGGED box stacked directly below it. A 'merge' edge
    // WITHOUT a route (BUGGED? → CHECK_CONDITION) keeps the old elbow into B's
    // right side.
    const EDGES = [
        { from: NODE.START,          to: NODE.DELAY_INITIAL,  kind: 'down' },
        { from: NODE.DELAY_INITIAL,  to: NODE.GET_SERVERS,    kind: 'down' },
        { from: NODE.GET_SERVERS,    to: NODE.CHECK_ACCESS,   kind: 'down' },
        { from: NODE.CHECK_ACCESS,   to: NODE.UPDATE_MARKETS, kind: 'down' },
        { from: NODE.UPDATE_MARKETS, to: NODE.JOB_QUEUE,      kind: 'down' },
        { from: NODE.JOB_QUEUE,      to: NODE.READY_TO_COMPLETE, kind: 'down' },
        { from: NODE.READY_TO_COMPLETE, to: NODE.QUEUE_EMPTY, kind: 'down' },
        { from: NODE.QUEUE_EMPTY,    to: NODE.DELAY_CYCLE,    kind: 'down',  label: 'YES' },
        { from: NODE.QUEUE_EMPTY,    to: NODE.HAVE_TASKS_IN_PROGRESS, kind: 'right', label: 'NO' },
        { from: NODE.HAVE_TASKS_IN_PROGRESS, to: NODE.CHECK_CONDITION, kind: 'down',  label: 'NO' },
        { from: NODE.HAVE_TASKS_IN_PROGRESS, to: NODE.BUGGED_JOBS,     kind: 'right', label: 'YES' },
        { from: NODE.BUGGED_JOBS,    to: NODE.JOB_SKIP,        kind: 'right', label: 'YES' },
        { from: NODE.BUGGED_JOBS,    to: NODE.CHECK_CONDITION, kind: 'merge', enter: 'right', label: 'NO' },
        { from: NODE.JOB_SKIP,       to: NODE.DELAY_CYCLE,     kind: 'merge', route: { exitRight: true, dropX: RETURN_X, turnY: 1238, enterX: 260 } },
        { from: NODE.CHECK_CONDITION, to: NODE.JOB_ACCEPTION,  kind: 'down' },
        { from: NODE.JOB_ACCEPTION,  to: NODE.JOB_FLOW,        kind: 'down' },
        { from: NODE.JOB_FLOW,       to: NODE.DELAY_CYCLE,     kind: 'merge', route: { dropX: COL_2, turnY: 1196, enterX: 204 } },

        // JOB_FLOW : file_decryption sub-flow.
        { from: NODE.JOB_FLOW,         to: NODE.FD_READ_FORMAT,    kind: 'right', label: 'file_decryption' },
        { from: NODE.FD_READ_FORMAT,   to: NODE.FD_CHECK_LOADOUT,  kind: 'down' },
        { from: NODE.FD_CHECK_LOADOUT, to: NODE.MARK_AS_BUGGED,    kind: 'right', label: 'none' },
        { from: NODE.FD_CHECK_LOADOUT, to: NODE.FD_INSTALL_SW,     kind: 'down',  label: 'have SW' },
        { from: NODE.FD_INSTALL_SW,    to: NODE.FD_OPEN_DOWNLOADS, kind: 'down' },
        { from: NODE.FD_OPEN_DOWNLOADS, to: NODE.FD_SOLVE,         kind: 'down' },
        { from: NODE.FD_SOLVE,         to: NODE.FD_COMPLETE,       kind: 'down' },
        { from: NODE.FD_COMPLETE,      to: NODE.DELAY_CYCLE,       kind: 'merge', route: { dropX: COL_3, turnY: 1210, enterX: 220 } },
        { from: NODE.MARK_AS_BUGGED,   to: NODE.DELAY_CYCLE,       kind: 'merge', route: { dropX: COL_4, turnY: 1224, enterX: 244 } },

        { from: NODE.DELAY_CYCLE,    to: NODE.GET_SERVERS,     kind: 'loop',  label: 'loop' },
    ];

    // ── SAI flows — collapsed fan ────────────────────────────────────────────
    // The 7 SAI mutation flows are structurally identical (ACCESS → action →
    // COMPLETE), so they SHARE one ACCESS and one COMPLETE node with their 7
    // distinct action nodes fanning between them — no repeated columns, one
    // labelled edge off JOB_FLOW. The per-flow *_ACCESS / *_COMPLETE ids the
    // flow modules emit alias onto SAI_ACCESS / SAI_COMPLETE for live highlight
    // (NODE_ALIAS, used in setActive). decrypt_extract has a minigame so it
    // keeps its own short lane, like file_decryption.
    const SAI_ACCESS_X = 1150, FAN_X = 1430, SAI_COMPLETE_X = 1700;
    // FAN_TOP/GAP chosen so the centre row (SAI_ACCESS/COMPLETE y) lands in a
    // CLEAR horizontal band of the file_decryption column (between FD_CHECK_LOADOUT
    // y=866 and FD_INSTALL_SW y=960), so the JOB_FLOW→SAI_ACCESS edge doesn't
    // plough through an FD node on its way across.
    const FAN_TOP = 720, FAN_GAP = 72;
    const SAI_ACTIONS = [
        { id: NODE.II_INJECT,   label: 'INJECT IPs' },
        { id: NODE.IC_CLEANUP,  label: 'REMOVE IPs' },
        { id: NODE.FE_DELETE,   label: 'DELETE FILE' },
        { id: NODE.DD_DOWNLOAD, label: 'DOWNLOAD' },
        { id: NODE.FU_UPLOAD,   label: 'UPLOAD' },
        { id: NODE.LG_DOWNLOAD, label: 'DOWNLOAD LOG' },
        { id: NODE.LD_DELETE,   label: 'DELETE LOG' },
    ];
    const FAN_MID = FAN_TOP + Math.floor((SAI_ACTIONS.length - 1) / 2) * FAN_GAP;   // centre row
    NODES.push({ id: NODE.SAI_ACCESS,   label: 'SAI ACCESS', type: 'module', x: SAI_ACCESS_X,   y: FAN_MID });
    NODES.push({ id: NODE.SAI_COMPLETE, label: 'COMPLETE',   type: 'module', x: SAI_COMPLETE_X, y: FAN_MID });
    SAI_ACTIONS.forEach((a, i) => NODES.push({ id: a.id, label: a.label, type: 'module', x: FAN_X, y: FAN_TOP + i * FAN_GAP }));
    EDGES.push({ from: NODE.JOB_FLOW, to: NODE.SAI_ACCESS, kind: 'right', viaX: 575, label: 'SAI ops' });
    SAI_ACTIONS.forEach((a) => {
        EDGES.push({ from: NODE.SAI_ACCESS, to: a.id, kind: 'right' });
        EDGES.push({ from: a.id, to: NODE.SAI_COMPLETE, kind: 'right' });
    });
    EDGES.push({ from: NODE.SAI_COMPLETE, to: NODE.DELAY_CYCLE, kind: 'merge', route: { dropX: SAI_COMPLETE_X, turnY: 1234, enterX: 252 } });

    // Per-flow ACCESS/COMPLETE step ids → the shared display nodes.
    const NODE_ALIAS = {};
    [NODE.II_ACCESS, NODE.IC_ACCESS, NODE.FE_ACCESS, NODE.DD_ACCESS, NODE.FU_ACCESS, NODE.LG_ACCESS, NODE.LD_ACCESS]
        .forEach((id) => { NODE_ALIAS[id] = NODE.SAI_ACCESS; });
    [NODE.II_COMPLETE, NODE.IC_COMPLETE, NODE.FE_COMPLETE, NODE.DD_COMPLETE, NODE.FU_COMPLETE, NODE.LG_COMPLETE, NODE.LD_COMPLETE]
        .forEach((id) => { NODE_ALIAS[id] = NODE.SAI_COMPLETE; });

    // decrypt_extract — own lane (SAI download + decrypt minigame), like FD.
    const DE_X = 1980;
    NODES.push({ id: NODE.DE_ACCESS,   label: 'ACCESS',       type: 'module', x: DE_X, y: 640 });
    NODES.push({ id: NODE.DE_DOWNLOAD, label: 'SAI DOWNLOAD', type: 'module', x: DE_X, y: 736 });
    NODES.push({ id: NODE.DE_SOLVE,    label: 'SOLVE',        type: 'module', x: DE_X, y: 832 });
    NODES.push({ id: NODE.DE_COMPLETE, label: 'COMPLETE',     type: 'module', x: DE_X, y: 928 });
    EDGES.push({ from: NODE.JOB_FLOW,    to: NODE.DE_ACCESS,   kind: 'right', viaX: 560, label: 'decrypt_extract' });
    EDGES.push({ from: NODE.DE_ACCESS,   to: NODE.DE_DOWNLOAD, kind: 'down' });
    EDGES.push({ from: NODE.DE_DOWNLOAD, to: NODE.DE_SOLVE,    kind: 'down' });
    EDGES.push({ from: NODE.DE_SOLVE,    to: NODE.DE_COMPLETE, kind: 'down' });
    EDGES.push({ from: NODE.DE_COMPLETE, to: NODE.DELAY_CYCLE, kind: 'merge', route: { dropX: DE_X, turnY: 1244, enterX: 264 } });

    // DELAY node → its total duration, so the map can run a local countdown
    // while the orchestrator sleeps (no storage writes happen mid-delay).
    const DELAY_MS = {
        [NODE.DELAY_INITIAL]: C.AJV2.LOOP.INITIAL_DELAY_MS,
        [NODE.DELAY_CYCLE]: C.AJV2.LOOP.CYCLE_DELAY_MS,
    };

    function svgEl(name, attrs) {
        const e = document.createElementNS(SVG_NS, name);
        if (attrs) for (const k of Object.keys(attrs)) {
            if (attrs[k] != null) e.setAttribute(k, attrs[k]);
        }
        return e;
    }
    function htmlEl(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text !== undefined) e.textContent = text;
        return e;
    }

    function nodeSize(n) {
        switch (n.type) {
            case 'terminal': return { w: TERMINAL_W, h: TERMINAL_H };
            case 'delay':    return { w: DELAY_W, h: DELAY_H };
            case 'decision': return { w: DECISION_W, h: DECISION_H };
            default:         return { w: Math.max(MODULE_MIN_W, Math.round(n.label.length * CHAR_W) + MODULE_PAD), h: MODULE_H };
        }
    }

    // Anchor points on a node's bounding box (diamond vertices sit at the same
    // four side-midpoints, so this is uniform across types).
    function anchors(n) {
        const { w, h } = nodeSize(n);
        return {
            top:    { x: n.x,         y: n.y - h / 2 },
            bottom: { x: n.x,         y: n.y + h / 2 },
            left:   { x: n.x - w / 2, y: n.y },
            right:  { x: n.x + w / 2, y: n.y },
        };
    }

    // Build an SVG path through a list of points using straight segments and
    // small rounded right-angle corners (no bezier sweeps). Every flowchart
    // edge is expressed as such a point list, so all corners are 90°.
    const CORNER_R = 8;
    function orthoPath(pts) {
        if (!pts || pts.length < 2) return '';
        if (pts.length === 2) return `M ${pts[0].x} ${pts[0].y} L ${pts[1].x} ${pts[1].y}`;
        let d = `M ${pts[0].x} ${pts[0].y}`;
        for (let i = 1; i < pts.length - 1; i++) {
            const p0 = pts[i - 1], p1 = pts[i], p2 = pts[i + 1];
            const len1 = Math.hypot(p1.x - p0.x, p1.y - p0.y);
            const len2 = Math.hypot(p2.x - p1.x, p2.y - p1.y);
            const r = Math.min(CORNER_R, len1 / 2, len2 / 2);
            const u1x = (p1.x - p0.x) / (len1 || 1), u1y = (p1.y - p0.y) / (len1 || 1);
            const u2x = (p2.x - p1.x) / (len2 || 1), u2y = (p2.y - p1.y) / (len2 || 1);
            d += ` L ${(p1.x - u1x * r).toFixed(1)} ${(p1.y - u1y * r).toFixed(1)}`;
            d += ` Q ${p1.x} ${p1.y} ${(p1.x + u2x * r).toFixed(1)} ${(p1.y + u2y * r).toFixed(1)}`;
        }
        const last = pts[pts.length - 1];
        d += ` L ${last.x} ${last.y}`;
        return d;
    }

    // Each edge kind resolves to an orthogonal point list.
    function edgePoints(edge, byId) {
        const a = byId.get(edge.from);
        const b = byId.get(edge.to);
        const A = anchors(a), B = anchors(b);
        switch (edge.kind) {
            case 'down': {
                const p0 = A.bottom, p1 = B.top;
                if (Math.abs(p0.x - p1.x) < 0.5) return [p0, p1];
                const midY = (p0.y + p1.y) / 2;
                return [p0, { x: p0.x, y: midY }, { x: p1.x, y: midY }, p1];
            }
            case 'right': {
                const p0 = A.right, p1 = B.left;
                if (Math.abs(p0.y - p1.y) < 0.5) return [p0, p1];
                // `viaX` forces the vertical jog at a fixed early x (instead of
                // the midpoint) so a far-right target's edge can rise/drop out of
                // JOB_FLOW before the file_decryption column, not plough through it.
                const jogX = (edge.viaX != null) ? edge.viaX : (p0.x + p1.x) / 2;
                return [p0, { x: jogX, y: p0.y }, { x: jogX, y: p1.y }, p1];
            }
            case 'merge': {
                if (edge.route) {
                    // Converge into DELAY's top: drop straight out of the block,
                    // make the single horizontal jog LOW (at turnY, just above
                    // DELAY), then descend into the top at enterX. See EDGES.
                    const r = edge.route;
                    const start = r.exitRight ? A.right : A.bottom;
                    const pts = [start];
                    if (Math.abs(r.dropX - start.x) > 0.5) pts.push({ x: r.dropX, y: start.y });
                    pts.push({ x: r.dropX, y: r.turnY });
                    pts.push({ x: r.enterX, y: r.turnY });
                    pts.push({ x: r.enterX, y: B.top.y });
                    return pts;
                }
                // No route (BUGGED? → CHECK_CONDITION): down to B's centre-y,
                // then across into B's right side.
                return [A.bottom, { x: A.bottom.x, y: B.right.y }, B.right];
            }
            case 'loop': {
                // Far-left lane: out the delay's left, up, back into GET_SERVERS.
                return [A.left, { x: LOOP_X, y: A.left.y }, { x: LOOP_X, y: B.left.y }, B.left];
            }
            default:
                return [];
        }
    }

    function edgePath(edge, byId) {
        return orthoPath(edgePoints(edge, byId));
    }

    function edgeLabelPos(edge, byId) {
        const a = byId.get(edge.from);
        const b = byId.get(edge.to);
        const A = anchors(a), B = anchors(b);
        switch (edge.kind) {
            case 'down':  return { x: A.bottom.x + 12, y: (A.bottom.y + B.top.y) / 2 };
            case 'right':
                // viaX edges jog early — label by the vertical jog so the two
                // JOB_FLOW branch labels ('SAI ops' / 'decrypt_extract') don't
                // collide out over the columns.
                if (edge.viaX != null) return { x: edge.viaX + 10, y: (A.right.y + B.left.y) / 2 };
                return { x: (A.right.x + B.left.x) / 2, y: A.right.y - 7 };
            case 'merge':
                // Only BUGGED? → CHECK_CONDITION (no route) carries a label;
                // the routed DELAY merges have none.
                return { x: A.bottom.x + 12, y: (A.bottom.y + B.right.y) / 2 };
            case 'loop':  return { x: LOOP_X + 8, y: (A.left.y + B.left.y) / 2 };
            default:      return null;
        }
    }

    function nodeShape(n) {
        const { w, h } = nodeSize(n);
        const x = -w / 2, y = -h / 2;
        if (n.type === 'decision') {
            // Diamond polygon (points relative to centre).
            return svgEl('polygon', {
                class: 'fm-node-shape fm-shape-decision',
                points: `0,${y} ${w / 2},0 0,${h / 2} ${-w / 2},0`,
            });
        }
        const rx = (n.type === 'delay' || n.type === 'terminal') ? h / 2 : 5;
        return svgEl('rect', {
            class: `fm-node-shape fm-shape-${n.type}`,
            x, y, width: w, height: h, rx, ry: rx,
        });
    }

    function ensureDefs(svg) {
        const defs = svgEl('defs');

        const filter = svgEl('filter', { id: 'fm-glow', x: '-50%', y: '-50%', width: '200%', height: '200%' });
        filter.appendChild(svgEl('feGaussianBlur', { stdDeviation: 2.2, result: 'blur' }));
        const merge = svgEl('feMerge');
        merge.appendChild(svgEl('feMergeNode', { in: 'blur' }));
        merge.appendChild(svgEl('feMergeNode', { in: 'SourceGraphic' }));
        filter.appendChild(merge);
        defs.appendChild(filter);

        for (const id of ['fm-arrow', 'fm-arrow-active']) {
            const marker = svgEl('marker', {
                id, markerWidth: 7, markerHeight: 7, refX: 6, refY: 3,
                orient: 'auto', markerUnits: 'userSpaceOnUse',
            });
            marker.appendChild(svgEl('path', { class: id === 'fm-arrow' ? 'fm-arrowhead' : 'fm-arrowhead-active', d: 'M0,0 L6,3 L0,6 Z' }));
            defs.appendChild(marker);
        }
        svg.appendChild(defs);
    }

    function attach(container) {
        container.classList.add('ajv2-flow-host');
        container.innerHTML = '';

        const byId = new Map(NODES.map((n) => [n.id, n]));

        // World bounds (include the far-left loop lane + a pad).
        let maxX = 0, maxY = 0;
        for (const n of NODES) {
            const { w, h } = nodeSize(n);
            maxX = Math.max(maxX, n.x + w / 2);
            maxY = Math.max(maxY, n.y + h / 2);
        }
        maxX = Math.max(maxX, RETURN_X);  // include the JOB:SKIP return lane
        const PAD = 36;
        const worldW = maxX + PAD;
        const worldH = maxY + PAD;
        const CANVAS_H = 420;

        const wrap = htmlEl('div', 'ajv2-flow');

        const titleRow = htmlEl('div', 'ajv2-flow-head');
        titleRow.appendChild(htmlEl('span', 'card-label', 'Flow Map'));
        const status = htmlEl('span', 'muted xs ajv2-flow-status', 'idle');
        titleRow.appendChild(status);
        wrap.appendChild(titleRow);

        const canvasHost = htmlEl('div', 'network-map-canvas');
        const gridLayer = htmlEl('div', 'network-map-grid');
        canvasHost.appendChild(gridLayer);

        const hud = htmlEl('div', 'nm-hud');
        const zoomLabel = htmlEl('span', 'nm-hud-zoom muted xs', '100%');
        const fitBtn = htmlEl('button', 'btn small nm-hud-btn', 'Fit');
        fitBtn.title = 'Reset zoom and center';
        hud.appendChild(zoomLabel);
        hud.appendChild(fitBtn);
        canvasHost.appendChild(hud);

        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('class', 'network-map-svg');
        svg.setAttribute('width', '100%');
        svg.style.height = CANVAS_H + 'px';
        canvasHost.appendChild(svg);
        ensureDefs(svg);

        const camera = svgEl('g', { class: 'fm-camera' });
        svg.appendChild(camera);

        wrap.appendChild(canvasHost);
        container.appendChild(wrap);

        // ── Edges ──────────────────────────────────────────────────────────
        const edgeEls = new Map();   // `${from}->${to}` -> path
        const edgesG = svgEl('g', { class: 'fm-edges' });
        for (const e of EDGES) {
            const path = svgEl('path', {
                class: 'fm-edge fm-edge-' + e.kind,
                d: edgePath(e, byId),
                'marker-end': 'url(#fm-arrow)',
            });
            edgesG.appendChild(path);
            edgeEls.set(`${e.from}->${e.to}`, path);

            if (e.label) {
                const lp = edgeLabelPos(e, byId);
                if (lp) {
                    const t = svgEl('text', { class: 'fm-edge-label', x: lp.x, y: lp.y });
                    t.textContent = e.label;
                    edgesG.appendChild(t);
                }
            }
        }
        camera.appendChild(edgesG);

        // ── Nodes ────────────────────────────────────────────────────────
        const nodeEls = new Map();
        const delayParts = new Map();  // delay node id -> { progressRect, labelEl, base, innerW }
        const nodesG = svgEl('g', { class: 'fm-nodes' });
        for (const n of NODES) {
            const g = svgEl('g', { class: `fm-node fm-node-${n.type}`, 'data-id': n.id, transform: `translate(${n.x}, ${n.y})` });
            g.appendChild(nodeShape(n));

            // DELAY nodes carry a progress bar that fills as the timer runs.
            const innerW = DELAY_W - 16;
            let progressRect = null;
            if (n.type === 'delay') {
                progressRect = svgEl('rect', {
                    class: 'fm-delay-progress',
                    x: -innerW / 2, y: DELAY_H / 2 - 7, width: 0, height: 3, rx: 1.5, ry: 1.5,
                });
                g.appendChild(progressRect);
            }

            // Multi-line label for the long module names: wrap on underscores
            // so the box can stay reasonably narrow.
            const { w } = nodeSize(n);
            const lines = wrapLabel(n.label, w);
            const startDy = -((lines.length - 1) * 5);
            let labelEl = null;
            for (let i = 0; i < lines.length; i++) {
                const tx = svgEl('text', {
                    class: 'fm-node-label',
                    x: 0, y: startDy + i * 10,
                    'text-anchor': 'middle', 'dominant-baseline': 'middle',
                });
                tx.textContent = lines[i];
                g.appendChild(tx);
                if (i === 0) labelEl = tx;
            }

            if (n.type === 'delay') {
                delayParts.set(n.id, { progressRect, labelEl, base: n.label, innerW });
            }

            const title = svgEl('title');
            title.textContent = n.label;
            g.appendChild(title);

            nodesG.appendChild(g);
            nodeEls.set(n.id, g);
        }
        camera.appendChild(nodesG);

        // ── Camera (pan / wheel-zoom / fit) via the shared controller ──────
        // The Flow Map world is fixed (hand-placed nodes), so getWorld returns
        // the constant bounds. Fits to min(sx,sy) clamped to [0.2, 3].
        const panZoom = root.COR3.panZoom.create({
            svg, camera, canvasHost, gridLayer, zoomLabel,
            getWorld: () => ({ worldW, worldH }),
            zoomMin: 0.2, zoomMax: 3, fitMin: 0.2, fitMax: 3,
        });
        const fit = () => panZoom.fit();
        fitBtn.addEventListener('click', fit);

        // ── Highlight ──────────────────────────────────────────────────────
        // Drive by the active node id, lighting ONLY the single edge we actually
        // traversed: the previous active node → the current one. The graph is
        // cyclic and DELAY_CYCLE is the convergence of MANY merge edges, so we
        // must NOT light every edge that ENDS at the current node — that would
        // make it look like we came from every block at once. We remember the
        // previous (alias-resolved) active id across calls and light just
        // `prevActive -> aid`. If that pair isn't a defined edge (a jump, or the
        // first activation), no edge lights — only the node pulses.
        let prevActive = null;
        function setActive(activeId) {
            // The 7 SAI flows share ACCESS/COMPLETE display nodes: map a per-flow
            // *_ACCESS / *_COMPLETE step onto the shared node so it lights up.
            const aid = (activeId && NODE_ALIAS[activeId]) || activeId;
            for (const [id, g] of nodeEls) {
                g.classList.toggle('is-active', id === aid);
            }
            // Light only the single traversed edge prevActive -> aid (both ends
            // already alias-resolved: aid here, prevActive when it was stored).
            const activeKey = (aid != null && prevActive != null) ? `${prevActive}->${aid}` : null;
            for (const [key, path] of edgeEls) {
                const on = activeKey != null && key === activeKey;
                path.classList.toggle('is-active', on);
                path.setAttribute('marker-end', on ? 'url(#fm-arrow-active)' : 'url(#fm-arrow)');
            }
            prevActive = aid;
        }

        // DELAY countdown — runs locally between storage writes (the
        // orchestrator is asleep during a delay, so it won't tick the state).
        let delayTimer = null;
        function resetDelay(part) {
            if (part.progressRect) part.progressRect.setAttribute('width', 0);
            if (part.labelEl) part.labelEl.textContent = part.base;
        }
        function stopDelayAnim() {
            if (delayTimer) { clearInterval(delayTimer); delayTimer = null; }
            for (const [, p] of delayParts) resetDelay(p);
        }
        function startDelayAnim(nodeId, startTs) {
            const dur = DELAY_MS[nodeId];
            const part = delayParts.get(nodeId);
            if (!dur || !part) { stopDelayAnim(); return; }
            if (delayTimer) clearInterval(delayTimer);
            for (const [id, p] of delayParts) if (id !== nodeId) resetDelay(p);
            const ts = Number(startTs) || Date.now();
            const tick = () => {
                const elapsed = Date.now() - ts;
                const frac = Math.max(0, Math.min(1, elapsed / dur));
                const remaining = Math.max(0, Math.ceil((dur - elapsed) / 1000));
                if (part.progressRect) part.progressRect.setAttribute('width', (part.innerW * frac).toFixed(1));
                if (part.labelEl) part.labelEl.textContent = `DELAY ${remaining}s`;
            };
            tick();
            delayTimer = setInterval(tick, 150);
        }

        function renderState(state) {
            if (!state || !state.running) {
                stopDelayAnim();
                setActive(null);
                status.textContent = 'idle';
                return;
            }
            setActive(state.node || null);
            if (state.node && DELAY_MS[state.node]) startDelayAnim(state.node, state.updatedAt);
            else stopDelayAnim();
            // Resolve per-flow step ids (ii-access, ic-complete, …) through the
            // same NODE_ALIAS the highlight uses — they aren't in NODES, so a raw
            // byId.get would miss and show the bare id in the status readout.
            const resolvedId = state.node ? (NODE_ALIAS[state.node] || state.node) : null;
            const n = resolvedId ? byId.get(resolvedId) : null;
            const label = n ? n.label : (state.node || '—');
            const cyc = state.cycle ? ` · cycle ${state.cycle}` : '';
            status.textContent = state.error ? `error: ${state.error}` : `${label}${cyc}`;
        }

        // Live progress from the orchestrator.
        const localUnsub = Store.local.onChanged((changes) => {
            if (changes[SL.AJV2_PIPELINE_STATE]) renderState(changes[SL.AJV2_PIPELINE_STATE].newValue);
        });
        Store.local.getOne(SL.AJV2_PIPELINE_STATE, null).then(renderState);

        requestAnimationFrame(() => fit());

        return {
            destroy() {
                if (typeof localUnsub === 'function') localUnsub();
                if (delayTimer) clearInterval(delayTimer);
                panZoom.destroy();
                container.innerHTML = '';
            },
            setActive,
            fit,
        };
    }

    // Split a long UPPER_SNAKE label across at most two lines on underscores
    // when it would overflow the box; short labels stay on one line.
    function wrapLabel(label, boxW) {
        const approx = label.length * CHAR_W;
        if (approx <= boxW - 12 || !label.includes('_')) return [label];
        const parts = label.split('_');
        const mid = Math.ceil(parts.length / 2);
        return [parts.slice(0, mid).join('_'), parts.slice(mid).join('_')];
    }

    root.COR3.uiComponentsV2 = root.COR3.uiComponentsV2 || {};
    root.COR3.uiComponentsV2.flowMap = { attach };
})();
