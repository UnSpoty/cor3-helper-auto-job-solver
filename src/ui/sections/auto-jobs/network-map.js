// Auto Jobs — Local Network Map renderer.
//
//   - Exposes the attach API on `COR3.uiComponents.networkMap`.
//   - Shows home / K/D / job counts, plus per-server state from the Auto Jobs
//     keys: dims market-off (AJ_MASTER_SWITCHES) + user-skipped/disabled
//     (AJ_SERVER_OVERRIDES) tiles, and highlights not-accessible-but-hackable
//     servers green/grey from the loadout's HACK capability (LOADOUT._derived).
//   - Refresh button dispatches the `rescanNetworkMap` runtime message; the
//     in-game NM is shared, so the rescan also refreshes the live game panel.

(function () {
    const root = window;
    if (!root.COR3 || !root.COR3.constants) return;
    const { Store, constants: C } = root.COR3;
    const SL = C.STORAGE_LOCAL;
    const t = (k, vars) => root.COR3.i18n.t(k, vars);
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

    // Pipeline reason string for a route cut by a maintenance transit node —
    // shown raw (English) like the Job List's skip reasons. Keep in sync with
    // CHECK_CONDITION's dataReasons in src/modules/automation/auto-jobs/pipeline.js.
    const NO_PATH_REASON = 'no path to server (route blocked by maintenance)';

    // BFS from HOME over ALL edges (hidden gateways included): a server in
    // maintenance may be reached as an ENDPOINT but is never expanded as a
    // transit hop (HOME itself is expanded even while in maintenance).
    // pipeline.js is not loaded in the popup — keep in sync with
    // computePathReachability in src/modules/automation/auto-jobs/pipeline.js.
    function computePathReachability(servers, connections, homeName) {
        const inMaintenance = new Map();
        for (const s of servers) if (s && s.name) inMaintenance.set(s.name, !!s.isInMaintenance);
        const adj = new Map();
        const link = (a, b) => { let l = adj.get(a); if (!l) adj.set(a, l = []); l.push(b); };
        for (const c of connections) {
            if (!c || !c.a || !c.b) continue;
            link(c.a, c.b);
            link(c.b, c.a);
        }
        const reached = new Set([homeName]);
        const queue = [homeName];
        while (queue.length) {
            const cur = queue.shift();
            // Reached-but-in-maintenance: endpoint only, never a transit hop.
            if (cur !== homeName && inMaintenance.get(cur)) continue;
            for (const n of (adj.get(cur) || [])) {
                if (!reached.has(n)) { reached.add(n); queue.push(n); }
            }
        }
        return reached;
    }

    function classifyNode(node, ctx) {
        if (!node) return 'ok';
        if (node.name === ctx.homeName) return 'home';
        if (node.isInMaintenance) return 'kd';
        // Route from HOME cut by a maintenance transit node — the same verdict
        // the pipeline's CHECK_ACCESS stamps as `noPath` (hard skip + postpone).
        if (ctx.pathReachable && !ctx.pathReachable.has(node.name)) return 'nopath';
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
                    // serverName first — same resolution as pipeline.js's jobServer.
                    name = (typeof first === 'string') ? first : (first && (first.serverName || first.name));
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
            fg.textContent = t('autojobs.nmNotLoaded');
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
                const txt = svgEl('text', { y: 3, 'text-anchor': 'middle', class: 'nm-badge-text' });
                txt.textContent = jobs > 99 ? '99+' : String(jobs);
                bg.appendChild(txt);
                g.appendChild(bg);
            }

            if (s.isNew) {
                const bg = svgEl('g', { class: 'nm-new-badge', transform: `translate(3, ${NODE_H - 12})` });
                bg.appendChild(svgEl('rect', { x: 0, y: 0, width: 18, height: 9, rx: 1.5, ry: 1.5, class: 'nm-new-bg' }));
                const txt = svgEl('text', { x: 9, y: 7, class: 'nm-new-text' });
                txt.textContent = t('autojobs.nmNew');
                bg.appendChild(txt);
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
                const txt = svgEl('text', { x: 6, y: 8.6, 'text-anchor': 'middle', class: 'nm-dis-text' });
                txt.textContent = String(disabledCount);
                bg.appendChild(txt);
                g.appendChild(bg);
            }

            // Market disabled via Master Switches → dim the tile.
            const mslot = ctx.marketSlotByName && ctx.marketSlotByName[s.name];
            const marketOff = !!(mslot && ctx.switches && ctx.switches.markets && ctx.switches.markets[mslot] === false);
            if (marketOff) g.classList.add('nm-market-off');

            // Hack reachability highlight for NOT-accessible servers: green when
            // an equipped HACK tool already covers the type (hack now), grey when
            // only owned (the flow installs it on the fly via ensureHack), dim
            // when we own no HACK software for it. Accessible servers untouched.
            // K/D and no-path servers are ALSO untouched: neither can be
            // connected to at all this cycle, so they CAN'T be hacked now — the
            // block dominates (mirrors the pipeline's jobServerReachable, which
            // returns false on cooldown/noPath). The K/D badge / no-path styling
            // already marks the block.
            let nodeHackState = null;
            if (!isHome && !s.isAccessible && cls !== 'kd' && cls !== 'nopath') {
                nodeHackState = (root.COR3.ajEligibility && root.COR3.ajEligibility.hackState)
                    ? root.COR3.ajEligibility.hackState(s.serverTypeName, ctx.hackDerived) : null;
                if (nodeHackState === 'active' || nodeHackState === 'available') {
                    g.classList.add(nodeHackState === 'active' ? 'nm-hack-active' : 'nm-hack-available');
                    const bg = svgEl('g', { class: 'nm-hack-badge', transform: `translate(-4, ${NODE_H / 2 - 6})` });
                    bg.appendChild(svgEl('circle', { cx: 6, cy: 6, r: 6, class: 'nm-hack-bg' }));
                    const htx = svgEl('text', { x: 6, y: 8.6, 'text-anchor': 'middle', class: 'nm-hack-text' });
                    htx.textContent = '⚡';
                    bg.appendChild(htx);
                    g.appendChild(bg);
                } else {
                    g.classList.add('nm-not-access');
                }
            }

            const title = svgEl('title');
            const parts = [s.name];
            if (marketOff)               parts.push(t('autojobs.tipMarketDisabled', { slot: mslot }));
            if (s.serverTypeName)        parts.push(s.serverTypeName);
            if (s.cluster)               parts.push(t('autojobs.tipCluster', { cluster: s.cluster }));
            if (Number.isFinite(s.depth)) parts.push(t('autojobs.tipDepth', { depth: s.depth }) + (s.viaHidden ? t('autojobs.tipViaHidden') : ''));
            if (s.parentName)            parts.push(t('autojobs.tipFrom', { parent: s.parentName }));
            if (isActiveEndpoint)        parts.push(t('autojobs.tipCurrentEndpoint'));
            if (cls === 'kd')            parts.push(t('autojobs.tipKd'));
            else if (cls === 'nopath')   parts.push(NO_PATH_REASON);
            if (nodeHackState === 'active')         parts.push(t('autojobs.tipHackActive'));
            else if (nodeHackState === 'available') parts.push(t('autojobs.tipHackAvailable'));
            else if (nodeHackState === null && !isHome && !s.isAccessible && cls !== 'kd' && cls !== 'nopath') parts.push(t('autojobs.tipNotAccessible'));
            if (jobs > 0)                parts.push(t('autojobs.tipJobsAvail', { n: jobs }));
            if (ov && ov.skip)           parts.push(t('autojobs.tipSkipped'));
            else if (disabledCount > 0)  parts.push(t('autojobs.tipTypesDisabled', { n: disabledCount }));
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
            <span class="card-label">${t('autojobs.networkMap')}</span>
            <span class="muted xs nm-summary-status"></span>
        `;
        wrap.appendChild(titleRow);

        const canvasHost = htmlEl('div', 'network-map-canvas');

        const gridLayer = htmlEl('div', 'network-map-grid');
        canvasHost.appendChild(gridLayer);

        const hud = htmlEl('div', 'nm-hud');
        const zoomLabel = htmlEl('span', 'nm-hud-zoom muted xs', '100%');
        const refreshBtn = htmlEl('button', 'btn small nm-hud-btn', '↻');
        refreshBtn.title = t('autojobs.nmRefreshTip');
        const fitBtn = htmlEl('button', 'btn small nm-hud-btn', t('autojobs.fit'));
        fitBtn.title = t('autojobs.fitTip');
        hud.appendChild(zoomLabel);
        hud.appendChild(refreshBtn);
        hud.appendChild(fitBtn);
        canvasHost.appendChild(hud);

        refreshBtn.addEventListener('click', async () => {
            try {
                refreshBtn.disabled = true;
                refreshBtn.textContent = '…';
                await sendGameAction(C.MSG.GAME.RESCAN_NETWORK_MAP);
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

        // World bounds (updated per render) for the shared pan/zoom controller.
        let world = { worldW: 320, worldH: 160 };

        // Context-menu state (RIGHT-click a server node). Left-click selects.
        const serversByName = new Map();
        let homeName = null;
        let pathReachable = null;    // Set of names with a live route from HOME (per refresh; null = no verdict)
        let v2Enabled = false;       // Open SAI / Open Market blocked while true
        let menuEl = null, menuFor = null, menuX = 0, menuY = 0;
        let selectedName = null;     // left-click selection (persistent highlight)

        // ── Camera (pan / wheel-zoom / fit) via the shared controller ──────
        // Left-click without a drag selects a node (onTap); right-click opens
        // the context menu (handled separately below). World bounds update per
        // render (`world`).
        const panZoom = root.COR3.panZoom.create({
            svg, camera, canvasHost, gridLayer, zoomLabel,
            getWorld: () => world,
            zoomMin: 0.15, zoomMax: 3, fitMin: 0.35, fitMax: 1.2,
            onTap: (clientX, clientY, target) => {
                const nodeG = target && target.closest && target.closest('.nm-node');
                selectNode(nodeG ? nodeG.getAttribute('data-name') : null);
            },
        });
        const fit = () => panZoom.fit();

        // ─── Context menu ──────────────────────────────────────────────────
        const JOB_TYPES = Object.values(C.FLOW);

        async function getCor3Tab() {
            const tabs = await chrome.tabs.query({ url: ['https://cor3.gg/*', 'https://os.cor3.gg/*'] });
            return (tabs && tabs[0]) || null;
        }
        async function sendGameAction(action, serverName, serverId, serverType) {
            const tab = await getCor3Tab();
            if (tab) chrome.tabs.sendMessage(tab.id, { action, serverName, serverId, serverType }).catch(() => {});
        }
        async function readOverrides() {
            return (await Store.local.getOne(SL.AJ_SERVER_OVERRIDES, {})) || {};
        }
        // Serialized so rapid in-place toggles can't race: each patch reads
        // AFTER the previous one's write commits (read-modify-write on shared
        // storage would otherwise clobber concurrent edits).
        let patchChain = Promise.resolve();
        function patchOverride(name, mutate) {
            patchChain = patchChain.then(async () => {
                const all = await readOverrides();
                const cur = all[name] || { skip: false, disabledTypes: {} };
                mutate(cur);
                const hasDisabled = cur.disabledTypes && Object.keys(cur.disabledTypes).some((k) => cur.disabledTypes[k]);
                if (!cur.skip && !hasDisabled) delete all[name];
                else all[name] = cur;
                await Store.local.setOne(SL.AJ_SERVER_OVERRIDES, all);
            });
            return patchChain;
        }

        function onDocDown(e) { if (menuEl && !menuEl.contains(e.target)) closeMenu(); }
        function onKeyDown(e) { if (e.key === 'Escape') closeMenu(); }
        function closeMenu() {
            if (menuEl) { menuEl.remove(); menuEl = null; }
            menuFor = null;
            document.removeEventListener('pointerdown', onDocDown, true);
            document.removeEventListener('keydown', onKeyDown, true);
        }

        // Left-click selection — a persistent cyan highlight on one node. The
        // cards are rebuilt on every refresh(), so re-apply after each render.
        function applySelection() {
            for (const g of camera.querySelectorAll('.nm-node')) {
                g.classList.toggle('is-selected', g.getAttribute('data-name') === selectedName);
            }
        }
        function selectNode(name) {
            selectedName = name || null;
            applySelection();
        }

        // Centre the camera on a node and flash it — driven from the Job List's
        // 🔍 locate button (via the module-level `focusServer` delegate below).
        // The node group carries `transform: translate(tx, ty)` with the node's
        // top-left in world coords; its centre is (tx + NODE_W/2, ty + NODE_H/2).
        function focusServer(name) {
            if (!name) return;
            const node = camera.querySelector(`.nm-node[data-name="${(root.CSS && CSS.escape) ? CSS.escape(name) : name}"]`);
            if (!node) return;
            selectNode(name);
            container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            const m = /translate\(([-\d.]+),\s*([-\d.]+)\)/.exec(node.getAttribute('transform') || '');
            if (m) {
                const cx = parseFloat(m[1]) + NODE_W / 2;
                const cy = parseFloat(m[2]) + NODE_H / 2;
                const rect = svg.getBoundingClientRect();
                panZoom.cam.x = rect.width / 2 - cx * panZoom.cam.zoom;
                panZoom.cam.y = rect.height / 2 - cy * panZoom.cam.zoom;
                panZoom.applyCamera();
            }
            // Restart the flash animation (remove → reflow → add).
            node.classList.remove('nm-flash');
            void node.getBoundingClientRect();
            node.classList.add('nm-flash');
        }

        async function openMenu(serverName, clientX, clientY) {
            closeMenu();
            menuX = clientX; menuY = clientY;
            selectNode(serverName);   // the menu's node reads as selected
            const server = serversByName.get(serverName) || null;
            const isHome = !!(server && (server.serverTypeName === 'Home' || server.name === homeName));
            const isMarket = isHome || !!(server && server.marketId);
            const ov = (await readOverrides())[serverName] || { skip: false, disabledTypes: {} };

            const menu = htmlEl('div', 'nm-ctx-menu');
            menu.appendChild(htmlEl('div', 'nm-ctx-title', serverName));

            // serverId + serverType (from NM_GRAPH) ride alongside serverName:
            // the MAIN bridge connects via WS set.endpoint (needs the id) and,
            // for Open SAI, may hack the server — picking HACK software by its
            // serverTypeName (e.g. "CEDRT private").
            const serverId = (server && server.id) || null;
            const serverType = (server && server.serverTypeName) || null;
            const gameBtn = (label, action, arg, argId, argType, blockedTitle) => {
                const b = htmlEl('button', 'nm-ctx-item', label);
                const blocked = v2Enabled || !!blockedTitle;
                b.disabled = blocked;
                if (v2Enabled) b.title = t('autojobs.ctxDisabledRunning');
                else if (blockedTitle) b.title = blockedTitle;
                b.addEventListener('click', () => { if (blocked) return; sendGameAction(action, arg, argId, argType); closeMenu(); });
                menu.appendChild(b);
            };
            // HOME has no SAI terminal — only offer Open Market there. A server on
            // K/D can't be connected to (set.endpoint won't land while it's in
            // maintenance), so Open SAI is BLOCKED there — only the connect-less
            // Open Market stays available. Same for a no-path server (route from
            // HOME cut by a maintenance transit node — set.endpoint can't land
            // there either). Mirrors the pipeline's K/D + noPath gates.
            const onCooldown = !!(server && server.isInMaintenance);
            const noPath = !onCooldown && !!(server && pathReachable && !pathReachable.has(server.name));
            if (!isHome) gameBtn(t('autojobs.openSai'), C.MSG.AUTOJOBS.OPEN_SAI_ACTION, serverName, serverId, serverType,
                onCooldown ? t('autojobs.ctxKdBlocked') : (noPath ? NO_PATH_REASON : null));
            if (isMarket) gameBtn(t('autojobs.openMarket'), C.MSG.AUTOJOBS.OPEN_MARKET_ACTION, isHome ? null : serverName, isHome ? null : serverId, null, null);

            menu.appendChild(htmlEl('div', 'nm-ctx-divider'));

            // SKIP toggle — flips IN PLACE (no openMenu rebuild, so no flicker
            // or position jump). The storage write triggers a map re-render
            // that updates the node's override badge live.
            const skipBtn = htmlEl('button', 'nm-ctx-item nm-ctx-toggle');
            const renderSkip = (on) => {
                skipBtn.classList.toggle('is-on', on);
                skipBtn.textContent = (on ? '☑ ' : '☐ ') + t('autojobs.skipServer');
            };
            renderSkip(!!ov.skip);
            skipBtn.addEventListener('click', () => {
                const next = !skipBtn.classList.contains('is-on');
                renderSkip(next);
                patchOverride(serverName, (c) => { c.skip = next; });
            });
            menu.appendChild(skipBtn);

            // Per-server job-type disables — compact chip grid (green = runs
            // here / grey = muted here), same visual as Master Switches. Each
            // chip toggles in place; no scroll.
            menu.appendChild(htmlEl('div', 'nm-ctx-sub', t('autojobs.disableTypesHere')));
            const disabled = ov.disabledTypes || {};
            const chipsWrap = htmlEl('div', 'nm-ctx-chips');
            for (const type of JOB_TYPES) {
                const chip = htmlEl('button', 'aj-ms-chip' + (disabled[type] ? '' : ' on'), t('autojobs.jobType.' + type));
                chip.addEventListener('click', () => {
                    const runsHere = !chip.classList.contains('on');   // off → enable, on → disable
                    chip.classList.toggle('on', runsHere);
                    patchOverride(serverName, (c) => {
                        c.disabledTypes = c.disabledTypes || {};
                        if (runsHere) delete c.disabledTypes[type];
                        else c.disabledTypes[type] = true;
                    });
                });
                chipsWrap.appendChild(chip);
            }
            menu.appendChild(chipsWrap);

            // Reset — clears skip + every type disable for this server.
            const resetBtn = htmlEl('button', 'nm-ctx-item nm-ctx-reset', t('autojobs.resetOverrides'));
            resetBtn.addEventListener('click', () => {
                renderSkip(false);
                chipsWrap.querySelectorAll('.aj-ms-chip').forEach((c) => c.classList.add('on'));
                patchOverride(serverName, (c) => { c.skip = false; c.disabledTypes = {}; });
            });
            menu.appendChild(resetBtn);

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

        // Pan + left-click tap-select are owned by the shared pan/zoom
        // controller (onTap above). Right-click context menu stays here.

        // Right-click a node → context menu (Open SAI/Market + per-server
        // overrides). Always suppress the browser menu over the map.
        svg.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            const nodeG = e.target.closest && e.target.closest('.nm-node');
            const name = nodeG ? nodeG.getAttribute('data-name') : null;
            if (name) openMenu(name, e.clientX, e.clientY);
            else closeMenu();
        });

        fitBtn.addEventListener('click', () => fit());

        const summaryStatus = wrap.querySelector('.nm-summary-status');
        let firstRender = true;

        // Refresh reentrancy token — refresh() awaits a storage batch, so two
        // overlapping calls can resolve out of order; only the NEWEST may paint.
        let refreshSeq = 0;

        async function refresh() {
            const seq = ++refreshSeq;
            const [graph, home, dark, srm, usol, overrides, switches, queue, loadout] = await Promise.all([
                Store.local.getOne(SL.NM_GRAPH, null),
                Store.local.getOne(SL.MARKET, null),
                Store.local.getOne(SL.DARK_MARKET, null),
                Store.local.getOne(SL.SRM_MARKET, null),
                Store.local.getOne(SL.USOL_MARKET, null),
                Store.local.getOne(SL.AJ_SERVER_OVERRIDES, {}),
                Store.local.getOne(SL.AJ_MASTER_SWITCHES, {}),
                Store.local.getOne(SL.AJ_JOB_QUEUE, null),
                Store.local.getOne(SL.LOADOUT, null),
            ]);
            if (seq !== refreshSeq) return;   // superseded while awaiting — the newer refresh paints

            // Live route from HOME — mirrors the pipeline's CHECK_ACCESS verdict
            // (noPath). Computable only off a complete envelope: GET_SERVERS
            // hard-requires home + connections[]; a stale pre-connections
            // envelope yields no verdict here (the orchestrator's REQUEST_NM_MAP
            // refreshes it within seconds).
            pathReachable = (graph && graph.home && Array.isArray(graph.servers) && Array.isArray(graph.connections))
                ? computePathReachability(graph.servers, graph.connections, graph.home)
                : null;

            // Map each market server to its slot so we can dim it when its
            // Master Switch is off. home = the graph's home (no envelope
            // needed). dark/srm matched by marketId — but the live envelope may
            // not have loaded yet this session, so also use the slot↔marketId
            // pairs the pipeline recorded in AJ_JOB_QUEUE (those persist even
            // while the live envelope is absent). Without this the tile shows
            // enabled while the pipeline already suppresses the market.
            const marketSlotByName = {};
            const homeNm = graph && graph.home;
            const marketIdToSlot = {};
            if (queue && Array.isArray(queue.markets)) {
                for (const m of queue.markets) if (m && m.marketId && m.slot) marketIdToSlot[m.marketId] = m.slot;
            }
            if (dark && dark.marketId) marketIdToSlot[dark.marketId] = 'dark';
            if (srm && srm.marketId) marketIdToSlot[srm.marketId] = 'srm';
            if (usol && usol.marketId) marketIdToSlot[usol.marketId] = 'usol';
            for (const s of (graph && graph.servers) || []) {
                if (!s || !s.name) continue;
                if (s.name === homeNm || s.serverTypeName === 'Home') marketSlotByName[s.name] = 'home';
                else if (s.marketId && marketIdToSlot[s.marketId]) marketSlotByName[s.name] = marketIdToSlot[s.marketId];
            }

            const ctx = {
                graph,
                homeName: graph?.home || null,
                currentEndpointName: graph?.currentEndpointName || null,
                jobCounts: buildJobCounts([home, dark, srm, usol]),
                overrides: overrides || {},
                switches: switches || {},
                marketSlotByName,
                pathReachable,
                // HACK capability per server type (from the loadout snapshot) —
                // lets us highlight a not-accessible-but-hackable server.
                hackDerived: (loadout && loadout._derived && loadout._derived.hackServerTypes) || null,
            };

            // Index servers for the context menu (name → server object, so the
            // menu knows market-ness, home-ness, etc.).
            serversByName.clear();
            homeName = ctx.homeName;
            for (const s of (graph && graph.servers) || []) {
                if (s && s.name) serversByName.set(s.name, s);
            }

            const dims = render(camera, ctx);
            applySelection();   // cards were rebuilt — restore the highlight
            world = dims;
            const visualHeight = 320;
            svg.style.height = visualHeight + 'px';

            if (summaryStatus) {
                if (!graph) {
                    summaryStatus.textContent = t('autojobs.nmNoGraph');
                } else {
                    const N = graph.servers.length;
                    const kd = graph.servers.filter((s) => s.isInMaintenance).length;
                    summaryStatus.textContent = t('autojobs.nmServers', { n: N }) + (kd > 0 ? t('autojobs.nmKd', { n: kd }) : '');
                }
            }
            if (firstRender) {
                firstRender = false;
                requestAnimationFrame(() => fit());
            } else {
                panZoom.applyCamera();
            }
        }

        const localUnsub = Store.local.onChanged((c) => {
            if (c[SL.NM_GRAPH] || c[SL.MARKET] || c[SL.DARK_MARKET] || c[SL.SRM_MARKET] || c[SL.USOL_MARKET]
                || c[SL.AJ_SERVER_OVERRIDES] || c[SL.AJ_MASTER_SWITCHES] || c[SL.AJ_JOB_QUEUE] || c[SL.LOADOUT]) refresh();
        });

        // Track whether Auto Jobs is running — Open SAI / Open Market are
        // blocked while it is. Re-render an open menu so its buttons reflect
        // the new state immediately.
        const SS = C.STORAGE_SYNC;
        // Once a change event has fired, the initial getOne read is stale by
        // definition — drop it (same guard as section.js's visSeenChange).
        let v2SeenChange = false;
        const syncUnsub = Store.sync.onChanged((c) => {
            if (!c[SS.AUTOJOBS_SETTINGS]) return;
            v2SeenChange = true;
            const nv = c[SS.AUTOJOBS_SETTINGS].newValue;
            v2Enabled = !!(nv && nv.enabled);
            if (menuEl && menuFor != null) openMenu(menuFor, menuX, menuY);
        });
        Store.sync.getOne(SS.AUTOJOBS_SETTINGS, { enabled: false }).then((s) => { if (!v2SeenChange) v2Enabled = !!(s && s.enabled); });

        refresh();

        // Register as the live instance so sibling components (the Job List's
        // 🔍 locate button) can drive focusServer without holding a reference.
        activeInstance = { focusServer };

        return {
            destroy() {
                if (activeInstance && activeInstance.focusServer === focusServer) activeInstance = null;
                closeMenu();
                if (typeof localUnsub === 'function') localUnsub();
                if (typeof syncUnsub === 'function') syncUnsub();
                panZoom.destroy();
                container.innerHTML = '';
            },
            refresh,
            fit,
            focusServer,
        };
    }

    // The currently-attached Network Map (one per popup). Sibling components
    // reach it through the static focusServer delegate below.
    let activeInstance = null;

    root.COR3 = root.COR3 || {};
    root.COR3.uiComponents = root.COR3.uiComponents || {};
    root.COR3.uiComponents.networkMap = {
        attach,
        focusServer(name) { if (activeInstance) activeInstance.focusServer(name); },
    };
})();
