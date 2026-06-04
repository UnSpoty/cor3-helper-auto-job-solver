// MAIN-world WebSocket interceptor. Responsibilities:
//   • Wrap window.WebSocket so all cor3/corie connections are tracked.
//   • Parse Socket.IO v4 frames via COR3.wsFrames.
//   • Translate inbound game events to typed Bus messages (MSG.WS.*).
//   • Expose window.__cor3* outbound helpers consumed by the isolated
//     world (job manager, solvers, UI).
// IIFE — no Module class here (no chrome.storage in MAIN world).

(function () {
    if (window.__cor3WsInterceptorActive) return;
    window.__cor3WsInterceptorActive = true;

    const root = window;
    const C = root.COR3 && root.COR3.constants;
    const Bus = root.COR3 && root.COR3.Bus;
    const wsFrames = root.COR3 && root.COR3.wsFrames;
    if (!C || !Bus || !wsFrames) {
        console.error('[COR3.ws-interceptor] missing COR3.constants/Bus/wsFrames — load order is wrong');
        return;
    }

    const MSG = C.MSG;
    const post = (type, payload) => Bus.window.post(type, payload);

    // ──────────────────────────────────────────────────────────────────────
    // Socket tracking
    // ──────────────────────────────────────────────────────────────────────
    const OrigWebSocket = window.WebSocket;
    const trackedSockets = [];
    let activeSocket = null;
    const socketLastActivity = new Map();

    // SAI get.login.status one-shot map: serverId -> resolve(statusData).
    // Declared HERE (above dispatchEvent, which reads it) so there's no
    // declaration-order question; set by __cor3SaiGetLoginStatus below and
    // resolved by the `sai` inbound handler.
    const pendingSaiLoginStatus = {};

    // ──────────────────────────────────────────────────────────────────────
    // Token-expired retry queue
    // ──────────────────────────────────────────────────────────────────────
    let pendingRetryOps = [];
    let tokenExpiredFlag = false;

    function queueRetryOp(opName) {
        if (!pendingRetryOps.includes(opName)) pendingRetryOps.push(opName);
    }

    function runPendingRetries() {
        if (pendingRetryOps.length === 0) return;
        console.log('[COR3] Retrying pending operations:', pendingRetryOps.join(', '));
        const ops = pendingRetryOps.slice();
        pendingRetryOps = [];
        tokenExpiredFlag = false;
        ops.forEach((op) => {
            setTimeout(() => {
                if (op === 'expeditions') root.__cor3RequestExpeditions();
                else if (op === 'market') root.__cor3RequestMarket();
                else if (op === 'darkMarket') root.__cor3RequestDarkMarket();
                else if (op === 'srmMarket') root.__cor3RequestSrmMarket();
                else if (op === 'usolMarket') root.__cor3RequestUsolMarket();
                else if (op === 'stash') root.__cor3RequestStash();
                else if (op === 'dailyOps') post('COR3_FETCH_DAILY_OPS', null);
                else if (op === 'networkMap') root.__cor3RequestNetworkMap();
                else if (op === 'archivedExpeditions') root.__cor3RequestArchivedExpeditions();
                else if (op.startsWith('decision:')) {
                    try {
                        const data = JSON.parse(op.substring(9));
                        root.__cor3RespondDecision(data.expeditionId, data.messageId, data.selectedOption);
                    } catch (_) { /* silent */ }
                }
            }, humanDelay());
        });
    }

    // ──────────────────────────────────────────────────────────────────────
    // WebSocket Proxy
    // ──────────────────────────────────────────────────────────────────────
    const WebSocketProxy = new Proxy(OrigWebSocket, {
        construct(target, args) {
            const ws = new target(...args);
            const url = args[0] || '';
            if (url.includes('cor3') || url.includes('corie')) {
                // socket.io reconnects flap on every transport hiccup — the
                // log was firing N times a minute. Demoted to console.debug
                // so it's still inspectable in DevTools (verbose level) but
                // doesn't fill the default console.
                console.debug('[COR3] Tracking WebSocket:', url);
                ws.__cor3Url = url;
                trackedSockets.push(ws);

                // Ensure binary frames arrive as ArrayBuffer (cor3.gg
                // uses msgpack-encoded binary frames). socket.io itself
                // sets this on the underlying transport, but if our Proxy
                // intercepts an instance before the lib assigns it we'd
                // otherwise get Blobs and decode would fail.
                try { ws.binaryType = 'arraybuffer'; } catch (_) {}

                ws.addEventListener('message', (event) => {
                    try {
                        if (activeSocket !== ws) {
                            console.debug('[COR3] Active socket changed to:', ws.__cor3Url);
                            activeSocket = ws;
                        }
                        socketLastActivity.set(ws, Date.now());
                        const d = event.data;
                        if (d instanceof ArrayBuffer || ArrayBuffer.isView(d)) {
                            handleWsBinary(d, ws);
                        } else if (typeof d === 'string') {
                            // engine.io control frames — open ("0{...}"),
                            // ping ("2"), pong ("3"), Socket.IO-level text
                            // packets if cor3.gg ever falls back from msgpack.
                            handleWsText(d, ws);
                        }
                    } catch (_) { /* silent */ }
                });

                // Wrap ws.send so we see EVERY outbound — both our extension's
                // get.jobs / set.endpoint (issued via wsSend below) AND
                // cor3.gg's own that fires when the user opens a Market panel
                // or clicks a server in Network Map. Both responses arrive on
                // this socket; without this hook we'd attribute get.jobs to
                // the wrong slot, and we'd lose track of the user's current
                // endpoint (needed to revert after our preflight dance).
                // Parsers: captureOutboundGetJobs / captureOutboundSetEndpoint.
                const origWsSend = ws.send.bind(ws);
                ws.send = function (data) {
                    try { captureOutboundGetJobs(data); } catch (_) { /* silent */ }
                    try { captureOutboundSetEndpoint(data); } catch (_) { /* silent */ }
                    return origWsSend(data);
                };

                ws.addEventListener('open', () => {
                    console.debug('[COR3] WS connected — scheduling initial data fetch');
                    setTimeout(() => {
                        if (tokenExpiredFlag || pendingRetryOps.length > 0) {
                            setTimeout(runPendingRetries, 2000);
                        }
                        if (typeof root.__cor3InitialFetch === 'function') root.__cor3InitialFetch();
                    }, 3000);
                });

                ws.addEventListener('close', () => {
                    console.debug('[COR3] WS closed');
                    const idx = trackedSockets.indexOf(ws);
                    if (idx !== -1) trackedSockets.splice(idx, 1);
                    socketLastActivity.delete(ws);
                    if (activeSocket === ws) activeSocket = null;
                });
            }
            return ws;
        },
        get(target, prop, receiver) { return Reflect.get(target, prop, receiver); },
    });
    Object.defineProperty(WebSocketProxy, 'prototype', {
        value: OrigWebSocket.prototype, writable: false, configurable: false,
    });
    window.WebSocket = WebSocketProxy;

    // ──────────────────────────────────────────────────────────────────────
    // Inbound message dispatch.
    //
    // Every Socket.IO-level message is an ArrayBuffer carrying msgpack
    // {type, data, nsp}. Engine.io control frames ("0{sid:...}", "2"/"3"
    // ping/pong) are text.
    //
    // handleWsText  — engine.io controls (and a defensive JSON-text path
    //                 in case cor3.gg ever falls back).
    // handleWsBinary — hot path: msgpack-decode, then funnel into
    //                  dispatchEvent.
    // ──────────────────────────────────────────────────────────────────────
    function handleWsText(rawData, _socket) {
        if (!rawData || rawData.length === 0) return;
        const engineType = rawData[0];
        if (engineType !== '4') return;
        const frame = wsFrames.parseFrame(rawData);
        if (!frame || frame.eventName === null) return;
        dispatchEvent(frame.eventName, frame.payload);
    }

    function handleWsBinary(buffer, _socket) {
        const frame = wsFrames.parseBinaryFrame(buffer);
        if (!frame) return;
        if (frame.sioType !== 2 || frame.eventName === null) return;
        dispatchEvent(frame.eventName, frame.payload);
    }

    function dispatchEvent(eventName, payload) {
        // Token-expired → close all sockets, queue retries
        if (eventName === 'error' && payload && payload.message === 'token-expired') {
            console.log('[COR3] Token expired — closing sockets to force reconnect');
            tokenExpiredFlag = true;
            // Include networkMap (NM_GRAPH) + archivedExpeditions: the open
            // handler's __cor3InitialFetch is a no-op once initialFetchDone is
            // set, so without queueing them here the depth graph and the
            // archive go stale after every token-expired reconnect.
            ['expeditions', 'market', 'darkMarket', 'srmMarket', 'usolMarket', 'stash', 'dailyOps', 'networkMap', 'archivedExpeditions'].forEach(queueRetryOp);
            post(MSG.AUTH.TOKEN_EXPIRED, null);
            for (const s of trackedSockets.slice()) {
                try { s.close(); } catch (_) {}
            }
            setTimeout(() => {
                if (trackedSockets.length === 0) {
                    console.warn('[COR3] No new WebSocket after token-expired — page refresh may be needed');
                } else {
                    console.log('[COR3] WebSocket reconnected after token-expired');
                }
            }, 15000);
            return;
        }

        // stash → COR3_WS_STASH
        if (eventName === 'stash' && payload && payload.data) {
            post(MSG.WS.STASH, { stash: payload.data });
            return;
        }

        // loadout → COR3_WS_LOADOUT. Server only emits one action so far
        // (get.options, in reply to our join-room). Forward the whole
        // payload.data verbatim — both the data-module and the
        // loadout-panel UI consume it.
        if (eventName === 'loadout' && payload && payload.data) {
            post(MSG.WS.LOADOUT, { data: payload.data });
            return;
        }

        // desktop — OS-shell events. Three actions matter to us:
        //   • get.options — full snapshot of folders/files; used to cache
        //     the Downloads folder id once per session.
        //   • open.folder — list of files in a folder; replaces the
        //     scrape-FolderApplication-DOM path for file-decryption.
        //   • open.file / update.file — emitted when a file's metadata
        //     changes (notably when the server re-issues a fileId after
        //     job.take). file-decryption uses this to follow the live id.
        // Forward as MSG.WS.DESKTOP_* with the raw payload so consumers
        // can inspect data + error themselves.
        if (eventName === 'desktop' && payload && payload.event) {
            const dAction = payload.event.action;
            if (dAction === 'get.options') {
                // Cache the Downloads folder id globally so flows / future
                // open.folder calls don't have to re-resolve it. Safe to
                // overwrite — the id is stable for the session.
                if (payload.data && Array.isArray(payload.data.folders)) {
                    const dl = payload.data.folders.find((f) => f && (f.name === 'Downloads'));
                    if (dl && dl.id) root.__cor3DownloadFolderId = dl.id;
                }
                post(MSG.WS.DESKTOP_OPTIONS, { data: payload.data || null, error: payload.error || null });
                return;
            }
            if (dAction === 'open.folder') {
                post(MSG.WS.DESKTOP_FOLDER, { data: payload.data || null, error: payload.error || null });
                return;
            }
            if (dAction === 'open.file' || dAction === 'update.file') {
                post(MSG.WS.DESKTOP_FILE, { data: payload.data || null, error: payload.error || null });
                return;
            }
            // Other desktop actions (move/rename/delete) — no consumers
            // today, drop silently to avoid noise on the bus.
            return;
        }

        // expeditions: many actions
        if (eventName === 'expeditions') {
            const action = payload && payload.event && payload.event.action;

            if (action === 'get.mercenaries') {
                if (payload.data && payload.data.mercenaries) {
                    root.__cor3CachedMercIds = payload.data.mercenaries.map((m) => m.id);
                }
                post(MSG.WS.MERCENARIES, { data: payload.data });
                if (!root.__cor3ExpConfigIds) {
                    setTimeout(() => root.__cor3RequestExpeditionConfig(), 500);
                } else if (root.__cor3CachedMercIds) {
                    cascadeMercConfigure();
                }
                return;
            }

            if (action === 'get.config') {
                if (payload.data && payload.data.locations && payload.data.locations.length > 0) {
                    const loc = payload.data.locations[0];
                    root.__cor3ExpConfigIds = {
                        locationConfigId: loc.id,
                        zoneConfigId: loc.zones && loc.zones[0] ? loc.zones[0].id : null,
                        objectiveId: loc.zones && loc.zones[0] && loc.zones[0].objectives && loc.zones[0].objectives[0]
                            ? loc.zones[0].objectives[0].id : null,
                    };
                }
                post(MSG.WS.EXPEDITION_CONFIG, { data: payload.data });
                if (root.__cor3CachedMercIds && root.__cor3ExpConfigIds) cascadeMercConfigure();
                return;
            }

            if (action === 'open.container') {
                post(MSG.WS.CONTAINER_OPENED, { data: payload.data });
                return;
            }

            if (action === 'collect.all') {
                if (payload.error && payload.error.message === 'stash.error.insufficient_capacity') {
                    post('COR3_WS_STASH_FULL', { error: payload.error.message, requestId: payload.requestId });
                } else {
                    post(MSG.WS.COLLECTED_ALL, { data: payload.data });
                }
                return;
            }

            if (action === 'launch') {
                if (payload.error && payload.error.message === 'Maximum 1 active expedition allowed') {
                    console.log('[COR3] Expedition launch blocked: max 1 active');
                    post(MSG.WS.EXPEDITION_LAUNCH_ERROR, { error: payload.error.message, retryAfter: 120000 });
                    setTimeout(() => post(MSG.WS.EXPEDITION_RETRY_LAUNCH, { retryData: payload.requestId }), 120000);
                    return;
                }
                if (payload.error && payload.error.message === 'insufficient-credits') {
                    console.log('[COR3] Expedition launch blocked: insufficient credits');
                    post(MSG.WS.INSUFFICIENT_CREDITS, { error: payload.error.message });
                    return;
                }
                post(MSG.WS.EXPEDITION_LAUNCHED, { data: payload.data });
                post(MSG.WS.DECISIONS, { decisions: [] });
                setTimeout(() => root.__cor3RequestExpeditions(), 1000 + Math.floor(Math.random() * 500));
                return;
            }

            if (action === 'configure') {
                const mercId = (root.__cor3PendingMercConfigures && root.__cor3PendingMercConfigures.length > 0)
                    ? root.__cor3PendingMercConfigures.shift() : null;
                post(MSG.WS.MERC_CONFIGURE, { mercenaryId: mercId, data: payload.data });
                return;
            }

            if (action === 'get.archived') {
                // Unwrap data.expeditions when present so the module can
                // subscribe with the same envelope shape as MSG.WS.EXPEDITIONS.
                const archived = (payload.data && Array.isArray(payload.data.expeditions))
                    ? payload.data.expeditions
                    : (Array.isArray(payload.data) ? payload.data : []);
                post(MSG.WS.ARCHIVED_EXPEDITIONS, { expeditions: archived });
                return;
            }

            if (action === 'update') {
                console.log('[COR3] Expedition update event — flows through existing handlers');
                return;
            }

            // Default: bulk expedition data with embedded decisions
            if (payload && payload.data) {
                const expeditions = Array.isArray(payload.data) ? payload.data : [payload.data];
                post(MSG.WS.EXPEDITIONS, { expeditions });

                const decisions = [];
                for (const exp of expeditions) {
                    if (!exp.messages) continue;
                    for (const msg of exp.messages) {
                        if (msg.decisionOptions) {
                            decisions.push({
                                expeditionId: exp.id,
                                mercenaryCallsign: exp.mercenary ? exp.mercenary.callsign : 'Unknown',
                                locationName: exp.locationName || '',
                                zoneName: exp.zoneName || '',
                                riskScore: exp.riskScore || 0,
                                messageId: msg.id,
                                content: msg.content,
                                decisionOptions: msg.decisionOptions,
                                selectedOption: msg.selectedOption,
                                decisionDeadline: msg.decisionDeadline,
                                isResolved: msg.isResolved,
                                isAutoResolved: msg.isAutoResolved || false,
                                createdAt: msg.createdAt,
                            });
                        }
                    }
                }
                if (decisions.length > 0) post(MSG.WS.DECISIONS, { decisions });
            }
            return;
        }

        // market: job-take/complete responses, plus market data
        if (eventName === 'market' && payload) {
            const action = payload.event && payload.event.action;
            if (action === 'job.take') {
                post(MSG.WS.JOB_ACCEPTED, { data: payload.data, error: payload.error || null });
                // fall through — response may also carry market data
            }
            if (action === 'job.completed' || action === 'job.complete') {
                post(MSG.WS.JOB_COMPLETED, { data: payload.data, error: payload.error || null });
                return;
            }
            // get.jobs (new endpoint, replaces get.options for fetching the
            // job board). Response shape: payload.data = { jobs, recentJobs,
            // nextJobsResetAt } — the old payload.data.market wrapper is
            // gone. The response carries no marketId echo, so we FIFO-pop
            // the pending-request queue. The queue is filled by
            // captureOutboundGetJobs (wrapped ws.send above), which catches
            // BOTH our extension's get.jobs AND cor3.gg's own — the latter
            // fires whenever the user opens a Market panel in-game, and we
            // need to consume those entries in lockstep or attribution drifts.
            //
            // ALWAYS pop the queue (even on errors / no-data) so order stays
            // aligned with the wire. If the queue is empty (response without
            // a recognized outbound) we'd rather drop the frame than guess —
            // the previous "fall through to Home Market" behaviour was the
            // root cause of the cross-market data pollution bug.
            if (action === 'get.jobs') {
                // Always pop the FIFO queue so order stays aligned (errors and
                // success both consume an entry).
                const pending = popPendingMarketJobsRequest();

                // Error response — server echoes marketId in error.marketId,
                // which is more reliable than the FIFO entry. Use it.
                if (payload.error) {
                    const errMarketId = payload.error.marketId || pending?.marketId;
                    if (!errMarketId) return;
                    const cfg = MARKET_BY_ID[errMarketId];
                    if (payload.error.message === 'market-not-reachable' && cfg && cfg.unreachable) {
                        post(MSG.WS[cfg.unreachable], {
                            error: payload.error.message,
                            marketId: errMarketId,
                            serverId: payload.error.marketServer,
                        });
                    } else {
                        console.debug('[COR3] get.jobs error', payload.error, 'market', errMarketId);
                    }
                    return;
                }

                if (!payload.data || !pending) return;
                const marketId = pending.marketId;
                const out = {
                    marketId,
                    jobs: Array.isArray(payload.data.jobs) ? payload.data.jobs : [],
                    recentJobs: Array.isArray(payload.data.recentJobs) ? payload.data.recentJobs : [],
                    nextJobsResetAt: payload.data.nextJobsResetAt || null,
                };
                const cfg = MARKET_BY_ID[marketId];
                if (cfg) {
                    post(MSG.WS[cfg.main], { market: out });
                    if (marketId === HOME_MARKET_ID) root.__cor3LastMarketId = marketId;
                } else {
                    // Untracked market — could be a future market we don't track.
                    console.debug('[COR3] get.jobs response for untracked market', marketId);
                }
                return;
            }
            // get.options still arrives (cor3.gg sends it alongside get.jobs
            // when the user opens the market UI manually) — it carries
            // marketName, reputation, userCredits. We don't currently use
            // those, so swallow without forwarding to keep storage clean.
            if (action === 'get.options') return;
            return;
        }

        // network-map: set.endpoint result. We do TWO things here:
        //   1. Correct currentEndpoint from data.servers — server returns the
        //      full server list with isEndpoint flags, the truthful source.
        //   2. Surface no-path-to-server failures. (Canonical unreachable
        //      detection lives on the market.get.jobs response
        //      `market-not-reachable` error; this is a secondary signal.)
        if (eventName === 'network-map' && payload && payload.event) {
            if (payload.event.action === 'set.endpoint') {
                if (payload.data && Array.isArray(payload.data.servers)) {
                    const ep = payload.data.servers.find((s) => s && s.isEndpoint === true);
                    if (ep && ep.id) setCurrentEndpoint(ep.id);
                }
                if (payload.error && payload.error.message === 'no-path-to-server') {
                    console.log('[COR3] no-path-to-server for', payload.error.serverId);
                    if (payload.error.serverId === DARK_SERVER_ID) {
                        post(MSG.WS.DARK_MARKET_UNREACHABLE, { error: payload.error.message, serverId: payload.error.serverId });
                    } else if (payload.error.serverId === SRM_SERVER_ID) {
                        post(MSG.WS.SRM_MARKET_UNREACHABLE, { error: payload.error.message, serverId: payload.error.serverId });
                    } else if (payload.error.serverId === USOL_SERVER_ID) {
                        post(MSG.WS.USOL_MARKET_UNREACHABLE, { error: payload.error.message, serverId: payload.error.serverId });
                    }
                    root.__serverPathFailed = true;
                    setTimeout(() => { root.__serverPathFailed = false; }, 5000);
                } else {
                    post('COR3_WS_ENDPOINT_RESULT', { success: !payload.error, data: payload.data });
                }
            }
            // get.map: full topology (servers + adjacency). cor3.gg fires it
            // when the user opens the Network Map panel; we also send it
            // ourselves on initial fetch so the depth-priority feature works
            // before the user has opened NM. We BFS from HOME to attach a
            // depth to each server, then post a flat NM_GRAPH envelope to
            // isolated for storage. Used by auto-jobs to deprioritise hub
            // servers (low depth = closer to home = K/D'ing it cuts more).
            if (payload.event.action === 'get.map' && payload.data) {
                const enriched = computeNmGraph(payload.data);
                if (enriched) post(MSG.GAME.NM_GRAPH, enriched);
            }
            return;
        }

        // sai: Server Admin Interface room.
        //   • get.login.status — resolves the one-shot set by
        //     __cor3SaiGetLoginStatus; its activeAccesses[] + hackTools[] drive
        //     the bridge's SAI access orchestration.
        //   • login.with-access — the server's verdict on our login. The bridge
        //     only logged that the request was SENT, so surface the real
        //     success/failure here (on MSG.JOB.LOG, which the bridge mirrors).
        //   • get.summary / get.transit / get.files / get.logs — the SAI tab
        //     reads, relayed to MSG.WS.SAI_* so an Auto Jobs flow can awaitBus
        //     the reply (no DOM scrape). Wire shapes in tmp_research/sai-wire-capture.md.
        //   • transit.add/remove · file.download/delete · log.download/delete —
        //     mutation verdicts, relayed on a single MSG.WS.SAI_ACTION channel
        //     tagged with `action` (the flow filters on it).
        if (eventName === 'sai' && payload && payload.event) {
            const action = payload.event.action;
            if (action === 'get.login.status' && payload.data) {
                const sid = payload.data.serverId;
                const cb = sid ? pendingSaiLoginStatus[sid] : null;
                if (cb) { delete pendingSaiLoginStatus[sid]; try { cb(payload.data); } catch (_) { /* noop */ } }
            } else if (action === 'login.with-access') {
                if (payload.error) post(MSG.JOB.LOG, { msg: `[sai] login.with-access failed: ${(payload.error && (payload.error.message || payload.error.key)) || 'error'}`, level: 'warn' });
                else if (payload.data && payload.data.success) post(MSG.JOB.LOG, { msg: '[sai] login.with-access → success', level: 'info' });
            } else if (action === 'get.summary') {
                post(MSG.WS.SAI_SUMMARY, { data: payload.data || null, error: payload.error || null });
            } else if (action === 'get.transit') {
                post(MSG.WS.SAI_TRANSIT, { data: payload.data || null, error: payload.error || null });
            } else if (action === 'get.files') {
                post(MSG.WS.SAI_FILES, { data: payload.data || null, error: payload.error || null });
            } else if (action === 'get.logs') {
                post(MSG.WS.SAI_LOGS, { data: payload.data || null, error: payload.error || null });
            } else if (action === 'transit.add' || action === 'transit.remove'
                || action === 'file.download' || action === 'file.delete' || action === 'file.upload'
                || action === 'log.download' || action === 'log.delete') {
                post(MSG.WS.SAI_ACTION, { action, data: payload.data || null, error: payload.error || null });
            }
            return;
        }

        // minigames: capture the LAUNCHED game's own metadata — notably its
        // timerDurationMs — so callers can size waits to the actual game instead
        // of a hardcoded ceiling. start.minigame is the lifecycle launch
        // (file-decryption, SAI hack, …); we keep the latest in __cor3LastMinigame.
        if (eventName === 'minigames' && payload && payload.event) {
            if (payload.event.action === 'start.minigame' && payload.data) {
                const d = payload.data;
                const sp = (d.meta && d.meta.staticParams) || {};
                root.__cor3LastMinigame = {
                    id: d.id || null,
                    type: d.type || null,
                    timerDurationMs: Number(sp.timerDurationMs) || null,
                    maxAttempts: Number(sp.maxAttempts) || null,
                    at: Date.now(),
                };
            }
            return;
        }
    }

    function computeNmGraph(data) {
        const servers = Array.isArray(data.servers) ? data.servers : null;
        const conns   = Array.isArray(data.connections) ? data.connections : [];
        if (!servers) return null;

        // Build TWO adjacency maps: visible edges only, and all edges
        // including the hidden "gateway" ones (e.g. RM7-E1SCP <-> D4RK RM7CE
        // is isHidden:true even when the user is currently on D4RK). The
        // visible map gives the "normal" depth used to sort priority; the
        // all-edges map makes sure we can still reach side-network servers
        // (D4RK, SRM7) and show them with finite depth + a viaHidden flag
        // instead of ∞.
        const adjVisible = {};
        const adjAll = {};
        for (const c of conns) {
            const a = c.serverA, b = c.serverB;
            if (!a || !b) continue;
            (adjAll[a] = adjAll[a] || []).push(b);
            (adjAll[b] = adjAll[b] || []).push(a);
            if (!c.isHidden) {
                (adjVisible[a] = adjVisible[a] || []).push(b);
                (adjVisible[b] = adjVisible[b] || []).push(a);
            }
        }

        // BFS returning depth + parent map. Parents let consumers
        // (reachability planner, popup Network Map UI) reconstruct the
        // HOME → server path one hop at a time without re-doing the BFS.
        function bfsFrom(rootId, adj) {
            const depths = {};
            const parents = {};
            if (!rootId) return { depths, parents };
            depths[rootId] = 0;
            const q = [rootId];
            while (q.length) {
                const cur = q.shift();
                for (const n of (adj[cur] || [])) {
                    if (depths[n] === undefined) {
                        depths[n] = depths[cur] + 1;
                        parents[n] = cur;
                        q.push(n);
                    }
                }
            }
            return { depths, parents };
        }

        // HOME marker: serverTypeName === 'Home' OR faction === 'HOME'.
        const home = servers.find((s) => s && (s.serverTypeName === 'Home' || s.faction === 'HOME'));
        const visible = bfsFrom(home?.id, adjVisible);
        const all     = bfsFrom(home?.id, adjAll);
        const depthsVisible = visible.depths;
        const depthsAll     = all.depths;
        // id → name lookup for parent name materialisation.
        const nameById = {};
        for (const s of servers) if (s && s.id) nameById[s.id] = s.serverName;

        // Per-market BFS roots: priority logic needs to know "how far is
        // server X from THIS market's gateway" not just from HOME. When
        // we're running D4RK jobs the depth-priority should drain leaves
        // of the D4RK side network first, not the HOME side. Each market
        // root maps to its gateway server id (the canonical static IDs
        // declared further down in this IIFE).
        const marketRootIds = {
            [HOME_MARKET_ID]: home?.id || HOME_SERVER_ID,
            [DARK_MARKET_ID]: DARK_SERVER_ID,
            [SRM_MARKET_ID]:  SRM_SERVER_ID,
            [USOL_MARKET_ID]: USOL_SERVER_ID,
        };
        const depthsByMarket = {};
        for (const mid of Object.keys(marketRootIds)) {
            const rootId = marketRootIds[mid];
            if (!rootId) continue;
            const { depths } = bfsFrom(rootId, adjAll);
            const named = {};
            for (const sid of Object.keys(depths)) {
                const nm = nameById[sid];
                if (nm) named[nm] = depths[sid];
            }
            depthsByMarket[mid] = named;
        }

        // Resolve connection ids to server names so consumers (UI Network
        // Map, future planner) don't have to keep their own id→name map.
        // Each entry: { a, b, isHidden }. We deduplicate (a,b)/(b,a) pairs
        // since the in-game graph is undirected.
        const seenEdge = new Set();
        const namedConnections = [];
        for (const c of conns) {
            const a = c.serverA, b = c.serverB;
            if (!a || !b) continue;
            const aName = nameById[a];
            const bName = nameById[b];
            if (!aName || !bName) continue;
            const key = aName < bName ? `${aName}|${bName}` : `${bName}|${aName}`;
            if (seenEdge.has(key)) continue;
            seenEdge.add(key);
            namedConnections.push({ a: aName, b: bName, isHidden: !!c.isHidden });
        }

        // Active path HOME → currentEndpoint. UI highlights these edges
        // cyan so the operator sees which servers are being traversed.
        // Walks parents chain back from endpoint until we hit a node with
        // no parent (HOME). visible.parents wins; falls back to all.parents
        // for endpoints only reachable via a hidden gateway.
        const homePath = [];
        const endpointId = data.currentEndpointId || null;
        if (endpointId && endpointId !== (home && home.id)) {
            let cur = endpointId;
            let guard = 200;
            while (cur != null && guard-- > 0) {
                const pid = visible.parents[cur] !== undefined ? visible.parents[cur] : all.parents[cur];
                if (pid === undefined) break;
                const aName = nameById[pid];
                const bName = nameById[cur];
                if (aName && bName) homePath.push({ a: aName, b: bName });
                cur = pid;
            }
        }

        return {
            home: home ? home.serverName : null,
            homeId: home ? home.id : null,
            currentEndpointId: data.currentEndpointId || null,
            currentEndpointName: endpointId ? (nameById[endpointId] || null) : null,
            homePath,
            // Timestamp so UI can show last-refresh time (helps confirm the
            // Refresh button actually fired even when topology didn't change).
            updatedAt: Date.now(),
            // Full undirected edge list. Why we ship the raw edges instead
            // of letting consumers rebuild them: parentName only captures
            // the BFS *tree* — every server gets one incoming edge. The
            // map has multi-parent servers (a node reachable via two
            // different upstream hops). Without the raw list, the popup
            // can only render the spanning tree.
            connections: namedConnections,
            // Per-market BFS depths: { [marketId]: { [serverName]: depth } }.
            // Auto-jobs priority sort consumes this so jobs running on the
            // D4RK side network rank by their distance from D4RK gateway
            // instead of from HOME — drains leaves first regardless of
            // which market we're currently working through.
            depthsByMarket,
            servers: servers.map((s) => {
                // Pick the parent from whichever BFS first found this node.
                // Visible-tree parent wins when available; the all-edges
                // tree fills in for nodes only reachable via a hidden edge
                // (D4RK side network).
                const pid = visible.parents[s.id] !== undefined
                    ? visible.parents[s.id]
                    : all.parents[s.id];
                return {
                    id: s.id,
                    name: s.serverName,
                    // depth: visible-edge BFS if reachable, else fall back to
                    // all-edges BFS (so D4RK/SRM still show a finite number).
                    depth: depthsVisible[s.id] ?? depthsAll[s.id] ?? null,
                    // parentName: previous hop on the BFS path from HOME.
                    // null for HOME itself or for orphaned nodes. Used by
                    // reachability.js to walk the path and check K/D state
                    // on every transit node, not just the destination.
                    parentName: pid !== undefined ? (nameById[pid] || null) : null,
                    // viaHidden: true when the only path from HOME goes through
                    // a gateway edge marked isHidden by the server (D4RK side
                    // network etc.). UI can use this for visual distinction.
                    viaHidden: depthsVisible[s.id] === undefined && depthsAll[s.id] !== undefined,
                    faction: s.faction,
                    cluster: s.serverCluster,
                    marketId: s.marketId || null,
                    canSetEndpoint: !!s.canSetEndpoint,
                    isInMaintenance: !!s.isInMaintenance,
                    // ── Fields added for the popup Network Map renderer ──
                    // serverPlace: [x, y] in the game's coordinate system.
                    // Used directly for positioning — no computed layout.
                    serverPlace: (Array.isArray(s.serverPlace) && s.serverPlace.length === 2
                        && Number.isFinite(s.serverPlace[0]) && Number.isFinite(s.serverPlace[1]))
                        ? [s.serverPlace[0], s.serverPlace[1]]
                        : null,
                    // serverColor: { main, secondary, highlighted } shipped
                    // per-server by the game. Renderer uses these directly
                    // so we don't have to maintain a faction → palette map.
                    serverColor: (s.serverColor && typeof s.serverColor === 'object') ? {
                        main: s.serverColor.main || null,
                        secondary: s.serverColor.secondary || null,
                        highlighted: s.serverColor.highlighted || null,
                    } : null,
                    // transitType: 'public' | 'private' | 'restricted'.
                    // Selects which type-glyph (4-triangle cross / quarter-
                    // disc flower / 2×2 diamond grid) renders in the centre.
                    transitType: s.transitType || null,
                    // serverTypeName: raw '<faction> <type>' string
                    // (e.g. 'CEDRT public') or 'Home'. Kept for HOME detect
                    // + debug; transitType is the cleaner field to consume.
                    serverTypeName: s.serverTypeName || null,
                    isNew: !!s.isNew,
                    isAccessible: !!s.isAccessible,
                    hasAdminAccess: !!s.hasAdminAccess,
                };
            }),
        };
    }

    function cascadeMercConfigure() {
        const ids = root.__cor3ExpConfigIds;
        const mercIds = (root.__cor3CachedMercIds || []).slice();
        (function next(i) {
            if (i >= mercIds.length) return;
            setTimeout(() => {
                root.__cor3RequestMercConfigure(mercIds[i], null, ids.locationConfigId, ids.zoneConfigId, ids.objectiveId);
                next(i + 1);
            }, humanDelay() + 400);
        })(0);
    }

    // ──────────────────────────────────────────────────────────────────────
    // wsSend + room management
    // ──────────────────────────────────────────────────────────────────────
    function humanDelay() { return 400 + Math.floor(Math.random() * 500); }
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));

    // ─── Outbound rate limiter ────────────────────────────────────────
    // socket.io's pipeline drops frames silently under bursts (observed:
    // 4-5 frames within ~50 ms intermittently disappear with no error
    // event). Pacing every wsSend with a minimum spacing protects the
    // hot paths: requestMarketRefresh fires HOME+DARK+SRM+USOL almost
    // simultaneously; __cor3InitialFetch fires NM + MARKET + DARK + SRM + USOL
    // within ~1.2 s; the bulk-accept loop flips set.endpoint repeatedly.
    //
    // The synchronous return value of wsSend stays true if a socket is
    // available (immediate or queued); false only when there's literally
    // no open socket. Most callers use the bool to gate retry-on-failure
    // — a queued send that later fails is rare enough to let the per-
    // module watchdogs (auto-jobs accept watchdog, etc.) catch it.
    const MIN_SEND_SPACING_MS = 200;
    let lastSendAt = 0;
    let pendingSendQueue = Promise.resolve();

    function pickOpenSocket() {
        if (activeSocket && activeSocket.readyState === OrigWebSocket.OPEN) return activeSocket;
        let best = null, bestTime = 0;
        for (const ws of trackedSockets) {
            if (ws.readyState === OrigWebSocket.OPEN) {
                const t = socketLastActivity.get(ws) || 0;
                if (t > bestTime) { bestTime = t; best = ws; }
            }
        }
        return best;
    }

    function wsSend(msg) {
        const sock = pickOpenSocket();
        if (!sock) {
            console.warn('[COR3] No active WebSocket — message not sent');
            return false;
        }
        const now = Date.now();
        const wait = Math.max(0, lastSendAt + MIN_SEND_SPACING_MS - now);
        if (wait === 0) {
            // Free pass — quiet period, send immediately.
            lastSendAt = now;
            activeSocket = sock;
            sock.send(msg);
            return true;
        }
        // Reserve our slot now so concurrent calls space behind us instead
        // of all computing the same wait==X and stacking at the same time.
        lastSendAt = now + wait;
        const reservedAt = lastSendAt;   // absolute instant THIS send should go out
        const reservedSock = sock;
        pendingSendQueue = pendingSendQueue.then(async () => {
            // Wait until our own reserved instant — NOT `wait` ms after the
            // previous queued send resolved. The closures run back-to-back, so
            // awaiting the relative `wait` each time stacked the offsets
            // quadratically (200·n(n+1)/2); a deadline keeps spacing a flat 200ms.
            const d = reservedAt - Date.now();
            if (d > 0) await delay(d);
            // Socket may have closed during the wait; fall back to any
            // other open one. If nothing is open, drop silently — caller
            // already got `true` and any module-level watchdog will
            // notice the missing response.
            const target = (reservedSock.readyState === OrigWebSocket.OPEN)
                ? reservedSock : pickOpenSocket();
            if (target) {
                activeSocket = target;
                target.send(msg);
            } else {
                console.warn('[COR3] Paced send dropped — socket closed mid-queue');
            }
        }).catch(() => {});
        return true;
    }

    // ─── Binary frame helpers (msgpack protocol) ──────────────────────
    // All RPC / room-management goes through these. wsSend accepts a
    // string (engine.io control) or an ArrayBuffer (Socket.IO frames).
    function wsSendRpc(name, action, data, opts) {
        const payload = {
            event: { name, action },
            data: data == null ? null : data,
            // cor3.gg started attaching this on every outbound; servers
            // tolerate its absence but include it to stay isomorphic to
            // what the site itself produces. Default compress:false,
            // but loadout mutations specifically ship with compress:true
            // on the real site — see __cor3LoadoutEquip*.
            options: { compress: (opts && opts.compress) || false },
        };
        return wsSend(wsFrames.encodeEventBinary('event', payload));
    }

    function jwtBearer() {
        try { return localStorage.getItem('cor3-tkey') || ''; } catch (_) { return ''; }
    }

    function wsSendJoinRoom(room) {
        return wsSend(wsFrames.encodeEventBinary('join-room', { room, jwtToken: jwtBearer() }));
    }

    function wsSendLeaveRoom(room) {
        return wsSend(wsFrames.encodeEventBinary('leave-room', { room, jwtToken: jwtBearer() }));
    }

    const joinedRooms = new Set();

    function leaveRoom(room) {
        if (!joinedRooms.has(room)) return false;
        wsSendLeaveRoom(room);
        joinedRooms.delete(room);
        return true;
    }
    function sendJoin(room) {
        wsSendJoinRoom(room);
        joinedRooms.add(room);
    }
    function leaveRoomsInOrder(rooms) {
        let chain = Promise.resolve();
        rooms.forEach((r) => { chain = chain.then(() => leaveRoom(r) ? delay(humanDelay()) : null); });
        return chain;
    }
    function joinRoomsInOrder(rooms) {
        let chain = Promise.resolve();
        rooms.forEach((r) => { chain = chain.then(() => { sendJoin(r); return delay(humanDelay()); }); });
        return chain;
    }
    function enterRooms(rooms) {
        const toLeave = rooms.slice().reverse().filter((r) => joinedRooms.has(r));
        return leaveRoomsInOrder(toLeave).then(() => joinRoomsInOrder(rooms));
    }

    // ──────────────────────────────────────────────────────────────────────
    // Outbound helpers — exposed on window.__cor3* for isolated-world callers.
    // ──────────────────────────────────────────────────────────────────────
    root.__cor3PendingMercConfigures = [];
    root.__cor3CachedMercIds = null;
    root.__cor3ExpConfigIds = null;
    root.__cor3LastMarketId = null;
    root.__cor3WebVersion = null;
    root.__cor3SystemVersion = null;
    root.__serverPathFailed = false;
    // Latest minigame launched (from minigames.start.minigame): used to size
    // waits to the game's own timerDurationMs instead of a hardcoded ceiling.
    root.__cor3LastMinigame = null;

    root.__cor3RequestExpeditions = function () {
        console.log('[COR3] Requesting expedition data');
        let gotData = false;
        const onExpData = (evt) => {
            if (evt.data && evt.data.type === MSG.WS.EXPEDITIONS) {
                gotData = true;
                window.removeEventListener('message', onExpData);
            }
        };
        window.addEventListener('message', onExpData);
        enterRooms(['expeditions']).then(() => {
            setTimeout(() => {
                window.removeEventListener('message', onExpData);
                if (!gotData) wsSendRpc('expeditions', 'get.active', {});
            }, 2000);
        });
        return true;
    };

    root.__cor3RespondDecision = function (expeditionId, messageId, selectedOption) {
        const data = { expeditionId, messageId, selectedOption };
        const sent = wsSendRpc('expeditions', 'respond.event', data);
        if (!sent) queueRetryOp('decision:' + JSON.stringify(data));
        return sent;
    };

    root.__cor3RequestArchivedExpeditions = function () {
        wsSendRpc('expeditions', 'get.archived', { cursor: null, limit: 20 });
        return true;
    };

    root.__cor3RequestMercenaries = function (marketId) {
        const mid = marketId || root.__cor3LastMarketId || '019d3ea4-85bd-7389-904d-8f7c85841134';
        wsSendRpc('expeditions', 'get.mercenaries', { marketId: mid });
        return true;
    };

    root.__cor3RequestExpeditionConfig = function () {
        wsSendRpc('expeditions', 'get.config', {});
        return true;
    };

    root.__cor3RequestMercConfigure = function (mercenaryId, marketId, locationConfigId, zoneConfigId, objectiveId) {
        const mid = marketId || root.__cor3LastMarketId || '019d3ea4-85bd-7389-904d-8f7c85841134';
        root.__cor3PendingMercConfigures.push(mercenaryId);
        const data = { mercenaryId, marketId: mid, locationConfigId, zoneConfigId, objectiveId, hasInsurance: false };
        wsSendRpc('expeditions', 'configure', data);
        return true;
    };

    root.__cor3LaunchExpedition = function (configData) {
        console.log('[COR3] Launching expedition:', configData);
        wsSendRpc('expeditions', 'configure', configData);
        setTimeout(() => {
            wsSendRpc('expeditions', 'launch', configData);
        }, humanDelay() + 500);
        return true;
    };

    root.__cor3OpenContainer = function (expeditionId) {
        wsSendRpc('expeditions', 'open.container', { expeditionId });
        return true;
    };

    root.__cor3CollectAll = function (expeditionId) {
        wsSendRpc('expeditions', 'collect.all', { expeditionId });
        return true;
    };

    // job.take requires currentEndpoint to match the market's home server,
    // exactly like get.jobs does — without the preflight the server replies
    // {error:"market-not-reachable"} (verified live: HOME endpoint + DARK
    // job.take → error; DARK endpoint + DARK job.take → status:ok).
    //
    // Accepts come in as a burst from auto-jobs's bulkAccept — pacing 1.2 s
    // apart. We serialise via inflightAcceptChain so concurrent set.endpoint
    // dances don't trample each other; same pattern as fetchRemoteMarketSequence.
    // No revert here — the orchestrator posts REVERT_ENDPOINT_TO_HOME after
    // the whole batch finishes (one set.endpoint hit instead of one per
    // accept).
    let inflightAcceptChain = Promise.resolve();
    root.__cor3AcceptJob = function (jobId, marketId) {
        // Validate up front: the debug line below calls jobId/marketId.slice and
        // would throw on a missing id — swallowed by the chain's .catch, losing
        // the accept silently. Fail loudly with a failure signal instead.
        if (!jobId || !marketId) {
            console.warn('[COR3] __cor3AcceptJob: missing jobId/marketId', { jobId, marketId });
            post('COR3_ACCEPT_JOB_SEND_FAILED', { jobId, marketId });
            return false;
        }
        inflightAcceptChain = inflightAcceptChain.then(async () => {
            const cfg = MARKET_BY_ID[marketId];
            const requiredServer = cfg ? cfg.serverId : null;
            const dbg = (m) => post(MSG.JOB.LOG, { msg: `[accept/dbg] ${m}`, level: 'debug' });
            dbg(`job ${jobId.slice(-12)} market=${cfg?.name || marketId.slice(-12)} reqServer=${requiredServer ? requiredServer.slice(-12) : '?'} cur=${currentEndpoint.slice(-12)} lock=${!!root.__pipelineLocked}`);
            if (requiredServer && currentEndpoint !== requiredServer) {
                const lockDeadline = Date.now() + 60_000;
                while (root.__pipelineLocked && Date.now() < lockDeadline) {
                    await sleep(500);
                }
                dbg(`set.endpoint(${requiredServer.slice(-12)})`);
                sendSetEndpoint(requiredServer);
                await sleep(800);
            }
            const ok = wsSendRpc('market', 'job.take', { marketId, jobId });
            dbg(`job.take sent ok=${ok}`);
            if (!ok) {
                post('COR3_ACCEPT_JOB_SEND_FAILED', { jobId, marketId });
            }
        }).catch((e) => { console.warn('[COR3] accept failed', e); });
        return true;
    };

    // market.job.complete behaves like job.take / job.dismiss: currentEndpoint
    // must match the market's home server. Sending it from HOME against a
    // DARK/SRM job comes back as {error:"market-not-reachable"}. HOME-market
    // jobs send directly; remote markets tail-queue behind inflightRemoteFetch
    // with a set.endpoint → complete → revert dance, mirroring __cor3DismissJob.
    root.__cor3CompleteJob = function (jobId, marketId) {
        const sendComplete = () => wsSendRpc('market', 'job.complete', { marketId, jobId });
        const cfg = MARKET_BY_ID[marketId];
        const requiredServer = cfg ? cfg.serverId : null;
        const dbg = (m) => post(MSG.JOB.LOG, { msg: `[complete/dbg] ${m}`, level: 'debug' });
        if (!requiredServer || requiredServer === HOME_SERVER_ID) {
            return sendComplete();
        }
        dbg(`job ${jobId.slice(-12)} market=${cfg.name} reqServer=${requiredServer.slice(-12)} cur=${currentEndpoint.slice(-12)} — flip+send+revert`);
        const run = inflightRemoteFetch.then(async () => {
            const lockDeadline = Date.now() + 60_000;
            while (root.__pipelineLocked && Date.now() < lockDeadline) {
                await sleep(500);
            }
            const saved = currentEndpoint;
            const needPreflight = (saved !== requiredServer);
            if (needPreflight) {
                dbg(`set.endpoint(${requiredServer.slice(-12)})`);
                sendSetEndpoint(requiredServer);
                await sleep(800);
            }
            sendComplete();
            await sleep(800);
            if (needPreflight && saved && saved !== requiredServer) {
                sendSetEndpoint(saved);
                await sleep(300);
            }
        }).catch((e) => { console.warn('[COR3] complete-with-endpoint failed', e); });
        inflightRemoteFetch = run;
        return true;
    };

    // Dismiss a FAILED job (`market.job.dismiss`) — clears it from the
    // user's "Active Jobs" panel. Behaves like get.jobs: the WS endpoint
    // must match the market's home server, otherwise cor3.gg replies
    // {error:"market-not-reachable"}. For HOME we send directly; for
    // remote markets we tail-queue behind inflightRemoteFetch with a
    // set.endpoint→dismiss→revert dance, mirroring fetchRemoteMarketSequence.
    root.__cor3DismissJob = function (jobId, marketId) {
        const sendDismiss = () => wsSendRpc('market', 'job.dismiss', { marketId, jobId });
        const cfg = MARKET_BY_ID[marketId];
        const requiredServer = cfg ? cfg.serverId : null;
        // HOME (or unknown market — best-effort) — endpoint already correct.
        if (!requiredServer || requiredServer === HOME_SERVER_ID) {
            return sendDismiss();
        }
        // Remote market — flip endpoint, dismiss, revert. Sequenced behind
        // inflightRemoteFetch so it can't interleave with get.jobs preflights.
        const run = inflightRemoteFetch.then(async () => {
            const lockDeadline = Date.now() + 60_000;
            while (root.__pipelineLocked && Date.now() < lockDeadline) {
                await sleep(500);
            }
            const saved = currentEndpoint;
            const needPreflight = (saved !== requiredServer);
            if (needPreflight) {
                sendSetEndpoint(requiredServer);
                await sleep(800);
            }
            sendDismiss();
            await sleep(800);
            if (needPreflight && saved && saved !== requiredServer) {
                sendSetEndpoint(saved);
                await sleep(300);
            }
        }).catch((e) => { console.warn('[COR3] dismiss-with-endpoint failed', e); });
        inflightRemoteFetch = run;
        return true;
    };

    root.__cor3RequestStash = function () {
        enterRooms(['stash']);
        return true;
    };

    root.__cor3RequestLoadout = function () {
        // join-room loadout is *meant* to make the server push a
        // loadout/get.options snapshot, but that push is unreliable when we're
        // already in the room — the server dedupes the join and never re-emits,
        // so a cold flow (user never opened the Loadout panel) waits forever.
        // Mirror __cor3RequestExpeditions: join, then if no snapshot arrives
        // shortly after, send the explicit get.options RPC the native LOADOUT
        // app uses on mount.
        let gotData = false;
        const onLoadout = (evt) => {
            if (evt.data && evt.data.type === MSG.WS.LOADOUT) {
                gotData = true;
                window.removeEventListener('message', onLoadout);
            }
        };
        window.addEventListener('message', onLoadout);
        enterRooms(['loadout']).then(() => {
            setTimeout(() => {
                window.removeEventListener('message', onLoadout);
                if (!gotData) wsSendRpc('loadout', 'get.options', {});
            }, 1500);
        });
        return true;
    };

    // ─── LOADOUT mutations ────────────────────────────────────────────
    // All three actions share the same envelope shape:
    //   { event:{name:"loadout", action:<X>}, data:{moduleConfigId} }
    // with options.compress=true (matches what cor3.gg's own UI emits;
    // server accepts either, kept true for byte-for-byte parity).
    //
    // Response is a full loadout snapshot pushed back on the same
    // "loadout" event channel — the existing eventName === 'loadout'
    // route forwards it to MSG.WS.LOADOUT, so the panel + data module
    // refresh automatically. No ack/correlation needed here.
    root.__cor3LoadoutEquipSoftware = function (moduleConfigId) {
        if (!moduleConfigId) return false;
        return wsSendRpc('loadout', 'equip.software', { moduleConfigId }, { compress: true });
    };
    root.__cor3LoadoutUnequipSoftware = function (moduleConfigId) {
        if (!moduleConfigId) return false;
        return wsSendRpc('loadout', 'unequip.software', { moduleConfigId }, { compress: true });
    };
    root.__cor3LoadoutEquipHardware = function (moduleConfigId) {
        if (!moduleConfigId) return false;
        // Same payload as software — server figures category from the id.
        return wsSendRpc('loadout', 'equip.hardware', { moduleConfigId }, { compress: true });
    };

    // ─── DESKTOP RPC ──────────────────────────────────────────────────
    // Replacements for the legacy DOM-driven path in flows/file-decryption.
    // All three reply via the existing `desktop` inbound dispatcher above
    // (MSG.WS.DESKTOP_OPTIONS / DESKTOP_FOLDER / DESKTOP_FILE).
    //
    // source:'desktop' matches what cor3.gg's own UI emits when the user
    // double-clicks a folder/file from the desktop shell. Server accepts
    // calls without `source` too, but keeping parity avoids surprises if
    // the server starts gating on it.
    root.__cor3DesktopGetOptions = function () {
        return wsSendRpc('desktop', 'get.options', {});
    };
    root.__cor3DesktopOpenFolder = function (folderId) {
        if (!folderId) return false;
        return wsSendRpc('desktop', 'open.folder', { folderId, source: 'desktop' });
    };
    root.__cor3DesktopOpenFile = function (fileId) {
        if (!fileId) return false;
        return wsSendRpc('desktop', 'open.file', { fileId, source: 'desktop' });
    };

    // ─── NETWORK-MAP RPC ──────────────────────────────────────────────
    // Direct WS equivalent of the in-game "Connect" (the Network Map panel's
    // Connect button), so callers navigate by request instead of synthesising a
    // DOM click on the SVG map. Mirrors the site's own network-map.setEndpoint:
    // it re-routes the endpoint and the response lands on the existing
    // `network-map` inbound route (which corrects currentEndpoint from
    // data.servers[?isEndpoint]); the wrapped ws.send's captureOutboundSetEndpoint
    // also observes it, so endpoint tracking stays consistent with our
    // preflight/accept dances.
    root.__cor3SetEndpoint = function (serverId) {
        if (!serverId) { console.warn('[COR3] __cor3SetEndpoint: missing serverId'); return false; }
        return wsSendRpc('network-map', 'set.endpoint', { serverId });
    };

    // ─── SAI (Server Admin Interface) RPC ─────────────────────────────
    // Granular helpers so the bridge can orchestrate the full server-access
    // flow (active-access login OR hack-the-server). Server login uses ACTIVE
    // ACCESS — a grant from a job — via sai.login.with-access {serverId,
    // accessGrantId}; the password path (sai.login.attempt) spends
    // remainingAttempts and is never used. Grant ids + hackTools come from
    // sai.get.login.status, whose reply is routed to the one-shot below
    // (pendingSaiLoginStatus, declared near the top) by the `sai` inbound
    // handler in dispatchEvent.
    //
    //   __cor3SaiGetLoginStatus(serverId)  → Promise<statusData|null>
    //       { activeAccesses:[{id,sourceType,…}], hackTools:[{moduleId,hackPower,
    //         accessTypeOnHack}], serverDefenceRate, remainingAttempts, isLocked }
    //   __cor3SaiLoginWithAccess(serverId, grantId) → bool (fires; the server's
    //       verdict comes back on the `sai` login.with-access inbound → MSG.JOB.LOG)
    //   __cor3SaiHackStart(serverId) → bool (launches the hack minigame; on WIN
    //       an access grant appears in a subsequent get.login.status)
    root.__cor3SaiGetLoginStatus = function (serverId) {
        if (!serverId) return Promise.resolve(null);
        return new Promise((resolve) => {
            let done = false;
            const finish = (data) => { if (done) return; done = true; clearTimeout(guard); delete pendingSaiLoginStatus[serverId]; resolve(data); };
            const guard = setTimeout(() => finish(null), 15000);   // no reply → resolve null
            pendingSaiLoginStatus[serverId] = finish;
            if (!wsSendRpc('sai', 'get.login.status', { serverId })) finish(null);
        });
    };
    root.__cor3SaiLoginWithAccess = function (serverId, accessGrantId) {
        if (!serverId || !accessGrantId) { console.warn('[COR3] __cor3SaiLoginWithAccess: missing serverId/accessGrantId'); return false; }
        return wsSendRpc('sai', 'login.with-access', { serverId, accessGrantId });
    };
    root.__cor3SaiHackStart = function (serverId) {
        if (!serverId) { console.warn('[COR3] __cor3SaiHackStart: missing serverId'); return false; }
        return wsSendRpc('sai', 'hack.start', { serverId });
    };

    // SAI subsystem ops (transit / files / logs) for the Auto Jobs flows.
    // Each is the WS request the in-game SAI terminal sends when you open a tab
    // or click a row — captured live (tmp_research/sai-wire-capture.md). The
    // reads' replies are relayed to MSG.WS.SAI_* (the flow awaitBus's them); the
    // mutations' verdicts land on MSG.WS.SAI_ACTION. All require the SAI session
    // to be logged in (login.with-access) on `serverId` first. Fire-and-forget
    // (return the wsSendRpc bool) — the flow reads the reply off the bus.
    root.__cor3SaiGetSummary = function (serverId) {
        if (!serverId) { console.warn('[COR3] __cor3SaiGetSummary: missing serverId'); return false; }
        return wsSendRpc('sai', 'get.summary', { serverId });
    };
    root.__cor3SaiGetTransit = function (serverId) {
        if (!serverId) { console.warn('[COR3] __cor3SaiGetTransit: missing serverId'); return false; }
        return wsSendRpc('sai', 'get.transit', { serverId });
    };
    root.__cor3SaiTransitAdd = function (serverId, ip, description, accessTimeframe) {
        if (!serverId || !ip) { console.warn('[COR3] __cor3SaiTransitAdd: missing serverId/ip'); return false; }
        return wsSendRpc('sai', 'transit.add', { serverId, ip, description: description || '', accessTimeframe: accessTimeframe || null });
    };
    root.__cor3SaiTransitRemove = function (serverId, ip) {
        if (!serverId || !ip) { console.warn('[COR3] __cor3SaiTransitRemove: missing serverId/ip'); return false; }
        return wsSendRpc('sai', 'transit.remove', { serverId, ip });
    };
    root.__cor3SaiGetFiles = function (serverId) {
        if (!serverId) { console.warn('[COR3] __cor3SaiGetFiles: missing serverId'); return false; }
        return wsSendRpc('sai', 'get.files', { serverId });
    };
    root.__cor3SaiFileDownload = function (serverId, fileId) {
        if (!serverId || !fileId) { console.warn('[COR3] __cor3SaiFileDownload: missing serverId/fileId'); return false; }
        return wsSendRpc('sai', 'file.download', { serverId, fileId });
    };
    root.__cor3SaiFileDelete = function (serverId, fileId) {
        if (!serverId || !fileId) { console.warn('[COR3] __cor3SaiFileDelete: missing serverId/fileId'); return false; }
        return wsSendRpc('sai', 'file.delete', { serverId, fileId });
    };
    root.__cor3SaiGetLogs = function (serverId) {
        if (!serverId) { console.warn('[COR3] __cor3SaiGetLogs: missing serverId'); return false; }
        return wsSendRpc('sai', 'get.logs', { serverId });
    };
    root.__cor3SaiLogDownload = function (serverId, seq) {
        if (!serverId || seq == null) { console.warn('[COR3] __cor3SaiLogDownload: missing serverId/seq'); return false; }
        return wsSendRpc('sai', 'log.download', { serverId, seq });
    };
    root.__cor3SaiLogDelete = function (serverId, seq) {
        if (!serverId || seq == null) { console.warn('[COR3] __cor3SaiLogDelete: missing serverId/seq'); return false; }
        return wsSendRpc('sai', 'log.delete', { serverId, seq });
    };
    // data_upload — push a Downloads file to the server. The
    // payload shape is the best-guess {serverId, fileId} (fileId = the player's
    // Downloads file id) — NOT yet captured live (the SAI Files tab needs a
    // LOAD/upload tool equipped). Verify live before relying on it.
    root.__cor3SaiFileUpload = function (serverId, fileId) {
        if (!serverId || !fileId) { console.warn('[COR3] __cor3SaiFileUpload: missing serverId/fileId'); return false; }
        return wsSendRpc('sai', 'file.upload', { serverId, fileId });
    };

    root.__cor3SellItem = function (itemId, quantity) {
        const qty = quantity || 1;
        wsSendRpc('stash', 'sell.item', { itemId, quantity: qty });
        setTimeout(() => root.__cor3RequestStash(), 1500);
        return true;
    };

    // Market UUIDs are static per cor3.gg deployment. Captured by inspecting
    // the WS frames the site sends when the user opens Market manually.
    const HOME_MARKET_ID = '019d3ea4-85bd-7389-904d-8f7c85841134';
    const HOME_SERVER_ID = '019c0a5b-eeeb-7d3e-b9c9-fd5c2ba7d399';
    const DARK_MARKET_ID = '019d3ea4-85bd-7389-904d-908ba9194aa0';
    const DARK_SERVER_ID = '019d29c5-4b37-79bf-b23e-304d8ea03c15';
    const SRM_MARKET_ID  = '019da731-2db5-7d76-9447-1ea3b9b78001';
    const SRM_SERVER_ID  = '019da6f1-16f7-75a6-b6d3-0b1d5f92a108';
    // URM7-M — USOL-faction public server (cluster "USOL RM7 South").
    // Captured from network-map.get.map (server.marketId + server.id).
    const USOL_MARKET_ID = '019e4065-6ae8-760d-8724-58ab4f2cf7d7';
    const USOL_SERVER_ID = '019e4052-c317-7388-9d71-883ffb1560cd';

    // Map marketId → { name (for logs), unreachable (Bus type), main (Bus type) }
    // Lets the get.jobs response handler post to the right Bus channel without
    // an if/else cascade, and lets fetchRemoteMarketSequence find the server
    // for any given marketId.
    // Values reference MSG.WS.* by KEY name (e.g. main:'MARKET' resolves at
    // dispatch time to MSG.WS.MARKET). Keeps the table compact and decoupled
    // from the actual envelope-string format.
    const MARKET_BY_ID = {
        [HOME_MARKET_ID]: { serverId: HOME_SERVER_ID, name: 'home', main: 'MARKET',      unreachable: null },
        [DARK_MARKET_ID]: { serverId: DARK_SERVER_ID, name: 'dark', main: 'DARK_MARKET', unreachable: 'DARK_MARKET_UNREACHABLE' },
        [SRM_MARKET_ID]:  { serverId: SRM_SERVER_ID,  name: 'srm',  main: 'SRM_MARKET',  unreachable: 'SRM_MARKET_UNREACHABLE' },
        [USOL_MARKET_ID]: { serverId: USOL_SERVER_ID, name: 'usol', main: 'USOL_MARKET', unreachable: 'USOL_MARKET_UNREACHABLE' },
    };

    // Tracks the user's current network-map endpoint server. Initial value is
    // HOME (the default after login). Updated by:
    //   1. captureOutboundSetEndpoint — optimistic on every set.endpoint we
    //      observe leaving the socket (ours OR cor3.gg's).
    //   2. handleWsMessage's network-map handler — corrected from
    //      data.servers[?isEndpoint==true].id when the server replies.
    // This lets fetchRemoteMarketSequence revert to whatever the user was on
    // before our preflight, instead of always slamming them back to HOME.
    let currentEndpoint = HOME_SERVER_ID;
    // Monotonic counter bumped on every CHANGE of currentEndpoint (ours OR the
    // game's; optimistic-outbound OR server-corrected). The SAI session-reuse
    // guard reads it: a remote-market refresh (auto-refresh) flips the endpoint
    // off a server and back, which tears down that server's SAI login even
    // though the endpoint mirror reads back as the same id — the epoch having
    // changed is the signal that the cached session is stale and must re-login.
    let endpointEpoch = 0;
    function setCurrentEndpoint(sid) {
        if (typeof sid !== 'string' || sid === currentEndpoint) return;
        currentEndpoint = sid;
        endpointEpoch++;
    }
    // Expose for diagnostic logging from sibling modules (server-connect dbg
    // line) + the session-reuse guard. Read-only mirrors; the lets above
    // remain the source of truth.
    Object.defineProperty(root, '__cor3CurrentEndpoint', { get: () => currentEndpoint, configurable: true });
    Object.defineProperty(root, '__cor3EndpointEpoch', { get: () => endpointEpoch, configurable: true });

    // get.jobs response carries no marketId echo, so we FIFO-attribute by
    // request order. Entries auto-expire after 30 s to prevent the queue
    // from growing if a request gets dropped. Filled by captureOutboundGetJobs
    // (called from the wrapped ws.send) — so it picks up cor3.gg's OWN
    // get.jobs requests too, not just ours, which was the source of the
    // "Home Market shows wrong job count after opening Dark/SRM in-game" bug.
    const pendingMarketJobsRequests = [];
    function pushPendingMarketJobsRequest(marketId) {
        pendingMarketJobsRequests.push({ marketId, sentAt: Date.now() });
    }
    function popPendingMarketJobsRequest() {
        const cutoff = Date.now() - 30_000;
        while (pendingMarketJobsRequests.length && pendingMarketJobsRequests[0].sentAt < cutoff) {
            pendingMarketJobsRequests.shift();
        }
        return pendingMarketJobsRequests.shift() || null;
    }

    // Decode an outbound event payload to { name, action, data } regardless
    // of wire format (text "42[...]" or msgpack binary).
    // Returns null if not a recognisable event frame. cor3.gg's own outbound
    // (e.g. when the user opens Market or clicks a Network Map server) goes
    // through the same shape, so capturing here keeps us in sync with the
    // user's manual actions.
    function decodeOutboundEvent(rawData) {
        if (typeof rawData === 'string') {
            if (rawData.length === 0 || rawData.length > 65536) return null;
            if (!rawData.startsWith('42[')) return null;
            const frame = wsFrames.parseFrame(rawData);
            if (!frame || frame.sioType !== 2 || frame.eventName !== 'event' || !frame.payload) return null;
            const p = frame.payload;
            if (!p.event) return null;
            return { name: p.event.name, action: p.event.action, data: p.data };
        }
        if (rawData instanceof ArrayBuffer || ArrayBuffer.isView(rawData)) {
            // Skip cheap guard: socket.io rarely sends > 64KB frames in
            // outbound get.jobs / set.endpoint paths.
            const byteLen = (rawData instanceof ArrayBuffer) ? rawData.byteLength : rawData.byteLength;
            if (byteLen === 0 || byteLen > 65536) return null;
            const frame = wsFrames.parseBinaryFrame(rawData);
            if (!frame || frame.sioType !== 2 || frame.eventName !== 'event' || !frame.payload) return null;
            const p = frame.payload;
            if (!p.event) return null;
            return { name: p.event.name, action: p.event.action, data: p.data };
        }
        return null;
    }

    function captureOutboundGetJobs(rawData) {
        const ev = decodeOutboundEvent(rawData);
        if (!ev || ev.name !== 'market' || ev.action !== 'get.jobs') return;
        const marketId = ev.data && ev.data.marketId;
        if (typeof marketId === 'string') pushPendingMarketJobsRequest(marketId);
    }

    // Optimistically update currentEndpoint on every observed outbound
    // set.endpoint (ours OR cor3.gg's) — the server response corrects us
    // via the data.servers parse if the request fails. Without this, our
    // preflight-revert dance for remote markets would always think the
    // user is on HOME and revert to it even if they had manually navigated.
    function captureOutboundSetEndpoint(rawData) {
        const ev = decodeOutboundEvent(rawData);
        if (!ev || ev.name !== 'network-map' || ev.action !== 'set.endpoint') return;
        const sid = ev.data && ev.data.serverId;
        setCurrentEndpoint(sid);
    }

    function sendGetJobs(marketId) {
        // Don't push the queue here — the wrapped ws.send will, via
        // captureOutboundGetJobs, on the actual transmit. Pushing here too
        // would double-count.
        return wsSendRpc('market', 'get.jobs', { marketId });
    }

    function sendSetEndpoint(serverId) {
        return wsSendRpc('network-map', 'set.endpoint', { serverId });
    }

    root.__cor3RequestNetworkMap = function () {
        // Returns the full topology { servers, connections, currentEndpointId,
        // hackTools }. Doesn't change endpoint or open any UI panel — pure
        // data fetch. Response is BFS-processed in handleWsMessage and
        // posted as MSG.GAME.NM_GRAPH.
        return wsSendRpc('network-map', 'get.map', {});
    };

    // Ensure currentEndpoint is HOME before something endpoint-sensitive
    // runs (server-connect's first click on a HOME-network server tile,
    // in particular). Tail-queues onto BOTH the accept chain and the
    // remote-market-fetch chain so any in-flight
    // set.endpoint(remote)→get.jobs→revert dance finishes before we touch
    // the endpoint — otherwise an accept-batch-done that fires a remote
    // market refresh can overlap the first flow's connect(), the server
    // sees an endpoint mid-flap, and the Connect button bounces back.
    //
    // Returns a promise that resolves once endpoint is HOME (or 5 s
    // elapsed, whichever first — best-effort).
    root.__cor3EnsureHomeEndpoint = function () {
        const run = Promise.all([inflightAcceptChain, inflightRemoteFetch]).then(async () => {
            if (currentEndpoint === HOME_SERVER_ID) return;
            sendSetEndpoint(HOME_SERVER_ID);
            // Wait for the response to flip currentEndpoint, capped at 5 s.
            const deadline = Date.now() + 5_000;
            while (currentEndpoint !== HOME_SERVER_ID && Date.now() < deadline) {
                await sleep(150);
            }
        }).catch(() => {});
        // Tail onto both chains so anything queued *after* this ensure call
        // waits for the endpoint to actually be HOME before starting its
        // own dance.
        inflightAcceptChain = run;
        inflightRemoteFetch = run;
        return run;
    };

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // Remote markets (Dark, SRM7-M) require the user's current network-map
    // endpoint to match the market's server, otherwise get.jobs replies with
    // {error:"market-not-reachable"}. We do a transient set.endpoint → get.jobs
    // → revert dance. The revert is best-effort (latest known endpoint at the
    // time the timer fires).
    //
    // Trade-off: during the ~2.5s window the user's UI shows the temporary
    // endpoint server highlighted in Network Map and may flicker hack-tools.
    // Less invasive than NOT fetching at all, which left Dark Market stuck
    // at "0 jobs" (the bug that prompted this design).
    //
    // Sequenced via a Promise chain on inflightRemoteFetch so multiple
    // concurrent calls (e.g. initial fetch + a Refresh-button click) don't
    // interleave their preflights and confuse currentEndpoint.
    let inflightRemoteFetch = Promise.resolve();
    function fetchRemoteMarketSequence(marketId, serverId) {
        const run = inflightRemoteFetch.then(async () => {
            // Don't yank the user's endpoint while a flow is mid-stride —
            // server-connect's click on RM7-E1SCP needs HOME endpoint to
            // resolve a path; if we set.endpoint(DARK_SERVER) underneath
            // it the click "succeeds" cosmetically but SAI never opens
            // and the job bugs out.
            // Cap the wait at 60 s — long enough for a normal flow to
            // finish, short enough to not leak the dance forever if
            // someone forgets to clear the lock.
            const lockDeadline = Date.now() + 60_000;
            while (root.__pipelineLocked && Date.now() < lockDeadline) {
                await sleep(500);
            }

            const saved = currentEndpoint;
            const needPreflight = (saved !== serverId);
            if (needPreflight) {
                sendSetEndpoint(serverId);
                // 800ms is empirically enough: in mcp tests the server
                // responded within ~300ms; we add slack for typical RTT.
                await sleep(800);
            }
            sendGetJobs(marketId);
            await sleep(1500);
            if (needPreflight && saved && saved !== serverId) {
                sendSetEndpoint(saved);
                await sleep(300);
            }
        }).catch((e) => { console.warn('[COR3] fetchRemoteMarketSequence failed', e); });
        inflightRemoteFetch = run;
        return run;
    }

    root.__cor3RequestMarket = function () {
        sendGetJobs(HOME_MARKET_ID);
        return true;
    };

    root.__cor3RequestDarkMarket = function () {
        fetchRemoteMarketSequence(DARK_MARKET_ID, DARK_SERVER_ID);
        return true;
    };

    root.__cor3RequestSrmMarket = function () {
        fetchRemoteMarketSequence(SRM_MARKET_ID, SRM_SERVER_ID);
        return true;
    };

    root.__cor3RequestUsolMarket = function () {
        fetchRemoteMarketSequence(USOL_MARKET_ID, USOL_SERVER_ID);
        return true;
    };

    root.__cor3RefreshMarket = root.__cor3RequestMarket;
    root.__cor3RefreshDarkMarket = root.__cor3RequestDarkMarket;
    root.__cor3RefreshSrmMarket = root.__cor3RequestSrmMarket;
    root.__cor3RefreshUsolMarket = root.__cor3RequestUsolMarket;

    let initialFetchDone = false;
    root.__cor3ResetInitialFetch = function () {
        initialFetchDone = false;
        console.log('[COR3] Reset initial fetch flag for reconnect');
    };
    root.__cor3InitialFetch = function () {
        if (initialFetchDone) return;
        initialFetchDone = true;
        console.log('[COR3] Running initial data fetch');
        post('COR3_FETCH_DAILY_OPS', null);
        root.__cor3RequestNetworkMap();      // build the depth graph (no UI side effects)
        root.__cor3RequestMarket();
        // Dark and SRM both go through inflightRemoteFetch which serialises
        // them — kicking both off back-to-back is safe; the second waits for
        // the first to finish its set.endpoint → get.jobs → revert cycle.
        // Total preflight cost: ~5s for both remote markets in the worst
        // case (currentEndpoint === HOME on startup).
        setTimeout(() => root.__cor3RequestDarkMarket(), 1000);
        setTimeout(() => root.__cor3RequestSrmMarket(),  1100);
        setTimeout(() => root.__cor3RequestUsolMarket(), 1200);
        // Expeditions / stash / archived run on plain timers; they don't
        // touch network-map and won't conflict with the remote-fetch chain.
        setTimeout(() => root.__cor3RequestExpeditions(), 6500);
        setTimeout(() => root.__cor3RequestStash(),       8500);
        setTimeout(() => root.__cor3RequestArchivedExpeditions(), 10500);
    };

    root.__cor3KeepAlive = function () { /* no-op marker */ };

    // WS readiness probes — used by solvers that need to gate UI actions
    // (e.g. Daily Ops Start/Submit) on a live socket. socket.io flaps under
    // network noise; without these gates a click can land while the server
    // hasn't seen the reconnect yet, and the action silently fails.
    root.__cor3IsWsReady = function () {
        return !!(activeSocket && activeSocket.readyState === OrigWebSocket.OPEN);
    };
    root.__cor3WaitForWs = function (timeoutMs) {
        const deadline = Date.now() + (timeoutMs || 8000);
        return new Promise((resolve) => {
            if (root.__cor3IsWsReady()) return resolve(true);
            const id = setInterval(() => {
                if (root.__cor3IsWsReady()) { clearInterval(id); resolve(true); }
                else if (Date.now() >= deadline) { clearInterval(id); resolve(false); }
            }, 200);
        });
    };

    // F12 helper for live debugging
    root.__cor3Dump = function () {
        post('COR3_REQ_DUMP', null);
        console.log('[COR3] __cor3Dump() requested — snapshot follows.');
    };
    console.log('[COR3] Type __cor3Dump() in console for an auto-jobs state snapshot.');

    // Periodic health check
    setInterval(() => {
        const now = Date.now();
        for (let i = trackedSockets.length - 1; i >= 0; i--) {
            const ws = trackedSockets[i];
            if (ws.readyState === OrigWebSocket.CLOSED || ws.readyState === OrigWebSocket.CLOSING) {
                console.log('[COR3] Cleaning dead socket');
                trackedSockets.splice(i, 1);
                socketLastActivity.delete(ws);
                if (activeSocket === ws) activeSocket = null;
            }
        }
        if (activeSocket) {
            const t = socketLastActivity.get(activeSocket) || 0;
            if (now - t > 90000) console.warn('[COR3] Active socket stale (no msgs >90s)');
        }
    }, 60000);

    // ──────────────────────────────────────────────────────────────────────
    // Listen for game-control postMessages from isolated-world modules.
    // ──────────────────────────────────────────────────────────────────────
    const handlers = {
        [MSG.GAME.REQUEST_EXPEDITIONS]: () => root.__cor3RequestExpeditions(),
        'COR3_REQUEST_STASH': () => root.__cor3RequestStash(),
        [MSG.GAME.REQUEST_LOADOUT]: () => root.__cor3RequestLoadout(),
        'COR3_REQUEST_MARKET': () => root.__cor3RequestMarket(),
        'COR3_REQUEST_DARK_MARKET': () => root.__cor3RequestDarkMarket(),
        'COR3_REQUEST_SRM_MARKET': () => root.__cor3RequestSrmMarket(),
        'COR3_REQUEST_USOL_MARKET': () => root.__cor3RequestUsolMarket(),
        [MSG.GAME.REQUEST_NM_MAP]: () => root.__cor3RequestNetworkMap(),
        [MSG.GAME.REVERT_ENDPOINT_TO_HOME]: () => {
            // Serialise behind any in-flight WS dance — both the accept
            // chain and the remote-market-fetch chain — so we don't fire
            // a revert that races a still-pending set.endpoint(remote).
            // Without the remote-fetch wait, REVERT could land while
            // fetchRemoteMarketSequence was mid-dance and ping-pong the
            // endpoint into a state where the next connect() got rejected.
            const run = Promise.all([inflightAcceptChain, inflightRemoteFetch]).then(async () => {
                if (currentEndpoint !== HOME_SERVER_ID) {
                    sendSetEndpoint(HOME_SERVER_ID);
                    await sleep(300);
                }
            }).catch(() => {});
            inflightAcceptChain = run;
            inflightRemoteFetch = run;
        },
        [MSG.GAME.REFRESH_MARKET]: () => root.__cor3RefreshMarket(),
        [MSG.GAME.REFRESH_DARK_MARKET]: () => root.__cor3RefreshDarkMarket(),
        [MSG.GAME.REFRESH_SRM_MARKET]: () => root.__cor3RefreshSrmMarket(),
        [MSG.GAME.REFRESH_USOL_MARKET]: () => root.__cor3RefreshUsolMarket(),
        'COR3_LEAVE_STASH': () => leaveRoom('stash'),
        'COR3_SELL_ITEM': (e) => root.__cor3SellItem(e.itemId, e.quantity || 1),
        [MSG.GAME.RESPOND_DECISION]: (e) => root.__cor3RespondDecision(e.expeditionId, e.messageId, e.selectedOption),
        'COR3_REQUEST_ARCHIVED_EXPEDITIONS': () => root.__cor3RequestArchivedExpeditions(),
        'COR3_REQUEST_MERCENARIES': () => root.__cor3RequestMercenaries(),
        'COR3_REQUEST_EXPEDITION_CONFIG': () => root.__cor3RequestExpeditionConfig(),
        [MSG.GAME.LAUNCH_EXPEDITION]: (e) => root.__cor3LaunchExpedition(e.config),
        'COR3_RELAUNCH_EXPEDITION': (e) => root.__cor3LaunchExpedition(e.data),
        [MSG.GAME.OPEN_CONTAINER]: (e) => root.__cor3OpenContainer(e.expeditionId),
        [MSG.GAME.COLLECT_ALL]: (e) => root.__cor3CollectAll(e.expeditionId),
        // NOTE: START_DECRYPT / STOP_DECRYPT are owned solely by solver-decrypt.js,
        // which now ref-counts owners ('user' vs 'flow'). A duplicate handler here
        // that flipped __solverAbort/__solverActive directly would bypass that
        // ref-counting and let a flow's STOP kill the user's standalone watcher.
        'COR3_KEEP_ALIVE': () => root.__cor3KeepAlive(),
        [MSG.GAME.ACCEPT_JOB]: (e) => root.__cor3AcceptJob(e.jobId, e.marketId),
        [MSG.GAME.COMPLETE_JOB]: (e) => root.__cor3CompleteJob(e.jobId, e.marketId),
        [MSG.GAME.DISMISS_JOB]: (e) => root.__cor3DismissJob(e.jobId, e.marketId),
    };
    for (const [type, fn] of Object.entries(handlers)) {
        Bus.window.on(type, fn);
    }

    console.log('[COR3] WebSocket interceptor installed');
})();
