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

    const CX = 230;         // centre column x
    const RX = 250;         // right column x = CX + RX
    const LOOP_X = 46;      // far-left lane for the loop-back edge

    // type: 'terminal' | 'delay' | 'module' | 'decision'
    // x/y are box CENTRES.
    const NODES = [
        { id: NODE.START,           label: 'START',                       type: 'terminal', x: CX,      y: 40 },
        { id: NODE.DELAY_INITIAL,   label: 'DELAY 10s',                   type: 'delay',    x: CX,      y: 108 },
        { id: NODE.GET_SERVERS,     label: 'GET_SERVERS',                 type: 'module',   x: CX,      y: 180 },
        { id: NODE.CHECK_ACCESS,    label: 'CHECK_SERVERS_ACCESABILITY',  type: 'module',   x: CX,      y: 252 },
        { id: NODE.UPDATE_MARKETS,  label: 'UPDATE_MARKETS',              type: 'module',   x: CX,      y: 324 },
        { id: NODE.JOB_QUEUE,       label: 'JOB_QUEUE',                   type: 'module',   x: CX,      y: 396 },
        { id: NODE.QUEUE_EMPTY,     label: 'QUEUE EMPTY?',                type: 'decision', x: CX,      y: 482 },
        { id: NODE.BUGGED_JOBS,     label: 'BUGGED_JOBS',                 type: 'module',   x: CX + RX, y: 482 },
        { id: NODE.CHECK_CONDITION, label: 'CHECK_JOBS_CONDITION',        type: 'module',   x: CX + RX, y: 566 },
        { id: NODE.DELAY_CYCLE,     label: 'DELAY 30s',                   type: 'delay',    x: CX,      y: 642 },
    ];

    // kind: 'down' (straight vertical), 'right' (horizontal),
    //       'merge' (curve back to centre), 'loop' (orthogonal far-left).
    const EDGES = [
        { from: NODE.START,          to: NODE.DELAY_INITIAL,  kind: 'down' },
        { from: NODE.DELAY_INITIAL,  to: NODE.GET_SERVERS,    kind: 'down' },
        { from: NODE.GET_SERVERS,    to: NODE.CHECK_ACCESS,   kind: 'down' },
        { from: NODE.CHECK_ACCESS,   to: NODE.UPDATE_MARKETS, kind: 'down' },
        { from: NODE.UPDATE_MARKETS, to: NODE.JOB_QUEUE,      kind: 'down' },
        { from: NODE.JOB_QUEUE,      to: NODE.QUEUE_EMPTY,    kind: 'down' },
        { from: NODE.QUEUE_EMPTY,    to: NODE.DELAY_CYCLE,    kind: 'down',  label: 'YES' },
        { from: NODE.QUEUE_EMPTY,    to: NODE.BUGGED_JOBS,    kind: 'right', label: 'NO' },
        { from: NODE.BUGGED_JOBS,    to: NODE.CHECK_CONDITION, kind: 'down' },
        { from: NODE.CHECK_CONDITION, to: NODE.DELAY_CYCLE,   kind: 'merge' },
        { from: NODE.DELAY_CYCLE,    to: NODE.GET_SERVERS,    kind: 'loop',  label: 'loop' },
    ];

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

    function edgePath(edge, byId) {
        const a = byId.get(edge.from);
        const b = byId.get(edge.to);
        const A = anchors(a), B = anchors(b);
        switch (edge.kind) {
            case 'down': {
                const p0 = A.bottom, p1 = B.top;
                const k = (p1.y - p0.y) * 0.5;
                return `M ${p0.x} ${p0.y} C ${p0.x} ${p0.y + k} ${p1.x} ${p1.y - k} ${p1.x} ${p1.y}`;
            }
            case 'right': {
                const p0 = A.right, p1 = B.left;
                return `M ${p0.x} ${p0.y} L ${p1.x} ${p1.y}`;
            }
            case 'merge': {
                // From bottom of the right-column node, curve back left into
                // the right side of the centre delay pill.
                const p0 = A.bottom, p1 = B.right;
                return `M ${p0.x} ${p0.y} C ${p0.x} ${p0.y + 36} ${p1.x + 60} ${p1.y} ${p1.x} ${p1.y}`;
            }
            case 'loop': {
                // Orthogonal lane on the far left: out the left of the delay,
                // left to LOOP_X, up, then right into the left of GET_SERVERS.
                const p0 = A.left, p1 = B.left;
                const r = 9;
                return [
                    `M ${p0.x} ${p0.y}`,
                    `L ${LOOP_X + r} ${p0.y}`,
                    `Q ${LOOP_X} ${p0.y} ${LOOP_X} ${p0.y - r}`,
                    `L ${LOOP_X} ${p1.y + r}`,
                    `Q ${LOOP_X} ${p1.y} ${LOOP_X + r} ${p1.y}`,
                    `L ${p1.x} ${p1.y}`,
                ].join(' ');
            }
            default:
                return '';
        }
    }

    function edgeLabelPos(edge, byId) {
        const a = byId.get(edge.from);
        const b = byId.get(edge.to);
        const A = anchors(a), B = anchors(b);
        switch (edge.kind) {
            case 'down':  return { x: A.bottom.x + 12, y: (A.bottom.y + B.top.y) / 2 };
            case 'right': return { x: (A.right.x + B.left.x) / 2, y: A.right.y - 7 };
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
        const CANVAS_H = 320;

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
        const nodesG = svgEl('g', { class: 'fm-nodes' });
        for (const n of NODES) {
            const g = svgEl('g', { class: `fm-node fm-node-${n.type}`, 'data-id': n.id, transform: `translate(${n.x}, ${n.y})` });
            g.appendChild(nodeShape(n));

            // Multi-line label for the long module names: wrap on underscores
            // so the box can stay reasonably narrow.
            const { w } = nodeSize(n);
            const lines = wrapLabel(n.label, w);
            const startDy = -((lines.length - 1) * 5);
            for (let i = 0; i < lines.length; i++) {
                const tx = svgEl('text', {
                    class: 'fm-node-label',
                    x: 0, y: startDy + i * 10,
                    'text-anchor': 'middle', 'dominant-baseline': 'middle',
                });
                tx.textContent = lines[i];
                g.appendChild(tx);
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

        function renderState(state) {
            if (!state || !state.running) {
                setActive(null);
                status.textContent = 'idle';
                return;
            }
            setActive(state.node || null);
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
