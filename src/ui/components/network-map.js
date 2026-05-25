// Local Network Map renderer for the popup.
//
//   - Positions taken directly from each server's serverPlace[x,y] (the
//     in-game world coordinate). Auto-fitted into the popup canvas via the
//     camera transform — no computed layout, no Reingold-Tilford. Topology
//     is therefore identical to the in-game Network Map.
//   - Colours taken directly from serverColor.{main,secondary,highlighted}
//     shipped per-server in the WS payload. No faction palette table —
//     the game's own colours are used inline as gradient stops + stroke.
//   - Type-glyph (Public/Private/Restricted) rendered from transitType
//     via shared <symbol> definitions in <defs>.
//   - Edges drawn with Manhattan-routed paths (cardinal tail → curve →
//     diagonal → curve → cardinal tail) under a single feGaussianBlur
//     glow filter, matching the in-game ConnectionsLayerStyled look.
//     Active path HOME → currentEndpoint is stroked cyan.
//   - Pan (drag) + zoom (wheel) via a top-level <g> transform; the camera
//     survives storage-driven re-renders. % indicator + Fit button live
//     in a tiny HUD overlay over the canvas.
//   - Subscribes to NM_GRAPH, the three market envelopes, settings, and
//     priorities; component-level destroy() tears the listeners down so
//     re-mounting on tab switch doesn't leak.
//
// API:
//   const handle = uiComponents.networkMap.attach(container);
//   handle.destroy();   // tears down storage + DOM listeners
//   handle.refresh();   // forces a re-render

