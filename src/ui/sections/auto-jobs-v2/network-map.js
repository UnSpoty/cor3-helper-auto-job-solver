// Auto-Jobs v2 — Local Network Map renderer.
//
// Isolated copy of src/ui/components/network-map.js. Differences from v1:
//   - Exposes the attach API on `COR3.uiComponentsV2.networkMap` (NOT
//     `COR3.uiComponents.networkMap`) so the v2 section never reaches into
//     v1's component registry.
//   - No reads of AUTOJOBS_V2_SETTINGS / SERVER_PRIORITIES — v2 has no UI
//     to drive market toggles or server-skip flags, so dimming for those
//     states is dead weight. Map shows home / K/D / job counts only.
//   - Refresh button dispatches the same `rescanNetworkMap` runtime
//     message v1 uses (the in-game NM is shared, so a rescan helps both
//     tabs equally).

(function () {
    const root = window;
    if (!root.COR3 || !root.COR3.constants) return;
    const { Store, constants: C } = root.COR3;
    const SL = C.STORAGE_LOCAL;
    const SVG_NS = 'http://www.w3.org/2000/svg';

    const NODE_W   = 60;
    const NODE_H   = 44;
    const NODE_FASCIA = 8;

    const EDGE_TAIL = 6;
    const EDGE_RADIUS = 10;

    const PLACE_SCALE = 50;
    const PLACE_Y_SIGN = -1;

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
    function safeId(s) { return String(s || '').replace(/[^a-zA-Z0-9_-]/g, '_'); }

    function projectPositions(graph) {
        const positions = new Map();
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
            const x = s.serverPlace[0] * PLACE_SCALE;
            const y = s.serverPlace[1] * PLACE_SCALE * PLACE_Y_SIGN;
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
            positions.set(s.name, { x, y });
        }
        if (!placed.length) { minX = 0; minY = 0; maxX = 0; maxY = 0; }

        const ORPHAN_GAP = 120;
        orphans.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        orphans.forEach((s, i) => {
            const x = minX + i * ORPHAN_GAP;
            const y = maxY + 240;
            positions.set(s.name, { x, y });
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
        });

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

    function classifyNode(node, ctx) {
        if (!node) return 'ok';
        if (node.name === ctx.homeName) return 'home';
        if (node.isInMaintenance) return 'kd';
        return 'ok';
    }

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
        const aEx = aCX + ux * r;
        const aEy = aCY + uy * r;
        const bSx = bCX - ux * r;
        const bSy = bCY - uy * r;
        return `M ${ax} ${ay} L ${aTX} ${aTY} Q ${aCX} ${aCY} ${aEx} ${aEy} L ${bSx} ${bSy} Q ${bCX} ${bCY} ${bTX} ${bTY} L ${bx} ${by}`;
    }

    function pickPortSides(aCenter, bCenter) {
        const dx = bCenter.x - aCenter.x;
        const dy = bCenter.y - aCenter.y;
        let aSide, bSide;
        if (Math.abs(dx) >= Math.abs(dy)) {
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

    function nodePathD() {
        const W = NODE_W;
        const H = NODE_H;
        const F = NODE_FASCIA;
        const R = 3;
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

        const defs = svgEl('defs');
        const usedColors = new Map();
        for (const s of graph.servers) {
            const col = (s.serverColor && s.serverColor.main) ? s.serverColor : DEFAULT_COLOR;
            const idSafe = safeId(s.id || s.name);
            usedColors.set(s.id || s.name, { col, idSafe });
            const grad = svgEl('linearGradient', {
                id: `nmv2-grad-${idSafe}`,
                x1: 0, y1: 0, x2: 0, y2: 1,
            });
            const stop1 = svgEl('stop', { offset: '0%',   'stop-color': col.main });
            const stop2 = svgEl('stop', { offset: '100%', 'stop-color': col.secondary || col.main, 'stop-opacity': 0.55 });
            grad.appendChild(stop1);
            grad.appendChild(stop2);
            defs.appendChild(grad);
        }
        camera.appendChild(defs);

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

        const nodeBodyD = nodePathD();
        const cardsG = svgEl('g', { class: 'nm-cards' });
        for (const s of graph.servers) {
            const pos = positions.get(s.name);
            if (!pos) continue;
            const cls = classifyNode(s, ctx);
            const { col, idSafe } = usedColors.get(s.id || s.name);
            const tx = Math.round(pos.x - NODE_W / 2);
            const ty = Math.round(pos.y - NODE_H / 2);
            const isHome = s.serverTypeName === 'Home' || s.name === ctx.homeName;
            const isActiveEndpoint = ctx.currentEndpointName && s.name === ctx.currentEndpointName;

            const g = svgEl('g', {
                class: `nm-node nm-state-${cls}${isHome ? ' nm-home' : ''}${isActiveEndpoint ? ' nm-active' : ''}`,
                'data-name': s.name,
                transform: `translate(${tx}, ${ty})`,
            });

            g.appendChild(svgEl('path', {
                class: 'nm-card',
                d: nodeBodyD,
                fill: `url(#nmv2-grad-${idSafe})`,
                'fill-opacity': 0.4,
                stroke: col.main,
                'stroke-opacity': 0.65,
                'stroke-width': isHome || isActiveEndpoint ? 1.5 : 1,
            }));

            const glyph = !isHome && s.transitType ? `nmv2-glyph-${s.transitType}` : null;
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

            const nameTrim = (s.name || '').replace(/^RM7-/, '').slice(0, 9);
            const lbl = svgEl('text', {
                x: NODE_W / 2,
                y: 12,
                class: 'nm-name',
                'text-anchor': 'middle',
            });
            lbl.textContent = nameTrim || '?';
            g.appendChild(lbl);

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

            if (cls === 'kd') {
                const bg = svgEl('g', { class: 'nm-kd-badge', transform: `translate(${NODE_W - 22}, -7)` });
                bg.appendChild(svgEl('rect', { x: 0, y: 0, width: 22, height: 10, rx: 2, ry: 2, class: 'nm-kd-bg' }));
                const tx = svgEl('text', { x: 11, y: 7.5, class: 'nm-kd-text' });
                tx.textContent = 'K/D';
                bg.appendChild(tx);
                g.appendChild(bg);
            }

            const jobs = ctx.jobCounts[s.name] || 0;
            if (jobs > 0) {
                const bg = svgEl('g', { class: 'nm-jobs-badge', transform: `translate(${NODE_W - 8}, ${NODE_H - 8})` });
                bg.appendChild(svgEl('circle', { r: 7, class: 'nm-badge-circle' }));
                const t = svgEl('text', { y: 3, 'text-anchor': 'middle', class: 'nm-badge-text' });
                t.textContent = jobs > 99 ? '99+' : String(jobs);
                bg.appendChild(t);
                g.appendChild(bg);
            }

            if (s.isNew) {
                const bg = svgEl('g', { class: 'nm-new-badge', transform: `translate(3, ${NODE_H - 12})` });
                bg.appendChild(svgEl('rect', { x: 0, y: 0, width: 18, height: 9, rx: 1.5, ry: 1.5, class: 'nm-new-bg' }));
                const t = svgEl('text', { x: 9, y: 7, class: 'nm-new-text' });
                t.textContent = 'NEW';
                bg.appendChild(t);
                g.appendChild(bg);
            }

            // User-override marker (top-left corner). Small so it doesn't
            // crowd the card: a red ⊘ for a skipped server, or an amber count
            // for a server with N job types disabled.
            const ov = ctx.overrides && ctx.overrides[s.name];
            const disabledCount = (ov && ov.disabledTypes)
                ? Object.keys(ov.disabledTypes).filter((k) => ov.disabledTypes[k]).length : 0;
            if (ov && ov.skip) {
                g.classList.add('nm-skip');
                const bg = svgEl('g', { class: 'nm-ov-badge', transform: 'translate(-3, -3)' });
                bg.appendChild(svgEl('circle', { cx: 6, cy: 6, r: 6, class: 'nm-skip-bg' }));
                bg.appendChild(svgEl('line', { x1: 2.6, y1: 2.6, x2: 9.4, y2: 9.4, class: 'nm-skip-slash' }));
                g.appendChild(bg);
            } else if (disabledCount > 0) {
                g.classList.add('nm-has-disabled');
                const bg = svgEl('g', { class: 'nm-ov-badge', transform: 'translate(-3, -3)' });
                bg.appendChild(svgEl('circle', { cx: 6, cy: 6, r: 6, class: 'nm-dis-bg' }));
                const t = svgEl('text', { x: 6, y: 8.6, 'text-anchor': 'middle', class: 'nm-dis-text' });
                t.textContent = String(disabledCount);
                bg.appendChild(t);
                g.appendChild(bg);
            }

            // Market disabled via Master Switches → dim the tile.
            const mslot = ctx.marketSlotByName && ctx.marketSlotByName[s.name];
            const marketOff = !!(mslot && ctx.switches && ctx.switches.markets && ctx.switches.markets[mslot] === false);
            if (marketOff) g.classList.add('nm-market-off');

            const title = svgEl('title');
            const parts = [s.name];
            if (marketOff)               parts.push(`market disabled (${mslot})`);
            if (s.serverTypeName)        parts.push(s.serverTypeName);
            if (s.cluster)               parts.push(`cluster: ${s.cluster}`);
            if (Number.isFinite(s.depth)) parts.push(`depth: ${s.depth}${s.viaHidden ? ' (via hidden)' : ''}`);
            if (s.parentName)            parts.push(`from: ${s.parentName}`);
            if (isActiveEndpoint)        parts.push('← current endpoint');
            if (cls === 'kd')            parts.push('K/D — temporarily in maintenance');
            if (jobs > 0)                parts.push(`${jobs} job(s) available`);
            if (ov && ov.skip)           parts.push('SKIPPED by user');
            else if (disabledCount > 0)  parts.push(`${disabledCount} job type(s) disabled here`);
            title.textContent = parts.join('\n');
            g.appendChild(title);

            cardsG.appendChild(g);
        }
        camera.appendChild(cardsG);

        return { worldW, worldH };
    }

    function ensureSharedDefs(svg) {
        if (svg.querySelector('defs.nmv2-shared-defs')) return;
        const defs = svgEl('defs', { class: 'nmv2-shared-defs' });

        const filter = svgEl('filter', {
            id: 'nmv2-glow-line',
            x: '-50%', y: '-50%', width: '200%', height: '200%',
        });
        filter.appendChild(svgEl('feGaussianBlur', { stdDeviation: 2, result: 'blur' }));
        const merge = svgEl('feMerge');
        merge.appendChild(svgEl('feMergeNode', { in: 'blur' }));
        merge.appendChild(svgEl('feMergeNode', { in: 'SourceGraphic' }));
        filter.appendChild(merge);
        defs.appendChild(filter);

        const pub = svgEl('symbol', { id: 'nmv2-glyph-public', viewBox: '0 0 24 24' });
        const pubPaths = [
            'M12.047 2.35352L16.9375 10.8241H7.15646L12.047 2.35352Z',
            'M12.0472 20.5176L7.15666 12.047L16.9377 12.047L12.0472 20.5176Z',
            'M5.92941 12.2354L10.8199 20.7059H1.03891L5.92941 12.2354Z',
            'M18.1649 12.2354L23.0554 20.7059H13.2744L18.1649 12.2354Z',
        ];
        for (const d of pubPaths) pub.appendChild(svgEl('path', { d }));
        defs.appendChild(pub);

        const priv = svgEl('symbol', { id: 'nmv2-glyph-private', viewBox: '0 0 20 20' });
        const privPaths = [
            'M9.28418 10.7178V20.001C4.31684 19.6501 0.350896 15.6851 0 10.7178H9.28418Z',
            'M20.002 10.7178C19.6511 15.6851 15.6851 19.6501 10.7178 20.001V10.7178H20.002Z',
            'M10.7178 0C15.6852 0.350889 19.6511 4.31679 20.002 9.28418H10.7178V0Z',
            'M9.28418 9.28418H0C0.350878 4.31679 4.3168 0.350889 9.28418 0V9.28418Z',
        ];
        for (const d of privPaths) priv.appendChild(svgEl('path', { d }));
        defs.appendChild(priv);

        const restricted = svgEl('symbol', { id: 'nmv2-glyph-restricted', viewBox: '0 0 24 24' });
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

        if (svg.firstChild) svg.insertBefore(defs, svg.firstChild);
        else svg.appendChild(defs);
    }

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

        const gridLayer = htmlEl('div', 'network-map-grid');
        canvasHost.appendChild(gridLayer);

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

        const cam = { x: 0, y: 0, zoom: 1, world: { worldW: 320, worldH: 160 } };
        const ZOOM_MIN = 0.15, ZOOM_MAX = 3;

        // Context-menu state (left-click a server node).
        const serversByName = new Map();
        let homeName = null;
        let v2Enabled = false;       // Open SAI / Open Market blocked while true
        let menuEl = null, menuFor = null, menuX = 0, menuY = 0;

        function applyCamera() {
            const z = Number.isFinite(cam.zoom) && cam.zoom > 0 ? cam.zoom : 1;
            const x = Number.isFinite(cam.x) ? cam.x : 0;
            const y = Number.isFinite(cam.y) ? cam.y : 0;
            cam.zoom = z; cam.x = x; cam.y = y;
            camera.setAttribute('transform', `translate(${x}, ${y}) scale(${z})`);
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
            const FIT_MIN = 0.35;
            const z = Math.max(FIT_MIN, Math.min(sx, sy, 1.2));
            cam.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
            cam.x = (rect.width  - ww * cam.zoom) / 2;
            cam.y = (rect.height - wh * cam.zoom) / 2;
            applyCamera();
        }

        // ─── Context menu ──────────────────────────────────────────────────
        const JOB_TYPES = Object.values(C.FLOW);

        async function getCor3Tab() {
            const tabs = await chrome.tabs.query({ url: ['https://cor3.gg/*', 'https://os.cor3.gg/*'] });
            return (tabs && tabs[0]) || null;
        }
        async function sendGameAction(action, serverName) {
            const tab = await getCor3Tab();
            if (tab) chrome.tabs.sendMessage(tab.id, { action, serverName }).catch(() => {});
        }
        async function readOverrides() {
            return (await Store.local.getOne(SL.AJV2_SERVER_OVERRIDES, {})) || {};
        }
        async function patchOverride(name, mutate) {
            const all = await readOverrides();
            const cur = all[name] || { skip: false, disabledTypes: {} };
            mutate(cur);
            const hasDisabled = cur.disabledTypes && Object.keys(cur.disabledTypes).some((k) => cur.disabledTypes[k]);
            if (!cur.skip && !hasDisabled) delete all[name];
            else all[name] = cur;
            await Store.local.setOne(SL.AJV2_SERVER_OVERRIDES, all);
        }

        function onDocDown(e) { if (menuEl && !menuEl.contains(e.target)) closeMenu(); }
        function onKeyDown(e) { if (e.key === 'Escape') closeMenu(); }
        function closeMenu() {
            if (menuEl) { menuEl.remove(); menuEl = null; }
            menuFor = null;
            document.removeEventListener('pointerdown', onDocDown, true);
            document.removeEventListener('keydown', onKeyDown, true);
        }

        async function openMenu(serverName, clientX, clientY) {
            closeMenu();
            menuX = clientX; menuY = clientY;
            const server = serversByName.get(serverName) || null;
            const isHome = !!(server && (server.serverTypeName === 'Home' || server.name === homeName));
            const isMarket = isHome || !!(server && server.marketId);
            const ov = (await readOverrides())[serverName] || { skip: false, disabledTypes: {} };

            const menu = htmlEl('div', 'nm-ctx-menu');
            menu.appendChild(htmlEl('div', 'nm-ctx-title', serverName));

            const gameBtn = (label, action, arg) => {
                const b = htmlEl('button', 'nm-ctx-item', label);
                b.disabled = v2Enabled;
                if (v2Enabled) b.title = 'Disabled while Auto-Jobs v2 is running';
                b.addEventListener('click', () => { if (v2Enabled) return; sendGameAction(action, arg); closeMenu(); });
                menu.appendChild(b);
            };
            // HOME has no SAI terminal — only offer Open Market there.
            if (!isHome) gameBtn('Open SAI', C.MSG.AUTOJOBS_V2.OPEN_SAI_ACTION, serverName);
            if (isMarket) gameBtn('Open Market', C.MSG.AUTOJOBS_V2.OPEN_MARKET_ACTION, isHome ? null : serverName);

            menu.appendChild(htmlEl('div', 'nm-ctx-divider'));

            const toggle = (label, on, onClick) => {
                const b = htmlEl('button', 'nm-ctx-item nm-ctx-toggle' + (on ? ' is-on' : ''), (on ? '☑ ' : '☐ ') + label);
                b.addEventListener('click', async () => { await onClick(); openMenu(serverName, clientX, clientY); });
                menu.appendChild(b);
                return b;
            };
            toggle('SKIP this server', !!ov.skip, () => patchOverride(serverName, (c) => { c.skip = !c.skip; }));

            menu.appendChild(htmlEl('div', 'nm-ctx-sub', 'Disable job types here:'));
            const disabled = ov.disabledTypes || {};
            for (const type of JOB_TYPES) {
                toggle(type.replace(/_/g, ' '), !!disabled[type], () => patchOverride(serverName, (c) => {
                    c.disabledTypes = c.disabledTypes || {};
                    if (c.disabledTypes[type]) delete c.disabledTypes[type];
                    else c.disabledTypes[type] = true;
                })).classList.add('nm-ctx-type');
            }

            const hostRect = canvasHost.getBoundingClientRect();
            menu.style.left = (clientX - hostRect.left + 4) + 'px';
            menu.style.top = (clientY - hostRect.top + 4) + 'px';
            canvasHost.appendChild(menu);
            // Clamp inside the canvas.
            const m = menu.getBoundingClientRect();
            if (m.right > hostRect.right) menu.style.left = Math.max(2, hostRect.width - m.width - 4) + 'px';
            if (m.bottom > hostRect.bottom) menu.style.top = Math.max(2, hostRect.height - m.height - 4) + 'px';

            menuEl = menu;
            menuFor = serverName;
            setTimeout(() => {
                document.addEventListener('pointerdown', onDocDown, true);
                document.addEventListener('keydown', onKeyDown, true);
            }, 0);
        }

        let dragging = null;
        svg.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            const targetTag = (e.target.tagName || '').toLowerCase();
            if (targetTag === 'a' || targetTag === 'button' || targetTag === 'input') return;
            const nodeG = e.target.closest && e.target.closest('.nm-node');
            dragging = {
                startX: e.clientX, startY: e.clientY, camX: cam.x, camY: cam.y,
                moved: false, clickName: nodeG ? nodeG.getAttribute('data-name') : null,
            };
            try { svg.setPointerCapture(e.pointerId); } catch (_) {}
            svg.classList.add('nm-grabbing');
            e.preventDefault();
        });
        svg.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            if (Math.abs(e.clientX - dragging.startX) > 4 || Math.abs(e.clientY - dragging.startY) > 4) dragging.moved = true;
            cam.x = dragging.camX + (e.clientX - dragging.startX);
            cam.y = dragging.camY + (e.clientY - dragging.startY);
            applyCamera();
        });
        function endDrag(e, isUp) {
            if (!dragging) return;
            const { clickName, moved } = dragging;
            try { svg.releasePointerCapture(e.pointerId); } catch (_) {}
            dragging = null;
            svg.classList.remove('nm-grabbing');
            // A click (no drag) on a server node opens its context menu.
            if (isUp && !moved && clickName) openMenu(clickName, e.clientX, e.clientY);
        }
        svg.addEventListener('pointerup', (e) => endDrag(e, true));
        svg.addEventListener('pointercancel', (e) => endDrag(e, false));

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

        const summaryStatus = wrap.querySelector('.nm-summary-status');
        let firstRender = true;

        async function refresh() {
            const [graph, home, dark, srm, overrides, switches] = await Promise.all([
                Store.local.getOne(SL.NM_GRAPH, null),
                Store.local.getOne(SL.MARKET, null),
                Store.local.getOne(SL.DARK_MARKET, null),
                Store.local.getOne(SL.SRM_MARKET, null),
                Store.local.getOne(SL.AJV2_SERVER_OVERRIDES, {}),
                Store.local.getOne(SL.AJV2_MASTER_SWITCHES, {}),
            ]);

            // Map each market server to its slot so we can dim it when its
            // Master Switch is off. home = the graph's home; dark/srm matched
            // by marketId against their envelopes.
            const marketSlotByName = {};
            const homeNm = graph && graph.home;
            const darkId = dark && dark.marketId;
            const srmId = srm && srm.marketId;
            for (const s of (graph && graph.servers) || []) {
                if (!s || !s.name) continue;
                if (s.name === homeNm || s.serverTypeName === 'Home') marketSlotByName[s.name] = 'home';
                else if (darkId && s.marketId === darkId) marketSlotByName[s.name] = 'dark';
                else if (srmId && s.marketId === srmId) marketSlotByName[s.name] = 'srm';
            }

            const ctx = {
                graph,
                homeName: graph?.home || null,
                currentEndpointName: graph?.currentEndpointName || null,
                jobCounts: buildJobCounts([home, dark, srm]),
                overrides: overrides || {},
                switches: switches || {},
                marketSlotByName,
            };

            // Index servers for the context menu (name → server object, so the
            // menu knows market-ness, home-ness, etc.).
            serversByName.clear();
            homeName = ctx.homeName;
            for (const s of (graph && graph.servers) || []) {
                if (s && s.name) serversByName.set(s.name, s);
            }

            const dims = render(camera, ctx);
            cam.world = dims;
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
            if (c[SL.NM_GRAPH] || c[SL.MARKET] || c[SL.DARK_MARKET] || c[SL.SRM_MARKET]
                || c[SL.AJV2_SERVER_OVERRIDES] || c[SL.AJV2_MASTER_SWITCHES]) refresh();
        });

        // Track whether Auto-Jobs v2 is running — Open SAI / Open Market are
        // blocked while it is. Re-render an open menu so its buttons reflect
        // the new state immediately.
        const SS = C.STORAGE_SYNC;
        const syncUnsub = Store.sync.onChanged((c) => {
            if (!c[SS.AUTOJOBS_V2_SETTINGS]) return;
            const nv = c[SS.AUTOJOBS_V2_SETTINGS].newValue;
            v2Enabled = !!(nv && nv.enabled);
            if (menuEl && menuFor != null) openMenu(menuFor, menuX, menuY);
        });
        Store.sync.getOne(SS.AUTOJOBS_V2_SETTINGS, { enabled: false }).then((s) => { v2Enabled = !!(s && s.enabled); });

        let resizeTimer = null;
        const resizeObs = ('ResizeObserver' in window) ? new ResizeObserver(() => {
            if (resizeTimer) clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => fit(), 150);
        }) : null;
        if (resizeObs) resizeObs.observe(canvasHost);

        refresh();

        return {
            destroy() {
                closeMenu();
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
    root.COR3.uiComponentsV2 = root.COR3.uiComponentsV2 || {};
    root.COR3.uiComponentsV2.networkMap = { attach };
})();
