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

    // type: 'terminal' | 'delay' | 'module' | 'decision'
    // x/y are box CENTRES.
    //
    // Lanes: centre = main descent + the "queue empty → wait" YES bypass;
    // mid-right = the NO-branch execution chain; the two right lanes hold the
    // in-progress BUGGED? detour. All four decision/skip boxes share one row so
    // their branches are clean horizontals.
    const NODES = [
        { id: NODE.START,           label: 'START',                       type: 'terminal', x: CX,    y: 40 },
        { id: NODE.DELAY_INITIAL,   label: 'DELAY 10s',                   type: 'delay',    x: CX,    y: 108 },
        { id: NODE.GET_SERVERS,     label: 'GET_SERVERS',                 type: 'module',   x: CX,    y: 180 },
        { id: NODE.CHECK_ACCESS,    label: 'CHECK_SERVERS_ACCESABILITY',  type: 'module',   x: CX,    y: 252 },
        { id: NODE.UPDATE_MARKETS,  label: 'UPDATE_MARKETS',              type: 'module',   x: CX,    y: 324 },
        { id: NODE.JOB_QUEUE,       label: 'JOB_QUEUE',                   type: 'module',   x: CX,    y: 396 },
        { id: NODE.QUEUE_EMPTY,     label: 'QUEUE EMPTY?',                type: 'decision', x: CX,    y: ROW_DECISION },
        { id: NODE.HAVE_TASKS_IN_PROGRESS, label: 'IN PROGRESS?',         type: 'decision', x: COL_2, y: ROW_DECISION },
        { id: NODE.BUGGED_JOBS,     label: 'BUGGED?',                     type: 'decision', x: COL_3, y: ROW_DECISION },
        { id: NODE.JOB_SKIP,        label: 'JOB:SKIP',                    type: 'module',   x: COL_4, y: ROW_DECISION },
        { id: NODE.CHECK_CONDITION, label: 'CHECK_JOBS_CONDITION',        type: 'module',   x: COL_2, y: 626 },
        { id: NODE.JOB_ACCEPTION,   label: 'JOB_ACCEPTION',               type: 'module',   x: COL_2, y: 694 },
        { id: NODE.JOB_FLOW,        label: 'JOB_FLOW',                    type: 'module',   x: COL_2, y: 762 },
        { id: NODE.DELAY_CYCLE,     label: 'DELAY 30s',                   type: 'delay',    x: CX,    y: 856 },
    ];

    // All edges route orthogonally (right-angle elbows, rounded corners).
    // kind: 'down' (A.bottom → B.top), 'right' (A.right → B.left),
    //       'merge' (elbow into B; `enter` = 'right' into B's right side, or
    //       'top' across then down into B's top), 'loop' (far-left lane).
    const EDGES = [
        { from: NODE.START,          to: NODE.DELAY_INITIAL,  kind: 'down' },
        { from: NODE.DELAY_INITIAL,  to: NODE.GET_SERVERS,    kind: 'down' },
        { from: NODE.GET_SERVERS,    to: NODE.CHECK_ACCESS,   kind: 'down' },
        { from: NODE.CHECK_ACCESS,   to: NODE.UPDATE_MARKETS, kind: 'down' },
        { from: NODE.UPDATE_MARKETS, to: NODE.JOB_QUEUE,      kind: 'down' },
        { from: NODE.JOB_QUEUE,      to: NODE.QUEUE_EMPTY,    kind: 'down' },
        { from: NODE.QUEUE_EMPTY,    to: NODE.DELAY_CYCLE,    kind: 'down',  label: 'YES' },
        { from: NODE.QUEUE_EMPTY,    to: NODE.HAVE_TASKS_IN_PROGRESS, kind: 'right', label: 'NO' },
        { from: NODE.HAVE_TASKS_IN_PROGRESS, to: NODE.CHECK_CONDITION, kind: 'down',  label: 'NO' },
        { from: NODE.HAVE_TASKS_IN_PROGRESS, to: NODE.BUGGED_JOBS,     kind: 'right', label: 'YES' },
        { from: NODE.BUGGED_JOBS,    to: NODE.JOB_SKIP,        kind: 'right', label: 'YES' },
        { from: NODE.BUGGED_JOBS,    to: NODE.CHECK_CONDITION, kind: 'merge', enter: 'right', label: 'NO' },
        { from: NODE.JOB_SKIP,       to: NODE.DELAY_CYCLE,     kind: 'merge', enter: 'right' },
        { from: NODE.CHECK_CONDITION, to: NODE.JOB_ACCEPTION,  kind: 'down' },
        { from: NODE.JOB_ACCEPTION,  to: NODE.JOB_FLOW,        kind: 'down' },
        { from: NODE.JOB_FLOW,       to: NODE.DELAY_CYCLE,     kind: 'merge', enter: 'top' },
        { from: NODE.DELAY_CYCLE,    to: NODE.GET_SERVERS,     kind: 'loop',  label: 'loop' },
    ];

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
                const midX = (p0.x + p1.x) / 2;
                return [p0, { x: midX, y: p0.y }, { x: midX, y: p1.y }, p1];
            }
            case 'merge': {
                if (edge.enter === 'top') {
                    // Across at A's bottom-y to B's column, then down into B.top.
                    return [A.bottom, { x: B.top.x, y: A.bottom.y }, B.top];
                }
                // 'right': down to B's centre-y, then across into B's right side.
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
            case 'right': return { x: (A.right.x + B.left.x) / 2, y: A.right.y - 7 };
            case 'merge':
                if (edge.enter === 'top') return { x: (A.bottom.x + B.top.x) / 2, y: A.bottom.y - 7 };
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

        // ── Camera (pan / wheel-zoom / fit) — mirrors network-map ──────────
        const cam = { x: 0, y: 0, zoom: 1 };
        const ZOOM_MIN = 0.2, ZOOM_MAX = 3;

        function applyCamera() {
            const z = Number.isFinite(cam.zoom) && cam.zoom > 0 ? cam.zoom : 1;
            const x = Number.isFinite(cam.x) ? cam.x : 0;
            const y = Number.isFinite(cam.y) ? cam.y : 0;
            cam.zoom = z; cam.x = x; cam.y = y;
            camera.setAttribute('transform', `translate(${x}, ${y}) scale(${z})`);
            const gridUnit = 70 * z;
            const gridSub = 35 * z;
            gridLayer.style.backgroundPosition = `${x}px ${y}px, ${x + gridSub}px ${y + gridSub}px, ${x}px ${y}px, ${x}px ${y}px, ${x}px ${y}px, ${x}px ${y}px`;
            gridLayer.style.backgroundSize = `${gridUnit}px ${gridUnit}px, ${gridUnit}px ${gridUnit}px, ${gridUnit}px ${gridUnit}px, ${gridUnit}px ${gridUnit}px, ${gridSub}px ${gridSub}px, ${gridSub}px ${gridSub}px`;
            zoomLabel.textContent = Math.round(z * 100) + '%';
        }

        function fit() {
            const rect = svg.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0 || worldW <= 0 || worldH <= 0) {
                cam.x = 0; cam.y = 0; cam.zoom = 1;
                applyCamera();
                return;
            }
            const sx = rect.width / worldW;
            const sy = rect.height / worldH;
            const z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.min(sx, sy)));
            cam.zoom = z;
            cam.x = (rect.width - worldW * z) / 2;
            cam.y = (rect.height - worldH * z) / 2;
            applyCamera();
        }

        let dragging = null;
        svg.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            const tag = (e.target.tagName || '').toLowerCase();
            if (tag === 'button') return;
            dragging = { startX: e.clientX, startY: e.clientY, camX: cam.x, camY: cam.y };
            try { svg.setPointerCapture(e.pointerId); } catch (_) {}
            svg.classList.add('nm-grabbing');
            e.preventDefault();
        });
        svg.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            cam.x = dragging.camX + (e.clientX - dragging.startX);
            cam.y = dragging.camY + (e.clientY - dragging.startY);
            applyCamera();
        });
        function endDrag(e) {
            if (!dragging) return;
            try { svg.releasePointerCapture(e.pointerId); } catch (_) {}
            dragging = null;
            svg.classList.remove('nm-grabbing');
        }
        svg.addEventListener('pointerup', endDrag);
        svg.addEventListener('pointercancel', endDrag);

        function onWheel(e) {
            const rect = svg.getBoundingClientRect();
            if (e.clientX < rect.left || e.clientX > rect.right ||
                e.clientY < rect.top || e.clientY > rect.bottom) return;
            e.preventDefault();
            e.stopPropagation();
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;
            const factor = e.deltaY < 0 ? 1.12 : (1 / 1.12);
            const newZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, cam.zoom * factor));
            const worldX = (mx - cam.x) / cam.zoom;
            const worldY = (my - cam.y) / cam.zoom;
            cam.zoom = newZoom;
            cam.x = mx - worldX * newZoom;
            cam.y = my - worldY * newZoom;
            applyCamera();
        }
        canvasHost.addEventListener('wheel', onWheel, { passive: false, capture: true });

        fitBtn.addEventListener('click', () => fit());

        let resizeTimer = null;
        const resizeObs = ('ResizeObserver' in window) ? new ResizeObserver(() => {
            if (resizeTimer) clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => fit(), 150);
        }) : null;
        if (resizeObs) resizeObs.observe(canvasHost);

        // ── Highlight ──────────────────────────────────────────────────────
        // Drive purely by the active node id (the graph is cyclic, so there is
        // no single "path taken" to colour). The active node pulses; the edges
        // leading INTO it light up.
        function setActive(activeId) {
            for (const [id, g] of nodeEls) {
                g.classList.toggle('is-active', id === activeId);
            }
            for (const [key, path] of edgeEls) {
                const toId = key.split('->')[1];
                const on = activeId != null && toId === activeId;
                path.classList.toggle('is-active', on);
                path.setAttribute('marker-end', on ? 'url(#fm-arrow-active)' : 'url(#fm-arrow)');
            }
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
            const n = state.node ? byId.get(state.node) : null;
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
                if (resizeObs) resizeObs.disconnect();
                if (resizeTimer) clearTimeout(resizeTimer);
                canvasHost.removeEventListener('wheel', onWheel, { capture: true });
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
