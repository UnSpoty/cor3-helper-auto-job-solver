// src/interceptors/ws-interceptor.js
// MAIN-world WebSocket interceptor. Replaces the legacy content-early.js
// WS handling. Responsibilities:
//   • Wrap window.WebSocket so all cor3/corie connections are tracked.
//   • Parse Socket.IO v4 frames via COR3.wsFrames.
//   • Translate inbound game events to typed Bus messages (MSG.WS.*).
//   • Provide all window.__cor3* outbound helpers used by legacy
//     job-manager.js / content.js / decrypt-solver.js / daily-hack-solver.js.
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
                else if (op === 'stash') root.__cor3RequestStash();
                else if (op === 'dailyOps') post('COR3_FETCH_DAILY_OPS', null);
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

                ws.addEventListener('message', (event) => {
                    try {
                        if (activeSocket !== ws) {
                            console.debug('[COR3] Active socket changed to:', ws.__cor3Url);
                            activeSocket = ws;
                        }
                        socketLastActivity.set(ws, Date.now());
                        handleWsMessage(event.data, ws);
                    } catch (_) { /* silent */ }
                });

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
    // Inbound message dispatch
    // ──────────────────────────────────────────────────────────────────────
    function handleWsMessage(rawData, _socket) {
        if (typeof rawData !== 'string') return;
        if (!wsFrames.isEventFrame(rawData)) return;

        const frame = wsFrames.parseFrame(rawData);
        if (!frame || frame.eventName === null) return;
        const eventName = frame.eventName;
        const payload = frame.payload;

        // Token-expired → close all sockets, queue retries
        if (eventName === 'error' && payload && payload.message === 'token-expired') {
            console.log('[COR3] Token expired — closing sockets to force reconnect');
            tokenExpiredFlag = true;
            ['expeditions', 'market', 'darkMarket', 'stash', 'dailyOps'].forEach(queueRetryOp);
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
                    // Legacy content.js listens on COR3_WS_STASH_FULL; not in MSG enum, send raw
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
                // Archived feature dropped for new UI; legacy popup may still display it.
                // We pass through so legacy content.js can still write the storage key.
                post('COR3_WS_ARCHIVED_EXPEDITIONS', { data: payload.data });
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
            // gone. We attribute the response to home/dark by FIFO-popping
            // our pending-request queue (responses come in send-order on
            // the same socket).
            if (action === 'get.jobs' && payload.data) {
                const pending = popPendingMarketJobsRequest();
                const marketId = pending?.marketId;
                const out = {
                    marketId,
                    jobs: Array.isArray(payload.data.jobs) ? payload.data.jobs : [],
                    recentJobs: Array.isArray(payload.data.recentJobs) ? payload.data.recentJobs : [],
                    nextJobsResetAt: payload.data.nextJobsResetAt || null,
                };
                if (marketId === DARK_MARKET_ID) {
                    post(MSG.WS.DARK_MARKET, { market: out });
                } else {
                    post(MSG.WS.MARKET, { market: out });
                    root.__cor3LastMarketId = marketId || HOME_MARKET_ID;
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

        // network-map: set.endpoint result and dark-market unreachable detection
        if (eventName === 'network-map' && payload && payload.event) {
            if (payload.event.action === 'set.endpoint') {
                if (payload.error && payload.error.message === 'no-path-to-server') {
                    console.log('[COR3] Dark market unreachable: no-path-to-server');
                    post(MSG.WS.DARK_MARKET_UNREACHABLE, {
                        error: payload.error.message,
                        serverId: payload.error.serverId,
                    });
                    // Solvers watch this flag for connection rejection detection
                    root.__serverPathFailed = true;
                    setTimeout(() => { root.__serverPathFailed = false; }, 5000);
                } else {
                    // Legacy event for endpoint result; keep raw type
                    post('COR3_WS_ENDPOINT_RESULT', { success: !payload.error, data: payload.data });
                }
            }
            return;
        }
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

    function wsSend(msg) {
        if (activeSocket && activeSocket.readyState === OrigWebSocket.OPEN) {
            activeSocket.send(msg);
            return true;
        }
        let bestSocket = null;
        let bestTime = 0;
        for (const ws of trackedSockets) {
            if (ws.readyState === OrigWebSocket.OPEN) {
                const t = socketLastActivity.get(ws) || 0;
                if (t > bestTime) { bestTime = t; bestSocket = ws; }
            }
        }
        if (bestSocket) {
            activeSocket = bestSocket;
            bestSocket.send(msg);
            return true;
        }
        console.warn('[COR3] No active WebSocket — message not sent');
        return false;
    }

    const joinedRooms = new Set();
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));

    function leaveRoom(room) {
        if (!joinedRooms.has(room)) return false;
        wsSend('42["leave-room",{"room":"' + room + '"}]');
        joinedRooms.delete(room);
        return true;
    }
    function sendJoin(room) {
        wsSend('42["join-room",{"room":"' + room + '"}]');
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
    // Outbound helpers — preserved as window.__cor3* for legacy job-manager.js,
    // legacy content.js, decrypt/daily-hack solvers.
    // ──────────────────────────────────────────────────────────────────────
    root.__cor3PendingMercConfigures = [];
    root.__cor3CachedMercIds = null;
    root.__cor3ExpConfigIds = null;
    root.__cor3LastMarketId = null;
    root.__cor3WebVersion = null;
    root.__cor3SystemVersion = null;
    root.__serverPathFailed = false;

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
                if (!gotData) wsSend('42["event",{"event":{"name":"expeditions","action":"get.active"}}]');
            }, 2000);
        });
        return true;
    };

    root.__cor3RespondDecision = function (expeditionId, messageId, selectedOption) {
        const payload = JSON.stringify({ expeditionId, messageId, selectedOption });
        const sent = wsSend('42["event",{"event":{"name":"expeditions","action":"respond.event"},"data":' + payload + '}]');
        if (!sent) queueRetryOp('decision:' + payload);
        return sent;
    };

    root.__cor3RequestArchivedExpeditions = function () {
        wsSend('42["event",{"event":{"name":"expeditions","action":"get.archived"},"data":{"cursor":null,"limit":20}}]');
        return true;
    };

    root.__cor3RequestMercenaries = function (marketId) {
        const mid = marketId || root.__cor3LastMarketId || '019d3ea4-85bd-7389-904d-8f7c85841134';
        wsSend('42["event",{"event":{"name":"expeditions","action":"get.mercenaries"},"data":{"marketId":"' + mid + '"}}]');
        return true;
    };

    root.__cor3RequestExpeditionConfig = function () {
        wsSend('42["event",{"event":{"name":"expeditions","action":"get.config"}}]');
        return true;
    };

    root.__cor3RequestMercConfigure = function (mercenaryId, marketId, locationConfigId, zoneConfigId, objectiveId) {
        const mid = marketId || root.__cor3LastMarketId || '019d3ea4-85bd-7389-904d-8f7c85841134';
        root.__cor3PendingMercConfigures.push(mercenaryId);
        const data = { mercenaryId, marketId: mid, locationConfigId, zoneConfigId, objectiveId, hasInsurance: false };
        wsSend('42["event",{"event":{"name":"expeditions","action":"configure"},"data":' + JSON.stringify(data) + '}]');
        return true;
    };

    root.__cor3LaunchExpedition = function (configData) {
        console.log('[COR3] Launching expedition:', configData);
        wsSend('42["event",{"event":{"name":"expeditions","action":"configure"},"data":' + JSON.stringify(configData) + '}]');
        setTimeout(() => {
            wsSend('42["event",{"event":{"name":"expeditions","action":"launch"},"data":' + JSON.stringify(configData) + '}]');
        }, humanDelay() + 500);
        return true;
    };

    root.__cor3OpenContainer = function (expeditionId) {
        wsSend('42["event",{"event":{"name":"expeditions","action":"open.container"},"data":{"expeditionId":"' + expeditionId + '"}}]');
        return true;
    };

    root.__cor3CollectAll = function (expeditionId) {
        wsSend('42["event",{"event":{"name":"expeditions","action":"collect.all"},"data":{"expeditionId":"' + expeditionId + '"}}]');
        return true;
    };

    root.__cor3AcceptJob = function (jobId, marketId) {
        const data = JSON.stringify({ marketId, jobId });
        const ok = wsSend('42["event",{"event":{"name":"market","action":"job.take"},"data":' + data + '}]');
        if (!ok) {
            // Legacy event watched by content.js bulk-accept watchdog; not in MSG enum
            post('COR3_ACCEPT_JOB_SEND_FAILED', { jobId, marketId });
        }
        return ok;
    };

    root.__cor3CompleteJob = function (jobId, marketId) {
        const data = JSON.stringify({ marketId, jobId });
        return wsSend('42["event",{"event":{"name":"market","action":"job.complete"},"data":' + data + '}]');
    };

    root.__cor3RequestStash = function () {
        enterRooms(['stash']);
        return true;
    };

    root.__cor3SellItem = function (itemId, quantity) {
        const qty = quantity || 1;
        wsSend('42["event",{"event":{"name":"stash","action":"sell.item"},"data":{"itemId":"' + itemId + '","quantity":' + qty + '}}]');
        setTimeout(() => root.__cor3RequestStash(), 1500);
        return true;
    };

    // Market UUIDs are static per cor3.gg deployment. Captured by inspecting
    // the WS frames the site sends when the user opens Market manually.
    const HOME_MARKET_ID = '019d3ea4-85bd-7389-904d-8f7c85841134';
    const DARK_MARKET_ID = '019d3ea4-85bd-7389-904d-908ba9194aa0';
    const DARK_SERVER_ID = '019d29c5-4b37-79bf-b23e-304d8ea03c15';

    // get.jobs response carries no marketId echo, so we FIFO-attribute by
    // request order. Entries auto-expire after 30 s to prevent the queue
    // from growing if a request gets dropped.
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

    function sendGetJobs(marketId) {
        pushPendingMarketJobsRequest(marketId);
        return wsSend('42["event",{"event":{"name":"market","action":"get.jobs"},"data":{"marketId":"' + marketId + '"}}]');
    }

    root.__cor3RequestMarket = function () {
        sendGetJobs(HOME_MARKET_ID);
        return true;
    };

    root.__cor3RequestDarkMarket = function () {
        // Direct get.jobs with the dark marketId is enough — the server
        // looks up by marketId regardless of current endpoint. The legacy
        // network-map.set.endpoint preflight is gone: it added 1500ms of
        // delay and could falsely trip darkMarketAvailable=false via
        // no-path-to-server when the user wasn't manually connected to
        // the dark server (verified by inspecting cor3.gg's own client —
        // it sends nothing but join-room + get.{options,lots,jobs}).
        sendGetJobs(DARK_MARKET_ID);
        return true;
    };

    root.__cor3RefreshMarket = root.__cor3RequestMarket;
    root.__cor3RefreshDarkMarket = root.__cor3RequestDarkMarket;

    let initialFetchDone = false;
    root.__cor3ResetInitialFetch = function () {
        initialFetchDone = false;
        console.log('[COR3] Reset initial fetch flag for reconnect');
    };
    root.__cor3InitialFetch = function () {
        if (initialFetchDone) return;
        initialFetchDone = true;
        console.log('[COR3] Running initial data fetch');
        post('COR3_FETCH_DAILY_OPS', null); // legacy daily-ops fetch trigger
        root.__cor3RequestMarket();
        setTimeout(() => root.__cor3RequestDarkMarket(), 1000);
        setTimeout(() => root.__cor3RequestExpeditions(), 2000);
        setTimeout(() => root.__cor3RequestStash(), 6000);
        setTimeout(() => root.__cor3RequestArchivedExpeditions(), 8000);
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
    // Listen for game-control postMessages from isolated content script
    // (legacy content.js + future modules use these to drive WS sends).
    // ──────────────────────────────────────────────────────────────────────
    const handlers = {
        [MSG.GAME.REQUEST_EXPEDITIONS]: () => root.__cor3RequestExpeditions(),
        'COR3_REQUEST_STASH': () => root.__cor3RequestStash(),
        'COR3_REQUEST_MARKET': () => root.__cor3RequestMarket(),
        'COR3_REQUEST_DARK_MARKET': () => root.__cor3RequestDarkMarket(),
        [MSG.GAME.REFRESH_MARKET]: () => root.__cor3RefreshMarket(),
        [MSG.GAME.REFRESH_DARK_MARKET]: () => root.__cor3RefreshDarkMarket(),
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
        [MSG.SOLVER.STOP_DECRYPT]: () => { root.__solverAbort = true; },
        [MSG.SOLVER.STOP_DAILY_HACK]: () => { root.__dailyHackAbort = true; root.__dailyHackActive = false; },
        [MSG.SOLVER.START_DECRYPT]: () => {
            if (root.__solverActive && !root.__solverAbort) return;
            root.__solverAbort = false;
            root.__solverActive = false;
        },
        'COR3_KEEP_ALIVE': () => root.__cor3KeepAlive(),
        [MSG.GAME.ACCEPT_JOB]: (e) => root.__cor3AcceptJob(e.jobId, e.marketId),
        'COR3_COMPLETE_JOB': (e) => root.__cor3CompleteJob(e.jobId, e.marketId),
    };
    for (const [type, fn] of Object.entries(handlers)) {
        Bus.window.on(type, fn);
    }

    console.log('[COR3] WebSocket interceptor installed (modular)');
})();
