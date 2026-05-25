// Local Network Map renderer for the popup.
//
//   - Tree layout (Reingold-Tilford-lite — recursive subtree-sizing so siblings
//     never overlap and parents centre over their children).
//   - Card-style nodes mirroring the in-game look: rounded rectangle with a
//     faction-tinted left stripe, the server name inside, an availability
//     dot, and a K/D corner badge when the server is in maintenance.
//   - Pan (drag) + zoom (wheel) via a top-level <g> transform; the SVG
//     itself is fixed-size, the camera is what moves. % indicator + Fit
//     button live in a tiny HUD overlay over the canvas.
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

    // Card geometry — SVG units. Picked to fit ~7 chars of typical server names
    // ("RM7-E1L1") with a faction stripe + status dot.
    const NODE_W       = 92;
    const NODE_H       = 38;
    const COL_GAP      = 22;       // px between columns
    const ROW_GAP      = 26;       // px between rows
    const PADDING      = 18;       // around the whole graph

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

    // ─── Layout: Reingold-Tilford-lite ────────────────────────────────────
    //
    // For each tree, recursively determine the leaf-level x of every node.
    // Internal-node x is the midpoint of its children's xs (so parents
    // always sit centred above their subtree). Sibling subtrees are placed
    // contiguously without ever overlapping. y comes from BFS depth so the
    // layered look matches the in-game vertical structure.
    //
    // Disconnected components (orphan nodes that have no parentName but
    // aren't HOME — e.g. a side-network we haven't traversed yet) become
    // separate roots placed side by side with a small inter-component gap.
    function layoutTree(graph) {
        const byName = new Map();
        const childrenOf = new Map();
        const roots = [];
        for (const s of (graph.servers || [])) {
            byName.set(s.name, s);
        }
        for (const s of (graph.servers || [])) {
            if (s.parentName && byName.has(s.parentName)) {
                if (!childrenOf.has(s.parentName)) childrenOf.set(s.parentName, []);
                childrenOf.get(s.parentName).push(s);
            } else {
                roots.push(s);
            }
        }
        // Stable child ordering — name sort gives deterministic layouts so
        // re-renders after a graph update don't reshuffle siblings.
        for (const arr of childrenOf.values()) {
            arr.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        }
        // HOME first among roots; the rest sorted by name.
        roots.sort((a, b) => {
            const aHome = (a.name === graph.home) ? 0 : 1;
            const bHome = (b.name === graph.home) ? 0 : 1;
            if (aHome !== bHome) return aHome - bHome;
            return (a.name || '').localeCompare(b.name || '');
        });

        const positions = new Map();   // name → { col, row }
        let cursor = 0;

        function place(name, depth) {
            const node = byName.get(name);
            if (!node) return { width: 0, leftCol: 0, rightCol: 0 };
            const kids = childrenOf.get(name) || [];
            if (kids.length === 0) {
                positions.set(name, { col: cursor, row: depth });
                cursor += 1;
                return { width: 1, leftCol: cursor - 1, rightCol: cursor - 1 };
            }
            // First child anchors leftCol; we centre the parent over the
            // span between first leaf and last leaf of its subtree.
            const firstCol = cursor;
            const childResults = [];
            for (const k of kids) childResults.push(place(k.name, depth + 1));
            const lastCol = cursor - 1;
            // Parent's column is the midpoint between the leftmost-placed
            // child and the rightmost-placed child columns. This keeps
            // hub nodes visually balanced over their subtrees.
            const firstChildCol = positions.get(kids[0].name).col;
            const lastChildCol  = positions.get(kids[kids.length - 1].name).col;
            const parentCol = (firstChildCol + lastChildCol) / 2;
            positions.set(name, { col: parentCol, row: depth });
            return { width: lastCol - firstCol + 1, leftCol: firstCol, rightCol: lastCol };
        }

        const COMPONENT_GAP = 1.5;
        for (const r of roots) {
            const baseDepth = Number.isFinite(r.depth) ? r.depth : 0;
            place(r.name, baseDepth);
            cursor = Math.ceil(cursor) + COMPONENT_GAP;
        }

        // Compute world bounds.
        let maxRow = 0;
        let maxCol = 0;
        for (const p of positions.values()) {
            if (p.row > maxRow) maxRow = p.row;
            if (p.col > maxCol) maxCol = p.col;
        }

        // Defensive fallback: any server we somehow failed to place (e.g.
        // a node whose parentName references a server that isn't in
        // servers[]). Drop unplaced nodes onto an "orphan" row underneath
        // the tree so the user sees them instead of silently losing data.
        const unplaced = [];
        for (const s of (graph.servers || [])) {
            if (!positions.has(s.name)) unplaced.push(s);
        }
        if (unplaced.length > 0) {
            unplaced.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
            const orphanRow = maxRow + 2;  // gap of one row from the main tree
            unplaced.forEach((s, i) => {
                positions.set(s.name, { col: i, row: orphanRow });
                if (i > maxCol) maxCol = i;
            });
            maxRow = orphanRow;
        }

        const worldW = PADDING * 2 + (maxCol + 1) * (NODE_W + COL_GAP) - COL_GAP;
        const worldH = PADDING * 2 + (maxRow + 1) * (NODE_H + ROW_GAP) - ROW_GAP;
        return { positions, worldW, worldH };
    }

    function colToX(col) { return PADDING + col * (NODE_W + COL_GAP); }
    function rowToY(row) { return PADDING + row * (NODE_H + ROW_GAP); }

    // ─── Classification ───────────────────────────────────────────────────
    function classifyNode(node, ctx) {
        if (!node) return 'ok';
        if (node.name === ctx.homeName) return 'home';
        if (node.isInMaintenance) return 'kd';
        if (ctx.skipSet.has(node.name)) return 'skip';
        if (node.marketId && ctx.disabledMarketIds.has(node.marketId)) return 'off';
        return 'ok';
    }

    // Faction tint for the card's left stripe. Falls back to a neutral
    // grey if a faction we don't have a colour for ever shows up.
    function factionClass(node) {
        const f = (node && node.faction || '').toUpperCase();
        if (!f) return 'nm-faction-unknown';
        return 'nm-faction-' + f.toLowerCase();
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

    // ─── Render ───────────────────────────────────────────────────────────
    function render(camera, ctx) {
        // Clear the camera <g> — we keep the camera between renders so its
        // transform (pan/zoom) survives storage-driven refreshes.
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

        const { positions, worldW, worldH } = layoutTree(graph);

        // Edges first so node cards render on top.
        //
        // Two layers:
        //   1. Tree edges (parentName-based) — drawn as a soft cubic bezier
        //      from bottom-of-parent to top-of-child. This is the spanning
        //      tree the BFS built; gives the layered "branch" look.
        //   2. Extra edges — every connection in graph.connections that
        //      isn't already covered by the tree. Cor3.gg's post-May-2026
        //      map has multi-parent servers (multiple upstream links into a
        //      single node); without rendering these the user sees a tree
        //      but the real network is a DAG. Drawn as a thin straight line
        //      with a distinct class so they read as "secondary connection"
        //      and don't fight visually with the tree.
        const edgesG = svgEl('g', { class: 'nm-edges' });

        // Side-edge anchors for non-tree edges. We anchor on the right edge
        // of both endpoints and bow the curve out to the right of the whole
        // layout. This keeps the dashed line OUT of the column where cards
        // live (centre-to-centre routing would cross straight through any
        // card sitting between the two endpoints — visible-through-cards
        // bug reported on real cor3.gg layouts).
        function rightAnchor(pos) {
            return { x: colToX(pos.col) + NODE_W, y: rowToY(pos.row) + NODE_H / 2 };
        }

        // Tree edges first. We also track which undirected name-pairs are
        // already rendered as tree edges so the extras pass can skip them.
        const treePairs = new Set();
        for (const s of graph.servers) {
            if (!s.parentName || !positions.has(s.parentName) || !positions.has(s.name)) continue;
            const a = positions.get(s.parentName);
            const b = positions.get(s.name);
            const ax = colToX(a.col) + NODE_W / 2;
            const ay = rowToY(a.row) + NODE_H;     // bottom of parent card
            const bx = colToX(b.col) + NODE_W / 2;
            const by = rowToY(b.row);              // top of child card
            const midY = (ay + by) / 2;
            const d = `M${ax},${ay} C${ax},${midY} ${bx},${midY} ${bx},${by}`;
            edgesG.appendChild(svgEl('path', {
                d, class: 'nm-edge' + (s.viaHidden ? ' nm-edge-hidden' : ''),
            }));
            const key = s.parentName < s.name ? `${s.parentName}|${s.name}` : `${s.name}|${s.parentName}`;
            treePairs.add(key);
        }

        // Extra (non-tree) edges. graph.connections is the full undirected
        // edge list shipped by ws-interceptor (May-2026). Older snapshots
        // without this field gracefully degrade to tree-only rendering.
        //
        // Routing: anchor on each card's right edge, bow the curve out to
        // the right of the world bounds. With multiple extras at varying
        // row spans we offset each subsequent bow further right so two
        // overlapping curves stay readable as separate links.
        const allConns = Array.isArray(graph.connections) ? graph.connections : [];
        const BOW_BASE = 28;       // px clearance from the rightmost card
        const BOW_STEP = 14;       // additional offset per stacked curve
        let bowIndex = 0;
        for (const c of allConns) {
            if (!c.a || !c.b) continue;
            const key = c.a < c.b ? `${c.a}|${c.b}` : `${c.b}|${c.a}`;
            if (treePairs.has(key)) continue;
            if (!positions.has(c.a) || !positions.has(c.b)) continue;
            const pa = rightAnchor(positions.get(c.a));
            const pb = rightAnchor(positions.get(c.b));
            // Control point sits to the right of the rightmost card column
            // at a y midway between the endpoints. As more extras accumulate
            // we step the control point further out so curves don't merge.
            const cx = Math.max(pa.x, pb.x) + BOW_BASE + bowIndex * BOW_STEP;
            const cy = (pa.y + pb.y) / 2;
            const d = `M${pa.x},${pa.y} Q${cx},${cy} ${pb.x},${pb.y}`;
            edgesG.appendChild(svgEl('path', {
                d, class: 'nm-edge nm-edge-extra' + (c.isHidden ? ' nm-edge-hidden' : ''),
            }));
            bowIndex += 1;
        }

        camera.appendChild(edgesG);

        // Cards
        const cardsG = svgEl('g', { class: 'nm-cards' });
        for (const s of graph.servers) {
            const pos = positions.get(s.name);
            if (!pos) continue;
            const cls = classifyNode(s, ctx);
            const x = colToX(pos.col);
            const y = rowToY(pos.row);
            const g = svgEl('g', {
                class: `nm-node nm-state-${cls} ${factionClass(s)}`,
                'data-name': s.name,
                transform: `translate(${x}, ${y})`,
            });
            // Card body
            g.appendChild(svgEl('rect', {
                class: 'nm-card-bg',
                x: 0, y: 0, width: NODE_W, height: NODE_H, rx: 5, ry: 5,
            }));
            // Faction stripe (left edge)
            g.appendChild(svgEl('rect', {
                class: 'nm-card-stripe',
                x: 0, y: 0, width: 4, height: NODE_H, rx: 2, ry: 2,
            }));
            // Status dot (top-right corner of the card)
            g.appendChild(svgEl('circle', {
                class: 'nm-status-dot',
                cx: NODE_W - 7, cy: 7, r: 3.5,
            }));
            // Server name (truncated to fit). Keep a leading prefix strip
            // so RM7-* names still read cleanly inside the narrow card.
            const display = (s.name || '').replace(/^RM7-/, '').slice(0, 10);
            const labelMain = svgEl('text', {
                x: 11, y: NODE_H / 2 + 4, class: 'nm-card-label',
            });
            labelMain.textContent = display || '?';
            g.appendChild(labelMain);
            // Faction sub-label below the name in muted text — gives
            // operators an at-a-glance read of which network a node is in.
            const sub = (s.faction || '').toString();
            if (sub) {
                const subLbl = svgEl('text', {
                    x: 11, y: NODE_H - 5, class: 'nm-card-sub',
                });
                subLbl.textContent = sub;
                g.appendChild(subLbl);
            }

            // K/D badge (top-right). When isInMaintenance is true on the
            // graph node, draw a small red tag. We don't have the live timer
            // here (the timer lives in DOM on cor3.gg, not in the WS payload),
            // so the tag just reads "K/D" — the tooltip carries the rest.
            if (cls === 'kd') {
                const bg = svgEl('g', { class: 'nm-kd-badge', transform: `translate(${NODE_W - 22}, -7)` });
                bg.appendChild(svgEl('rect', { x: 0, y: 0, width: 24, height: 11, rx: 2.5, ry: 2.5, class: 'nm-kd-bg' }));
                const tx = svgEl('text', { x: 12, y: 8, class: 'nm-kd-text' });
                tx.textContent = 'K/D';
                bg.appendChild(tx);
                g.appendChild(bg);
            }

            // Jobs badge (bottom-right).
            const jobs = ctx.jobCounts[s.name] || 0;
            if (jobs > 0) {
                const bg = svgEl('g', { class: 'nm-jobs-badge', transform: `translate(${NODE_W - 9}, ${NODE_H - 9})` });
                bg.appendChild(svgEl('circle', { r: 8, class: 'nm-badge-circle' }));
                const t = svgEl('text', { y: 3, 'text-anchor': 'middle', class: 'nm-badge-text' });
                t.textContent = jobs > 99 ? '99+' : String(jobs);
                bg.appendChild(t);
                g.appendChild(bg);
            }

            // Tooltip
            const title = svgEl('title');
            const parts = [s.name];
            if (s.faction)             parts.push(`faction: ${s.faction}`);
            if (Number.isFinite(s.depth)) parts.push(`depth: ${s.depth}${s.viaHidden ? ' (via hidden)' : ''}`);
            if (s.parentName)          parts.push(`from: ${s.parentName}`);
            if (cls === 'kd')          parts.push('K/D — temporarily in maintenance');
            if (cls === 'skip')        parts.push('user-skipped');
            if (cls === 'off')         parts.push('market disabled in settings');
            if (jobs > 0)              parts.push(`${jobs} job(s) available`);
            title.textContent = parts.join('\n');
            g.appendChild(title);

            cardsG.appendChild(g);
        }
        camera.appendChild(cardsG);

        // Widen world bounds to include the rightmost bowed-out extra-edge
        // control point so fit() doesn't clip the curves. bowIndex carries
        // the final count of extras rendered above.
        const widenedW = bowIndex > 0
            ? Math.max(worldW, worldW + BOW_BASE + bowIndex * BOW_STEP + PADDING)
            : worldW;
        return { worldW: widenedW, worldH };
    }

    // ─── Pan + Zoom (camera transform) ────────────────────────────────────
    //
    // Camera = a single <g> wrapping all rendered geometry, with
    // transform="translate(pan.x, pan.y) scale(zoom)". Pan is in screen
    // pixels (1 unit = 1 px when zoom=1); zoom is multiplicative.
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

        // The HUD: zoom %, Refresh button, Fit button. Floats over the SVG.
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
            // Mirror what auto-jobs section's "rescan" did before — relay
            // a chrome.tabs.sendMessage to the cor3.gg tab; the runtime
            // bridge doesn't include rescanNetworkMap, so go through
            // chrome.tabs directly so the in-page interceptor receives it.
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

        const camera = svgEl('g', { class: 'nm-camera' });
        svg.appendChild(camera);

        const legend = htmlEl('div', 'network-map-legend muted xs');
        legend.innerHTML = `
            <span class="nm-legend-dot nm-state-home"></span> home
            <span class="nm-legend-dot nm-state-ok"></span> ok
            <span class="nm-legend-dot nm-state-kd"></span> K/D
            <span class="nm-legend-dot nm-state-skip"></span> skipped
            <span class="nm-legend-dot nm-state-off"></span> market off
        `;

        wrap.appendChild(canvasHost);
        wrap.appendChild(legend);
        container.appendChild(wrap);

        // ── Camera state ────────────────────────────────────────────────
        // world.{worldW, worldH} mirrors the field names render() returns
        // — keep them aligned, fit() does division by these and any typo
        // gives a NaN zoom which breaks the wheel handler silently.
        const cam = { x: 0, y: 0, zoom: 1, world: { worldW: 320, worldH: 160 } };
        const ZOOM_MIN = 0.3, ZOOM_MAX = 3;

        function applyCamera() {
            const z = Number.isFinite(cam.zoom) && cam.zoom > 0 ? cam.zoom : 1;
            const x = Number.isFinite(cam.x) ? cam.x : 0;
            const y = Number.isFinite(cam.y) ? cam.y : 0;
            cam.zoom = z; cam.x = x; cam.y = y;
            camera.setAttribute('transform', `translate(${x}, ${y}) scale(${z})`);
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
            const z = Math.min(sx, sy, 1.2);
            cam.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
            cam.x = (rect.width  - ww * cam.zoom) / 2;
            cam.y = (rect.height - wh * cam.zoom) / 2;
            applyCamera();
        }

        // ── Drag-to-pan ─────────────────────────────────────────────────
        // pointerdown captures the pointer so the drag survives the cursor
        // leaving the SVG bounds; pointerup releases it. Skips drags on
        // <a>/<button>/<input> children just in case the future card grows
        // interactive controls.
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
        // Zoom centred on cursor: convert cursor (screen px relative to svg)
        // to world coords, scale, then re-anchor pan so the same world
        // point is back under the cursor.
        //
        // The listener lives on canvasHost (the wrapping div), not the
        // <svg> itself, with `capture: true` so we run before any ancestor
        // scroll handler can claim the wheel event. Without this, the
        // popup's outer scrollable container in some Chrome builds eats
        // the wheel before it reaches the SVG and the zoom never fires.
        // `passive: false` is required to call preventDefault().
        function onWheel(e) {
            // Only react to wheels actually over our canvas. (Capture:true
            // means we'd otherwise catch wheels anywhere in the popup.)
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
                skipSet,
                disabledMarketIds,
                jobCounts: buildJobCounts([home, dark, srm]),
            };

            const dims = render(camera, ctx);
            cam.world = dims;
            // No viewBox: SVG renders in native pixel units, so the camera
            // transform's translate/scale operates in *screen* pixels. With
            // a viewBox the SVG would auto-scale content under our camera
            // and the two scalings compound — that was the source of the
            // post-Fit "shrunk into the corner" bug.
            //
            // Fixed visual height — pan moves long networks inside the
            // canvas rather than the canvas growing the popup.
            const visualHeight = Math.min(360, Math.max(240, dims.worldH));
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
                // Defer fit() to next frame so the browser has a measured
                // bounding rect for the SVG (style.height was just applied).
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
                // Same { capture: true } flag the addEventListener used —
                // omit it and removeEventListener silently no-ops.
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