(function () {
    const root = window;
    if (!root.COR3 || !root.COR3.constants) return;
    const { Store, constants: C } = root.COR3;
    const SL = C.STORAGE_LOCAL;
    const SS = C.STORAGE_SYNC;
    const SVG_NS = 'http://www.w3.org/2000/svg';

    // Compact node geometry. Native cor3.gg nodes are 88×88; we shrink to
    // 60×44 so the full graph fits in the popup at fit-zoom without forcing
    // operators to pan to see a neighbour. World coordinates stay 1:1 with
    // serverPlace so relative positions match the game exactly.
    const NODE_W   = 60;
    const NODE_H   = 44;
    const NODE_FASCIA = 8;  // top-right corner chamfer (px)

    // Edge geometry. Cor3.gg uses tail=6, radius=10 in the live paths we
    // sampled. Same numbers reproduce the railway feel at our scale.
    const EDGE_TAIL = 6;
    const EDGE_RADIUS = 10;

    // serverPlace lives in "logical units" in the WS payload (e.g. [3.5, 2]
    // for a server the game positions at [350, -200] on screen). The game's
    // own renderer multiplies by ~100 and negates Y (game uses cartesian
    // y-up; SVG uses y-down). We do the same on the way into world coords
    // so node spacing + orientation match the in-game layout 1:1.
    const PLACE_SCALE = 50;
    const PLACE_Y_SIGN = -1;

    // Default colour fallbacks when the WS payload doesn't ship a
    // serverColor (very rare, but never crash the renderer over it).
    const DEFAULT_COLOR = { main: '#7D8488', secondary: '#3D4146', highlighted: '#A4A9AC' };
    const EDGE_DEFAULT  = '#828282';
    const EDGE_ACTIVE   = 'rgba(118, 193, 209, 0.75)';

    function svgEl(name, attrs) {
        const e = document.createElementNS(SVG_NS, name);
        if (attrs) for (const k of Object.keys(attrs)) {
            if (attrs[k] != null) e.setAttribute(k, attrs[k]);
        }
        return e;
    }
    function htmlEl(tag, cls, html) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (html !== undefined) e.innerHTML = html;
        return e;
    }
    // Safely turn any server id/name into a string fit for an SVG `id`
    // attribute — gradients reference it via url(#…) and SVG ids reject
    // most punctuation.
    function safeId(s) { return String(s || '').replace(/[^a-zA-Z0-9_-]/g, '_'); }

    // ─── Layout: project serverPlace into world coords ────────────────────
    //
    // Compute the bbox of all servers' serverPlace values, then shift so
    // the world origin is positive (SVG coords don't go negative for our
    // camera setup). Orphans without serverPlace get a synthetic row under
    // the main cluster so the user still sees them.
    function projectPositions(graph) {
        const positions = new Map();   // name → { x, y } in world units
        const placed   = [];
        const orphans  = [];
        for (const s of graph.servers || []) {
            if (s.serverPlace && Number.isFinite(s.serverPlace[0]) && Number.isFinite(s.serverPlace[1])) {
                placed.push(s);
            } else {
                orphans.push(s);
            }
        }
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const s of placed) {
            // Scale + flip Y to match the in-game renderer's coord mapping.
            // Raw serverPlace is the game's logical coord; PLACE_SCALE
            // brings it to "pixels of separation", PLACE_Y_SIGN flips so
            // a "northern" server (raw y > 0) renders above center.
            const x = s.serverPlace[0] * PLACE_SCALE;
            const y = s.serverPlace[1] * PLACE_SCALE * PLACE_Y_SIGN;
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
            positions.set(s.name, { x, y });
        }
        if (!placed.length) { minX = 0; minY = 0; maxX = 0; maxY = 0; }

        // Orphans row: just below the bbox, evenly spaced. They lose
        // topological accuracy but at least show up in the map.
        const ORPHAN_GAP = 120;
        orphans.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        orphans.forEach((s, i) => {
            const x = minX + i * ORPHAN_GAP;
            const y = maxY + 240;
            positions.set(s.name, { x, y });
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
        });

        // Shift to positive coords + add padding for node half-widths.
        const PAD = 80;
        const offsetX = -minX + PAD;
        const offsetY = -minY + PAD;
        for (const p of positions.values()) {
            p.x += offsetX;
            p.y += offsetY;
        }
        const worldW = (maxX - minX) + PAD * 2;
        const worldH = (maxY - minY) + PAD * 2;
        return { positions, worldW, worldH };
    }

    // ─── Classification ───────────────────────────────────────────────────
    function classifyNode(node, ctx) {
        if (!node) return 'ok';
        if (node.name === ctx.homeName) return 'home';
        if (node.isInMaintenance) return 'kd';
        if (ctx.skipSet.has(node.name)) return 'skip';
        if (node.marketId && ctx.disabledMarketIds.has(node.marketId)) return 'off';
        return 'ok';
    }

    // Count available jobs per server. Each market envelope's jobs[] entries
    // carry relatedServers[]; we attribute the job to the first listed server.
    function buildJobCounts(marketsData) {
        const counts = {};
        for (const data of marketsData) {
            if (!data || !Array.isArray(data.jobs)) continue;
            for (const job of data.jobs) {
                const rs = job.relatedServers;
                let name = null;
                if (typeof rs === 'string') name = rs;
                else if (Array.isArray(rs) && rs.length > 0) {
                    const first = rs[0];
                    name = (typeof first === 'string') ? first : (first && (first.name || first.serverName || first.server));
                }
                if (name) counts[name] = (counts[name] || 0) + 1;
            }
        }
        return counts;
    }

    // ─── Edge geometry: cardinal-tail → curve → diagonal → curve → tail ─
    //
    // Reproduces the in-game ConnectionsLayerStyled path pattern:
    //   M a.x a.y  L tailA  Q cornerA endA  L startB  Q cornerB tailB  L b.x b.y
    // The diagonal segment runs between the two "corner-extreme" points
    // (anchor + tail + radius in port direction). Q endpoints sit `radius`
    // along the diagonal from those corners. dirA / dirB are outward unit
    // vectors at each port; the path tail leaves cardinally before curving
    // toward the other node.
    function manhattanPath(ax, ay, bx, by, dirA, dirB, tail, radius) {
        const t = (tail != null) ? tail : EDGE_TAIL;
        const r = (radius != null) ? radius : EDGE_RADIUS;
        const aTX = ax + dirA[0] * t;
        const aTY = ay + dirA[1] * t;
        const bTX = bx + dirB[0] * t;
        const bTY = by + dirB[1] * t;
        const aCX = ax + dirA[0] * (t + r);
        const aCY = ay + dirA[1] * (t + r);
        const bCX = bx + dirB[0] * (t + r);
        const bCY = by + dirB[1] * (t + r);
        const dx = bCX - aCX;
        const dy = bCY - aCY;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len;
        const uy = dy / len;
        // Q endpoint on the A side sits `radius` along the diagonal from
        // the A corner control point — same on the B side, mirrored.
        const aEx = aCX + ux * r;
        const aEy = aCY + uy * r;
        const bSx = bCX - ux * r;
        const bSy = bCY - uy * r;
        return `M ${ax} ${ay} L ${aTX} ${aTY} Q ${aCX} ${aCY} ${aEx} ${aEy} L ${bSx} ${bSy} Q ${bCX} ${bCY} ${bTX} ${bTY} L ${bx} ${by}`;
    }

    // Decide which side of each node hosts the port for an edge. The port
    // closest to the other end-point along the dominant axis wins, matching
    // how the in-game map lays its ports out. Returns { aSide, bSide,
    // aAnchor, bAnchor } where side ∈ {'right','left','top','bottom'} and
    // anchor is the [x,y] on the node's perimeter.
    function pickPortSides(aCenter, bCenter) {
        const dx = bCenter.x - aCenter.x;
        const dy = bCenter.y - aCenter.y;
        let aSide, bSide;
        if (Math.abs(dx) >= Math.abs(dy)) {
            // Horizontal dominance: side ports.
            aSide = dx > 0 ? 'right' : 'left';
            bSide = dx > 0 ? 'left'  : 'right';
        } else {
            aSide = dy > 0 ? 'bottom' : 'top';
            bSide = dy > 0 ? 'top'    : 'bottom';
        }
        const sideAnchor = (center, side) => {
            switch (side) {
                case 'right':  return { x: center.x + NODE_W / 2, y: center.y, dir: [ 1,  0] };
                case 'left':   return { x: center.x - NODE_W / 2, y: center.y, dir: [-1,  0] };
                case 'top':    return { x: center.x, y: center.y - NODE_H / 2, dir: [ 0, -1] };
                case 'bottom': return { x: center.x, y: center.y + NODE_H / 2, dir: [ 0,  1] };
            }
            return { x: center.x, y: center.y, dir: [1, 0] };
        };
        return { a: sideAnchor(aCenter, aSide), b: sideAnchor(bCenter, bSide) };
    }

    // Node body path: rect (60×44) with a top-right corner chamfer.
    // Drawn as a single closed <path> so fill + stroke render in one go.
    function nodePathD() {
        const W = NODE_W;
        const H = NODE_H;
        const F = NODE_FASCIA;
        const R = 3;  // outer corner radius (excluding the chamfer)
        // Walk clockwise: top-left → top-right-pre-chamfer → diag-chamfer →
        // right-side-down → bottom-right → bottom-left → close.
        return [
            `M ${R} 0`,
            `L ${W - F} 0`,
            `L ${W} ${F}`,
            `L ${W} ${H - R}`,
            `Q ${W} ${H} ${W - R} ${H}`,
            `L ${R} ${H}`,
            `Q 0 ${H} 0 ${H - R}`,
            `L 0 ${R}`,
            `Q 0 0 ${R} 0`,
            'Z'
        ].join(' ');
    }

    // ─── Render ───────────────────────────────────────────────────────────
    function render(camera, ctx) {
        while (camera.firstChild) camera.removeChild(camera.firstChild);

        const graph = ctx.graph;
        if (!graph || !Array.isArray(graph.servers) || graph.servers.length === 0) {
            const fg = svgEl('text', {
                x: 160, y: 80, 'text-anchor': 'middle', 'dominant-baseline': 'middle',
                class: 'nm-empty',
            });
            fg.textContent = 'Network Map not loaded yet — open it in-game once.';
            camera.appendChild(fg);
            return { worldW: 320, worldH: 160 };
        }

        const { positions, worldW, worldH } = projectPositions(graph);

        // Per-node colour-gradient defs. Re-created each render so a server
        // whose serverColor changed between snapshots actually updates.
        const defs = svgEl('defs');
        const usedColors = new Map();   // server id → resolved color triple
        for (const s of graph.servers) {
            const col = (s.serverColor && s.serverColor.main) ? s.serverColor : DEFAULT_COLOR;
            const idSafe = safeId(s.id || s.name);
            usedColors.set(s.id || s.name, { col, idSafe });
            const grad = svgEl('linearGradient', {
                id: `nm-grad-${idSafe}`,
                x1: 0, y1: 0, x2: 0, y2: 1,
            });
            const stop1 = svgEl('stop', { offset: '0%',   'stop-color': col.main });
            const stop2 = svgEl('stop', { offset: '100%', 'stop-color': col.secondary || col.main, 'stop-opacity': 0.55 });
            grad.appendChild(stop1);
            grad.appendChild(stop2);
            defs.appendChild(grad);
        }
        camera.appendChild(defs);

        // ── Edges ───────────────────────────────────────────────────────
        //
        // Two layers:
        //   1. Tree edges (parentName-based) — the BFS spanning tree.
        //   2. Extra edges — every connection in graph.connections that
        //      isn't already covered by the tree (the map is a DAG with
        //      multi-parent nodes).
        //
        // Active path HOME → currentEndpoint gets cyan stroke. We index
        // homePath as an unordered pair set for cheap lookup.
        const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
        const activeSet = new Set();
        for (const e of (graph.homePath || [])) {
            if (e && e.a && e.b) activeSet.add(pairKey(e.a, e.b));
        }
        const isActive = (a, b) => activeSet.has(pairKey(a, b));

        const edgesG = svgEl('g', { class: 'nm-edges' });

        const treePairs = new Set();
        for (const s of graph.servers) {
            if (!s.parentName) continue;
            const pa = positions.get(s.parentName);
            const pb = positions.get(s.name);
            if (!pa || !pb) continue;
            const ports = pickPortSides(pa, pb);
            const d = manhattanPath(ports.a.x, ports.a.y, ports.b.x, ports.b.y, ports.a.dir, ports.b.dir);
            const stroke = isActive(s.parentName, s.name) ? EDGE_ACTIVE : EDGE_DEFAULT;
            edgesG.appendChild(svgEl('path', {
                d,
                class: 'nm-edge' + (isActive(s.parentName, s.name) ? ' nm-edge-active' : '') + (s.viaHidden ? ' nm-edge-hidden' : ''),
                stroke,
            }));
            treePairs.add(pairKey(s.parentName, s.name));
        }

        const allConns = Array.isArray(graph.connections) ? graph.connections : [];
        for (const c of allConns) {
            if (!c.a || !c.b) continue;
            const key = pairKey(c.a, c.b);
            if (treePairs.has(key)) continue;
            const pa = positions.get(c.a);
            const pb = positions.get(c.b);
            if (!pa || !pb) continue;
            const ports = pickPortSides(pa, pb);
            const d = manhattanPath(ports.a.x, ports.a.y, ports.b.x, ports.b.y, ports.a.dir, ports.b.dir);
            const stroke = isActive(c.a, c.b) ? EDGE_ACTIVE : EDGE_DEFAULT;
            edgesG.appendChild(svgEl('path', {
                d,
                class: 'nm-edge nm-edge-extra' + (isActive(c.a, c.b) ? ' nm-edge-active' : '') + (c.isHidden ? ' nm-edge-hidden' : ''),
                stroke,
            }));
        }

        camera.appendChild(edgesG);

        // ── Nodes ───────────────────────────────────────────────────────
        const nodeBodyD = nodePathD();
        const cardsG = svgEl('g', { class: 'nm-cards' });
        for (const s of graph.servers) {
            const pos = positions.get(s.name);
            if (!pos) continue;
            const cls = classifyNode(s, ctx);
            const { col, idSafe } = usedColors.get(s.id || s.name);
            // Translate so the node's top-left sits at (pos - half size).
            const tx = Math.round(pos.x - NODE_W / 2);
            const ty = Math.round(pos.y - NODE_H / 2);
            const isHome = s.serverTypeName === 'Home' || s.name === ctx.homeName;
            const isActiveEndpoint = ctx.currentEndpointName && s.name === ctx.currentEndpointName;

            const g = svgEl('g', {
                class: `nm-node nm-state-${cls}${isHome ? ' nm-home' : ''}${isActiveEndpoint ? ' nm-active' : ''}`,
                'data-name': s.name,
                transform: `translate(${tx}, ${ty})`,
            });

            // Body — gradient fill + faction-coloured stroke.
            g.appendChild(svgEl('path', {
                class: 'nm-card',
                d: nodeBodyD,
                fill: `url(#nm-grad-${idSafe})`,
                'fill-opacity': cls === 'off' ? 0.2 : 0.4,
                stroke: col.main,
                'stroke-opacity': cls === 'off' ? 0.3 : 0.65,
                'stroke-width': isHome || isActiveEndpoint ? 1.5 : 1,
            }));

            // Type-glyph (Public/Private/Restricted) centred. Skip for
            // HOME — its faction colour already says "home" at a glance.
            const glyph = !isHome && s.transitType ? `nm-glyph-${s.transitType}` : null;
            if (glyph) {
                const G = 16;
                g.appendChild(svgEl('use', {
                    href: `#${glyph}`,
                    x: (NODE_W - G) / 2,
                    y: NODE_H - G - 4,
                    width: G,
                    height: G,
                    fill: col.main,
                    'fill-opacity': 0.55,
                }));
            }

            // Server name — small caps near the top of the card.
            const nameTrim = (s.name || '').replace(/^RM7-/, '').slice(0, 9);
            const lbl = svgEl('text', {
                x: NODE_W / 2,
                y: 12,
                class: 'nm-name',
                'text-anchor': 'middle',
            });
            lbl.textContent = nameTrim || '?';
            g.appendChild(lbl);

            // Corner brackets — appear on hover/selected/active via CSS.
            // Each is a 5×5 "L" path positioned just outside one corner of
            // the body; CSS translates them further outward on hover for
            // the cor3.gg pop-out feel.
            const cornerSize = 5;
            const cornerColor = col.highlighted || col.main;
            const brackets = [
                { cls: 'nm-corner nm-corner-tl', d: `M 0 ${cornerSize} L 0 0 L ${cornerSize} 0`,                 tx: -2, ty: -2 },
                { cls: 'nm-corner nm-corner-tr', d: `M ${-cornerSize} 0 L 0 0 L 0 ${cornerSize}`,                 tx: NODE_W + 2, ty: -2 },
                { cls: 'nm-corner nm-corner-bl', d: `M 0 ${-cornerSize} L 0 0 L ${cornerSize} 0`,                 tx: -2, ty: NODE_H + 2 },
                { cls: 'nm-corner nm-corner-br', d: `M ${-cornerSize} 0 L 0 0 L 0 ${-cornerSize}`,                tx: NODE_W + 2, ty: NODE_H + 2 },
            ];
            for (const b of brackets) {
                g.appendChild(svgEl('path', {
                    class: b.cls,
                    d: b.d,
                    transform: `translate(${b.tx}, ${b.ty})`,
                    stroke: cornerColor,
                    'stroke-width': 1.2,
                    fill: 'none',
                }));
            }

            // K/D badge (top-right of the body, above the fascia).
            if (cls === 'kd') {
                const bg = svgEl('g', { class: 'nm-kd-badge', transform: `translate(${NODE_W - 22}, -7)` });
                bg.appendChild(svgEl('rect', { x: 0, y: 0, width: 22, height: 10, rx: 2, ry: 2, class: 'nm-kd-bg' }));
                const tx = svgEl('text', { x: 11, y: 7.5, class: 'nm-kd-text' });
                tx.textContent = 'K/D';
                bg.appendChild(tx);
                g.appendChild(bg);
            }

            // Jobs badge — bottom-right corner circle with the count.
            const jobs = ctx.jobCounts[s.name] || 0;
            if (jobs > 0) {
                const bg = svgEl('g', { class: 'nm-jobs-badge', transform: `translate(${NODE_W - 8}, ${NODE_H - 8})` });
                bg.appendChild(svgEl('circle', { r: 7, class: 'nm-badge-circle' }));
                const t = svgEl('text', { y: 3, 'text-anchor': 'middle', class: 'nm-badge-text' });
                t.textContent = jobs > 99 ? '99+' : String(jobs);
                bg.appendChild(t);
                g.appendChild(bg);
            }

            // "NEW" pill — game flags fresh servers. Small white tag,
            // bottom-left of the body.
            if (s.isNew) {
                const bg = svgEl('g', { class: 'nm-new-badge', transform: `translate(3, ${NODE_H - 12})` });
                bg.appendChild(svgEl('rect', { x: 0, y: 0, width: 18, height: 9, rx: 1.5, ry: 1.5, class: 'nm-new-bg' }));
                const t = svgEl('text', { x: 9, y: 7, class: 'nm-new-text' });
                t.textContent = 'NEW';
                bg.appendChild(t);
                g.appendChild(bg);
            }

            // Tooltip via native <title>. Keeps the popup chrome-free.
            const title = svgEl('title');
            const parts = [s.name];
            if (s.serverTypeName)        parts.push(s.serverTypeName);
            if (s.cluster)               parts.push(`cluster: ${s.cluster}`);
            if (Number.isFinite(s.depth)) parts.push(`depth: ${s.depth}${s.viaHidden ? ' (via hidden)' : ''}`);
            if (s.parentName)            parts.push(`from: ${s.parentName}`);
            if (isActiveEndpoint)        parts.push('← current endpoint');
            if (cls === 'kd')            parts.push('K/D — temporarily in maintenance');
            if (cls === 'skip')          parts.push('user-skipped');
            if (cls === 'off')           parts.push('market disabled in settings');
            if (jobs > 0)                parts.push(`${jobs} job(s) available`);
            title.textContent = parts.join('\n');
            g.appendChild(title);

            cardsG.appendChild(g);
        }
        camera.appendChild(cardsG);

        return { worldW, worldH };
    }

    // Build the shared <defs> that the camera references via url(#…).
    // Lives in the root <svg> (outside camera) so it's not wiped between
    // renders. Type-glyph <symbol>s come from the in-game legend SVGs
    // (legend-icons.tsx) so the shapes are pixel-identical.
    function ensureSharedDefs(svg) {
        if (svg.querySelector('defs.nm-shared-defs')) return;
        const defs = svgEl('defs', { class: 'nm-shared-defs' });

        // Edge glow filter — feGaussianBlur stdDeviation=2 (lighter than
        // the game's 4 because our compact node spacing would otherwise
        // bleed the glow across neighbours).
        const filter = svgEl('filter', {
            id: 'nm-glow-line',
            x: '-50%', y: '-50%', width: '200%', height: '200%',
        });
        filter.appendChild(svgEl('feGaussianBlur', { stdDeviation: 2, result: 'blur' }));
        const merge = svgEl('feMerge');
        merge.appendChild(svgEl('feMergeNode', { in: 'blur' }));
        merge.appendChild(svgEl('feMergeNode', { in: 'SourceGraphic' }));
        filter.appendChild(merge);
        defs.appendChild(filter);

        // Type-glyph symbols. Coords are 24×24 (Public/Restricted) or 20×20
        // (Private); SVG <use> scales them to whatever width/height we set
        // on the use element.
        //
        // Public: 4 triangles forming a 4-petal star/diamond.
        const pub = svgEl('symbol', { id: 'nm-glyph-public', viewBox: '0 0 24 24' });
        const pubPaths = [
            'M12.047 2.35352L16.9375 10.8241H7.15646L12.047 2.35352Z',
            'M12.0472 20.5176L7.15666 12.047L16.9377 12.047L12.0472 20.5176Z',
            'M5.92941 12.2354L10.8199 20.7059H1.03891L5.92941 12.2354Z',
            'M18.1649 12.2354L23.0554 20.7059H13.2744L18.1649 12.2354Z',
        ];
        for (const d of pubPaths) pub.appendChild(svgEl('path', { d }));
        defs.appendChild(pub);

        // Private: 4 quarter-disc petals.
        const priv = svgEl('symbol', { id: 'nm-glyph-private', viewBox: '0 0 20 20' });
        const privPaths = [
            'M9.28418 10.7178V20.001C4.31684 19.6501 0.350896 15.6851 0 10.7178H9.28418Z',
            'M20.002 10.7178C19.6511 15.6851 15.6851 19.6501 10.7178 20.001V10.7178H20.002Z',
            'M10.7178 0C15.6852 0.350889 19.6511 4.31679 20.002 9.28418H10.7178V0Z',
            'M9.28418 9.28418H0C0.350878 4.31679 4.3168 0.350889 9.28418 0V9.28418Z',
        ];
        for (const d of privPaths) priv.appendChild(svgEl('path', { d }));
        defs.appendChild(priv);

        // Restricted: 4 rotated squares (diamonds) in 2×2 arrangement.
        const restricted = svgEl('symbol', { id: 'nm-glyph-restricted', viewBox: '0 0 24 24' });
        const rects = [
            { y: 11.6035, x: 0,        rot: '-45 0 11.6035' },
            { y: 5.15723, x: 6.44604, rot: '-45 6.44604 5.15723' },
            { y: 18.0498, x: 6.44604, rot: '-45 6.44604 18.0498' },
            { y: 11.6035, x: 12.8921, rot: '-45 12.8921 11.6035' },
        ];
        for (const r of rects) {
            restricted.appendChild(svgEl('rect', {
                x: r.x, y: r.y, width: 7.29293, height: 7.29293, transform: `rotate(${r.rot})`,
            }));
        }
        defs.appendChild(restricted);

        // Insert defs as the first child so renders below it can reference.
        if (svg.firstChild) svg.insertBefore(defs, svg.firstChild);
        else svg.appendChild(defs);
    }

    // ─── Pan + Zoom (camera transform) ────────────────────────────────────
    function attach(container) {
        container.classList.add('network-map-host');
        container.innerHTML = '';

        const wrap = htmlEl('div', 'network-map-wrap');
        const titleRow = htmlEl('div', 'network-map-title');
        titleRow.innerHTML = `
            <span class="card-label">Network Map</span>
            <span class="muted xs nm-summary-status"></span>
        `;
        wrap.appendChild(titleRow);

        const canvasHost = htmlEl('div', 'network-map-canvas');

        // Background grid layer (sized to the world, scrolled by the camera
        // transform). Lives behind the <svg> so the dotted lattice stays
        // perfectly aligned with the SVG content under pan+zoom.
        const gridLayer = htmlEl('div', 'network-map-grid');
        canvasHost.appendChild(gridLayer);

        // HUD: zoom %, Refresh button, Fit button.
        const hud = htmlEl('div', 'nm-hud');
        const zoomLabel = htmlEl('span', 'nm-hud-zoom muted xs', '100%');
        const refreshBtn = htmlEl('button', 'btn small nm-hud-btn', '↻');
        refreshBtn.title = 'Force-refresh Network Map from cor3.gg (cor3 only pushes graph updates when you open NM in-game)';
        const fitBtn = htmlEl('button', 'btn small nm-hud-btn', 'Fit');
        fitBtn.title = 'Reset zoom and center';
        hud.appendChild(zoomLabel);
        hud.appendChild(refreshBtn);
        hud.appendChild(fitBtn);
        canvasHost.appendChild(hud);

        refreshBtn.addEventListener('click', async () => {
            try {
                refreshBtn.disabled = true;
                refreshBtn.textContent = '…';
                const tabs = await chrome.tabs.query({ url: ['https://cor3.gg/*', 'https://os.cor3.gg/*'] });
                if (tabs && tabs[0]) {
                    chrome.tabs.sendMessage(tabs[0].id, { action: 'rescanNetworkMap' }).catch(() => {});
                }
            } catch (_) { /* ignore */ }
            setTimeout(() => { refreshBtn.disabled = false; refreshBtn.textContent = '↻'; }, 1500);
        });

        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('class', 'network-map-svg');
        svg.setAttribute('width', '100%');
        canvasHost.appendChild(svg);

        ensureSharedDefs(svg);

        const camera = svgEl('g', { class: 'nm-camera' });
        svg.appendChild(camera);

        wrap.appendChild(canvasHost);
        container.appendChild(wrap);

        // ── Camera state ────────────────────────────────────────────────
        const cam = { x: 0, y: 0, zoom: 1, world: { worldW: 320, worldH: 160 } };
        const ZOOM_MIN = 0.15, ZOOM_MAX = 3;

        function applyCamera() {
            const z = Number.isFinite(cam.zoom) && cam.zoom > 0 ? cam.zoom : 1;
            const x = Number.isFinite(cam.x) ? cam.x : 0;
            const y = Number.isFinite(cam.y) ? cam.y : 0;
            cam.zoom = z; cam.x = x; cam.y = y;
            camera.setAttribute('transform', `translate(${x}, ${y}) scale(${z})`);
            // Grid layer follows the camera so the dotted lattice stays
            // glued to the world coords. background-position scrolls;
            // background-size scales with the zoom (so 70-unit world grid
            // matches the camera scale).
            const gridUnit = 70 * z;
            const gridSub  = 35 * z;
            gridLayer.style.backgroundPosition = `${x}px ${y}px, ${x + gridSub}px ${y + gridSub}px, ${x}px ${y}px, ${x}px ${y}px, ${x}px ${y}px, ${x}px ${y}px`;
            gridLayer.style.backgroundSize = `${gridUnit}px ${gridUnit}px, ${gridUnit}px ${gridUnit}px, ${gridUnit}px ${gridUnit}px, ${gridUnit}px ${gridUnit}px, ${gridSub}px ${gridSub}px, ${gridSub}px ${gridSub}px`;
            zoomLabel.textContent = Math.round(z * 100) + '%';
        }

        function fit() {
            const rect = svg.getBoundingClientRect();
            const ww = (cam.world && cam.world.worldW) || 0;
            const wh = (cam.world && cam.world.worldH) || 0;
            if (rect.width <= 0 || rect.height <= 0 || ww <= 0 || wh <= 0) {
                cam.x = 0; cam.y = 0; cam.zoom = 1;
                applyCamera();
                return;
            }
            const sx = rect.width  / ww;
            const sy = rect.height / wh;
            // Fit-to-world but clamp to a readable minimum: in-game coord
            // ranges easily span 2000+ units (counting D4RK/SRM side
            // networks), which would zoom the home cluster down to noise.
            // FIT_MIN keeps the default view readable; user pans/zooms
            // out further via wheel if they want the whole expanse.
            const FIT_MIN = 0.35;
            const z = Math.max(FIT_MIN, Math.min(sx, sy, 1.2));
            cam.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
            cam.x = (rect.width  - ww * cam.zoom) / 2;
            cam.y = (rect.height - wh * cam.zoom) / 2;
            applyCamera();
        }

        // ── Drag-to-pan ─────────────────────────────────────────────────
        let dragging = null;
        svg.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            const targetTag = (e.target.tagName || '').toLowerCase();
            if (targetTag === 'a' || targetTag === 'button' || targetTag === 'input') return;
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

        // ── Wheel-to-zoom ───────────────────────────────────────────────
        function onWheel(e) {
            const rect = svg.getBoundingClientRect();
            if (e.clientX < rect.left || e.clientX > rect.right ||
                e.clientY < rect.top  || e.clientY > rect.bottom) return;
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

        // ── Refresh / data ──────────────────────────────────────────────
        const summaryStatus = wrap.querySelector('.nm-summary-status');
        let firstRender = true;

        async function refresh() {
            const [graph, settings, priorities, home, dark, srm] = await Promise.all([
                Store.local.getOne(SL.NM_GRAPH, null),
                Store.sync.getOne(SS.AUTOJOBS_SETTINGS, { markets: { home: true, dark: true, srm: true } }),
                Store.sync.getOne(SS.SERVER_PRIORITIES, {}),
                Store.local.getOne(SL.MARKET, null),
                Store.local.getOne(SL.DARK_MARKET, null),
                Store.local.getOne(SL.SRM_MARKET, null),
            ]);
            const skipSet = new Set();
            for (const [name, val] of Object.entries(priorities || {})) {
                if (val === 'skip') skipSet.add(name);
            }
            const disabledMarketIds = new Set();
            const m = settings.markets || {};
            if (m.home === false && home && home.marketId) disabledMarketIds.add(home.marketId);
            if (m.dark === false && dark && dark.marketId) disabledMarketIds.add(dark.marketId);
            if (m.srm  === false && srm  && srm.marketId)  disabledMarketIds.add(srm.marketId);

            const ctx = {
                graph,
                homeName: graph?.home || null,
                currentEndpointName: graph?.currentEndpointName || null,
                skipSet,
                disabledMarketIds,
                jobCounts: buildJobCounts([home, dark, srm]),
            };

            const dims = render(camera, ctx);
            cam.world = dims;
            // Fixed visual height in the popup — pan/zoom the camera
            // inside this box. Grid layer is `position: absolute; inset: 0`
            // so it follows canvasHost height automatically.
            const visualHeight = 320;
            svg.style.height = visualHeight + 'px';

            if (summaryStatus) {
                if (!graph) {
                    summaryStatus.textContent = '— no graph yet';
                } else {
                    const N = graph.servers.length;
                    const kd = graph.servers.filter((s) => s.isInMaintenance).length;
                    summaryStatus.textContent = `${N} servers${kd > 0 ? `, ${kd} K/D` : ''}`;
                }
            }
            if (firstRender) {
                firstRender = false;
                requestAnimationFrame(() => fit());
            } else {
                applyCamera();
            }
        }

        const localUnsub = Store.local.onChanged((c) => {
            if (c[SL.NM_GRAPH] || c[SL.MARKET] || c[SL.DARK_MARKET] || c[SL.SRM_MARKET] || c[SL.AJ_REACHABILITY]) refresh();
        });
        const syncUnsub = Store.sync.onChanged((c) => {
            if (c[SS.AUTOJOBS_SETTINGS] || c[SS.SERVER_PRIORITIES]) refresh();
        });

        let resizeTimer = null;
        const resizeObs = ('ResizeObserver' in window) ? new ResizeObserver(() => {
            if (resizeTimer) clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => fit(), 150);
        }) : null;
        if (resizeObs) resizeObs.observe(canvasHost);

        refresh();

        return {
            destroy() {
                if (typeof localUnsub === 'function') localUnsub();
                if (typeof syncUnsub === 'function') syncUnsub();
                if (resizeObs) resizeObs.disconnect();
                if (resizeTimer) clearTimeout(resizeTimer);
                canvasHost.removeEventListener('wheel', onWheel, { capture: true });
                container.innerHTML = '';
            },
            refresh,
            fit,
        };
    }

    root.COR3 = root.COR3 || {};
    root.COR3.uiComponents = root.COR3.uiComponents || {};
    root.COR3.uiComponents.networkMap = { attach };
})();
