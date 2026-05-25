// Owns: full Connect→Login→ActiveAccess pipeline on a target server.
// Depends on: network-map (uses SEL constants + helpers).
// Exposes: COR3.game.serverConnect.connect(serverName) — returns true on success.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Registry, dom, constants: C } = root.COR3;
    const MSG = C.MSG;
    const NM = root.COR3.game && root.COR3.game.networkMap;
    if (!NM) {
        console.error('[COR3.server-connect] network-map module must load first');
        return;
    }

    const SEL = {
        LOGIN_PANEL: '[data-sentry-element="SaiBottomPanelStyled"][data-sentry-source-file="sai-login.tsx"]',
        ACTIVE_ACCESS: '[data-sentry-component="SaiActiveAccess"]',
        // Each access row's chevron is a plain inline SVG (no
        // data-sentry-component); the list itself has stable identifiers.
        ACCESS_LIST: '[data-sentry-element="SaiPanelListStyled"]',
        SAI_APP: '[data-sentry-component="ServerAdministrationInterfaceApplication"]',
        SAI_TITLE: '[data-sentry-element="SaiHeaderTitleStyled"]',
        // Connect / Login buttons — generic Button components. Selected by
        // stable onboarding ids (data-onboarding-300-id).
        CONNECT_BTN_NEW: '[data-onboarding-300-id="ServerInfoPanelConnectButton"]',
        LOGIN_BTN_NEW:   '[data-onboarding-300-id="ServerInfoPanelLoginButton"]',
        // Empty Active Access path: the login panel renders SaiNoTools
        // instead of an empty SaiActiveAccess, with a sibling SaiHackTools
        // section listing the available hack modules (Porter-lite r4 etc.).
        // Clicking a hack-tool row opens IceWallBreakApplication, which the
        // ice-wall solver then breaks; on success cor3.gg fills in active
        // access and the normal click-first-row path takes over.
        HACK_TOOLS:    '[data-sentry-component="SaiHackTools"]',
        ICE_WALL_APP:  '[data-sentry-component="IceWallBreakApplication"]',
    };

    function getSaiForServer(serverName) {
        const apps = Array.from(document.querySelectorAll(SEL.SAI_APP));
        // Strict title match first — robust across multi-SAI scenarios.
        for (const app of apps) {
            const title = app.querySelector(SEL.SAI_TITLE);
            if (title && title.textContent.trim() === serverName) return app;
        }
        // Fallback: if exactly ONE SAI is open and we got here right after
        // findOrOpenSai's closeAllSaiTerminals + connect, the singleton has
        // to be ours. Catches the failure mode where SAI title renders late
        // (or with subtle whitespace differences) and the strict equality
        // misses it for the entire 15 s wait.
        if (apps.length === 1) return apps[0];
        return null;
    }

    // Wrapper around __cor3EnsureHomeEndpoint that adds a settle delay
    // when the endpoint actually flipped from a non-HOME server. Even
    // after the server WS-confirms set.endpoint(HOME), the session
    // machinery holds a brief "just disconnected from X" reservation —
    // the very next Connect click (within ~600 ms of the flip) bounces
    // back as "rejected" even though path-to-target is reachable. A 1 s
    // settle wait clears it.
    //
    // No-op fast path when endpoint was already HOME.
    // Diagnostic snapshot captured when a Connect attempt is rejected.
    // When a user reports "Connect btn reappeared (rejected)" 3× in a row
    // → HALT, the debug bundle should contain enough state to tell us
    // *why* the game refused (K/D, side-panel error text, item visual
    // flags, blockers on path). Cheap — single tick, no waits.
    function captureRejectSnapshot(serverName, item) {
        const snap = {};
        try {
            if (item) {
                snap.itemClasses = String(item.className || '').slice(0, 160);
                const timerNodes = item.querySelectorAll('[data-sentry-component*="Timer"], [data-sentry-component*="Maintenance"]');
                if (timerNodes.length) {
                    snap.timers = Array.from(timerNodes).map((n) => ({
                        comp: n.getAttribute('data-sentry-component'),
                        hasSvg: !!n.querySelector('svg'),
                        text: (n.textContent || '').trim().slice(0, 40),
                    }));
                }
            }
            const panelName = document.querySelector(NM.SEL.PANEL_NAME);
            const panel = panelName && (panelName.closest('aside')
                || panelName.closest('[class*="Panel"]')
                || panelName.closest('[class*="panel"]')
                || (panelName.parentElement && panelName.parentElement.parentElement));
            if (panel) {
                snap.panelText = (panel.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 280);
            }
            const describeBtn = (el) => {
                if (!el) return null;
                const btn = el.closest('button') || el;
                return {
                    text: (btn.textContent || '').trim().slice(0, 60),
                    disabled: !!btn.disabled,
                    classes: String(btn.className || '').slice(0, 120),
                    ariaLabel: btn.getAttribute('aria-label') || null,
                };
            };
            const connectBtn = document.querySelector(SEL.CONNECT_BTN_NEW) || document.querySelector(NM.SEL.CONNECT_BTN);
            const loginBtn   = document.querySelector(SEL.LOGIN_BTN_NEW)   || document.querySelector(NM.SEL.LOGIN_BTN);
            snap.connectBtn = describeBtn(connectBtn);
            snap.loginBtn   = describeBtn(loginBtn);
            // Disconnect button presence is the strongest signal that we are
            // ALREADY connected to the server (Access:Yes path). Captured by
            // text-match because cor3.gg doesn't ship a stable data-id for it.
            try {
                const allBtns = Array.from(document.querySelectorAll('button'));
                const dc = allBtns.find((b) => /disconnect/i.test((b.textContent || '').trim()) && !/all/i.test(b.textContent));
                if (dc) snap.disconnectBtn = describeBtn(dc);
            } catch (_) { /* best-effort */ }
            // Top-of-panel status block (Access / Status / IP triplet).
            if (panel) {
                const labels = panel.querySelectorAll('[class*="Label"], [class*="label"]');
                const statusPairs = [];
                Array.from(labels).slice(0, 12).forEach((l) => {
                    const k = (l.textContent || '').trim();
                    const v = (l.nextElementSibling?.textContent || '').trim();
                    if (k && v && k.length < 24 && v.length < 24) statusPairs.push(`${k}=${v}`);
                });
                if (statusPairs.length) snap.panelStatus = statusPairs.slice(0, 6).join(', ');
            }
            if (NM.checkServerKD && item) {
                const kd = NM.checkServerKD(item);
                if (kd) snap.serverKD = kd;
            }
            if (NM.listServersOnKD) {
                const blockers = NM.listServersOnKD(serverName);
                if (blockers && blockers.length) snap.kdBlockersOnPath = blockers;
            }
        } catch (e) {
            snap.snapErr = String(e && e.message || e);
        }
        return snap;
    }

    async function ensureHomeWithSettle(dbg) {
        if (typeof root.__cor3EnsureHomeEndpoint !== 'function') return;
        const before = (typeof root.__cor3CurrentEndpoint === 'string')
            ? root.__cor3CurrentEndpoint : null;
        await root.__cor3EnsureHomeEndpoint();
        const after = (typeof root.__cor3CurrentEndpoint === 'string')
            ? root.__cor3CurrentEndpoint : null;
        if (dbg) dbg(`step 0 ok — endpoint after ensureHome=${after ? after.slice(-12) : '?'}`);
        if (before && after && before !== after) {
            if (dbg) dbg(`endpoint flipped ${before.slice(-12)} → ${after.slice(-12)}, 1s settle`);
            await dom.sleep(1000);
        }
    }

    /**
     * Full connect flow with K/D + unreachable detection.
     * Returns true on success (Login submitted; SAI may or may not be open yet).
     */
    async function connect(serverName, log) {
        if (!log) log = (level, msg) => console.log(`[server-connect] ${msg}`);
        log('info', `Connecting to "${serverName}"`);
        Bus.window.post(MSG.JOB.LOG, { msg: `Connecting to server: "${serverName}"`, level: 'info' });

        // ── DEBUG helper ──────────────────────────────────────────
        // Posted at debug level so they're hidden from the default (info+)
        // logViewer filter; switch to debug+ in the Logs tab if needed for
        // future race-condition triage. Cheap and useful — no reason to remove.
        const dbg = (msg) => Bus.window.post(MSG.JOB.LOG, { msg: `[connect/dbg] ${msg}`, level: 'debug' });
        dbg(`endpoint=${(typeof root.__cor3CurrentEndpoint === 'string' ? root.__cor3CurrentEndpoint.slice(-12) : 'unknown')} pipelineLocked=${!!root.__pipelineLocked}`);

        // 0. Ensure endpoint is HOME before clicking the server tile. After
        // an accept-batch that hit DARK or SRM markets, the endpoint may
        // still be on the remote server (REVERT_ENDPOINT_TO_HOME could be
        // pending in the chain or only just dispatched). Clicking RM7-* from
        // a remote endpoint does NOT visibly fail — server tile selection
        // works, Connect/Login click through, but the active-access click
        // can't resolve a path and SAI never opens. ensureHomeEndpoint
        // tail-queues onto inflightAcceptChain + inflightRemoteFetch so any
        // in-flight WS dance settles before connect proceeds.
        await ensureHomeWithSettle(dbg);

        // 1. locate
        const item = NM.findServerItemByName(serverName);
        if (!item) {
            Bus.window.post(MSG.JOB.LOG, { msg: `Server not found in Network Map: "${serverName}"`, level: 'error' });
            return false;
        }
        dbg('step 1 ok — found server item in NM');

        // 2. K/D check
        const { hasKD, timerText } = NM.checkServerKD(item);
        if (hasKD) {
            Bus.window.post(MSG.JOB.LOG, { msg: `Server "${serverName}" has K/D timer (${timerText}) — skipping`, level: 'warn' });
            Bus.window.post(MSG.JOB.KD_DETECTED, { serverName, timerText });
            return false;
        }

        // 3-6. Run the full Connect → Login → access-row chain through
        // attemptConnectChain so we can re-do the whole thing if SAI fails
        // to open. The single-row click retry inside step 6 isn't enough
        // when cor3.gg drops the click silently — a fresh login chain
        // (re-click NM icon, re-click Connect, re-click Login, re-click
        // access row) is what actually unsticks it. Bug history: before
        // this loop, `connect()` happily reported "Connected" after 3
        // failed access-row clicks, then findOrOpenSai burned 15 s
        // waiting for an SAI that was never going to appear, the flow
        // timed out, auto-jobs retried it, and the *flow's* second
        // attempt usually succeeded — so the user paid ~30 s of dead
        // time per occurrence. Doing the reconnect here pays the same
        // cost in only one extra second.
        const MAX_FULL_ATTEMPTS = 2;
        let chainResult = { saiOpened: false, fatal: false };
        for (let attempt = 1; attempt <= MAX_FULL_ATTEMPTS; attempt++) {
            if (attempt > 1) {
                dbg(`full reconnect attempt ${attempt}/${MAX_FULL_ATTEMPTS} — re-clicking from NM icon`);
                Bus.window.post(MSG.JOB.LOG, {
                    msg: `Reconnecting to "${serverName}" (attempt ${attempt}/${MAX_FULL_ATTEMPTS}) — first SAI-open didn't take`,
                    level: 'info',
                });
                await dom.sleep(800);
            }
            chainResult = await attemptConnectChain(serverName, item, log, dbg);
            if (chainResult.saiOpened) break;
            if (chainResult.fatal) break;     // K/D, unreachable, missing buttons — retrying won't help
            if (root.__jobManagerAbort) break; // user aborted mid-flow
        }

        if (chainResult.saiOpened) {
            Bus.window.post(MSG.JOB.LOG, { msg: `Connected to server: "${serverName}"`, level: 'ok' });
            return true;
        }
        // Specific reason was already logged inside attemptConnectChain
        // (KD / unreachable / SAI-did-not-open); just translate to the
        // return value here so the caller doesn't waste 15 s in
        // findOrOpenSai's SAI-wait loop.
        Bus.window.post(MSG.JOB.LOG, { msg: `Failed to connect to "${serverName}" — SAI did not open`, level: 'warn' });
        return false;
    }

    // Execute one full Connect → Login → access-row sequence on the named
    // server. Steps 0–2 (HOME-endpoint preflight, NM lookup, K/D check)
    // are expected to have run in the caller already.
    //
    // Returns:
    //   { saiOpened: true }                 — success, SAI is open for serverName
    //   { saiOpened: false, fatal: true  }  — abort outright (K/D, unreachable,
    //                                         buttons missing): another full
    //                                         attempt won't change anything.
    //   { saiOpened: false, fatal: false }  — transient miss (SAI didn't open
    //                                         after access-row retries / login
    //                                         panel didn't mount): caller may
    //                                         retry the whole chain.
    async function attemptConnectChain(serverName, item, log, dbg) {
        // 3a. Re-ensure endpoint is HOME at the top of every attempt. The
        // first attempt's click chain may have flipped the WS endpoint to
        // the target server (after a partial login click that left the
        // session half-open), so without this the second full reconnect
        // would inherit a sticky endpoint and Connect would bounce back.
        await ensureHomeWithSettle(dbg);

        // 3. select server — click icon, wait for side panel.
        const icon = item.querySelector(NM.SEL.SERVER_ICON);
        dom.clickEl(icon || item);
        await dom.sleep(400);
        dbg('step 3 — clicked server icon');

        // Stability check: NM re-renders mid-transition can briefly show
        // the previous server's name, or stay on the new name for a single
        // tick before bouncing back. We require TWO consecutive polls to
        // read the target name before declaring the panel ready —
        // otherwise the snap can flip back ~500ms later to a different
        // server (e.g. RM7-E1L2CT when target was RM7-E1L5).
        let panelReady = false;
        let consecutiveMatches = 0;
        let lastSeenName = '(none)';
        for (let i = 0; i < 24 && !root.__jobManagerAbort; i++) {
            const nameEl = document.querySelector(NM.SEL.PANEL_NAME);
            lastSeenName = nameEl?.textContent?.trim() || '(none)';
            if (lastSeenName === serverName) {
                consecutiveMatches++;
                if (consecutiveMatches >= 2) { panelReady = true; break; }
            } else {
                if (consecutiveMatches > 0) {
                    dbg(`step 3 — panel name flipped back to "${lastSeenName}" mid-settle, restarting count`);
                }
                consecutiveMatches = 0;
            }
            await dom.sleep(200);
        }
        if (!panelReady) {
            dbg(`step 3 FAIL — side panel name "${lastSeenName}" ≠ "${serverName}" (consecMatches=${consecutiveMatches})`);
            log('warn', `Side panel did not update for "${serverName}"`);
            return { saiOpened: false, fatal: true };
        }
        dbg('step 3 ok — panel name stable on "' + serverName + '"');

        // 4. Wait for the side panel to settle into a stable, actionable state.
        //    The naïve "snapshot Login/Connect once and decide" path raced
        //    against cor3.gg's transition animation: between step 3's panel-name
        //    update and the final Connect/Login render, the panel briefly shows
        //    a disabled placeholder button (text:"", disabled:true). The old
        //    probe read that placeholder, decided "Login not visible", clicked
        //    the disabled Connect (no-op), and then step 5 saw the same
        //    disabled button still there and called it a rejection. Result:
        //    every connect to an already-connected server (Access:Yes,
        //    Disconnect+Login visible) burned 6 attempts and bugged the job.
        //
        //    The fix is to poll until one of three CLEAN states holds:
        //      A) SAI for this server is already open    → done
        //      B) Login button visible AND enabled       → skip Connect
        //      C) Connect button visible AND enabled     → click it normally
        //    Anything in between (disabled placeholders, "Connecting…" state,
        //    mid-transition DOM) is treated as transient and we keep polling.
        const queryConnectBtn = () => document.querySelector(SEL.CONNECT_BTN_NEW) || document.querySelector(NM.SEL.CONNECT_BTN);
        const queryLoginBtn   = () => document.querySelector(SEL.LOGIN_BTN_NEW)   || document.querySelector(NM.SEL.LOGIN_BTN);
        const asBtn = (el) => el && (el.closest('button') || el);
        const isClickable = (el) => {
            const b = asBtn(el);
            return !!(b && !b.disabled);
        };
        root.__connectStartedAt = Date.now();

        let stableAction = null;     // 'sai' | 'login' | 'connect' | null
        let stableLoginEl = null;
        const STABLE_TIMEOUT_MS = 5_000;
        const stableDeadline = Date.now() + STABLE_TIMEOUT_MS;
        const stableStart = Date.now();
        // Periodic state dump every ~1.2s so a stuck wait leaves breadcrumbs
        // in the log instead of just a final "no stable state" verdict.
        let lastDumpAt = 0;
        const dumpInterval = 1200;
        let pollCount = 0;
        while (Date.now() < stableDeadline && !root.__jobManagerAbort) {
            pollCount++;
            if (getSaiForServer(serverName)) { stableAction = 'sai'; break; }
            const loginEl = queryLoginBtn();
            if (isClickable(loginEl)) { stableAction = 'login'; stableLoginEl = loginEl; break; }
            const connectEl = queryConnectBtn();
            if (isClickable(connectEl)) { stableAction = 'connect'; break; }
            // Fast-fail: WS-level no-path error already came in for this attempt.
            if (root.__serverPathFailed > (root.__connectStartedAt || 0)) break;
            const now = Date.now();
            if (now - lastDumpAt >= dumpInterval) {
                lastDumpAt = now;
                const lb = asBtn(loginEl);
                const cb = asBtn(connectEl);
                dbg(`step 4 waiting (${now - stableStart}ms, polls=${pollCount}) — `
                    + `login=${lb ? `{txt:"${(lb.textContent||'').trim().slice(0,20)}",dis:${!!lb.disabled}}` : 'null'} `
                    + `connect=${cb ? `{txt:"${(cb.textContent||'').trim().slice(0,20)}",dis:${!!cb.disabled}}` : 'null'}`);
            }
            await dom.sleep(150);
        }
        dbg(`step 4 resolved — action=${stableAction || 'TIMEOUT'} after ${Date.now() - stableStart}ms, polls=${pollCount}`);

        if (stableAction === 'sai') {
            dbg('step 4 — SAI already open for this server, skipping Connect/Login');
            return { saiOpened: true };
        }
        if (stableAction === 'login') {
            dbg('step 4 — Login already actionable (already connected), skipping Connect');
        } else if (stableAction === 'connect') {
            dbg('step 4 — clicking Connect (enabled)');
            const connectEl = queryConnectBtn();
            dom.clickEl(asBtn(connectEl));
            await dom.sleep(700);
        } else {
            const snap = captureRejectSnapshot(serverName, item);
            dbg('step 4 FAIL — no stable Login/Connect/SAI in ' + STABLE_TIMEOUT_MS + 'ms snap=' + JSON.stringify(snap));
            log('warn', `Server panel did not settle into a clickable state for "${serverName}"`);
            // Not fatal: side-panel may have raced with a NM redraw; let the
            // outer chain retry from the NM icon click.
            return { saiOpened: false, fatal: false };
        }

        // 5. wait for Login or detect rejection / no-path. If step 4 already
        // resolved to Login (already-connected server), we use the cached
        // element and skip straight to the click.
        let loginBtn = stableLoginEl;
        if (!loginBtn) {
            const loginDeadline = Date.now() + 12_000;
            while (Date.now() < loginDeadline && !root.__jobManagerAbort) {
                const loginEl = queryLoginBtn();
                if (isClickable(loginEl)) { loginBtn = loginEl; break; }
                if (getSaiForServer(serverName)) {
                    dbg('step 5 — SAI opened directly');
                    log('info', `SAI opened directly after Connect for "${serverName}"`);
                    return { saiOpened: true };
                }
                // Differentiate real rejection from in-flight loading:
                //   enabled + text "Connect"  → game restored the button, true reject
                //   disabled / empty text     → still "Connecting…", keep waiting
                const connectEl = queryConnectBtn();
                const cBtn = asBtn(connectEl);
                if (cBtn && !cBtn.disabled && /connect/i.test((cBtn.textContent || '').trim())) {
                    const snap = captureRejectSnapshot(serverName, item);
                    dbg('step 5 FAIL — Connect btn restored enabled (rejected) snap=' + JSON.stringify(snap));
                    log('warn', `Connect button reappeared — rejected for "${serverName}"`);
                    Bus.window.post(MSG.JOB.SERVER_UNREACHABLE, { serverName });
                    return { saiOpened: false, fatal: true };
                }
                if (root.__serverPathFailed > (root.__connectStartedAt || 0)) {
                    const snap = captureRejectSnapshot(serverName, item);
                    dbg('step 5 FAIL — no-path-to-server WS error snap=' + JSON.stringify(snap));
                    log('warn', `No path to server (WS): "${serverName}"`);
                    root.__serverPathFailed = 0;
                    const blockedByKD = NM.listServersOnKD(serverName);
                    Bus.window.post(MSG.JOB.SERVER_UNREACHABLE, { serverName, blockedByKD });
                    return { saiOpened: false, fatal: true };
                }
                await dom.sleep(200);
            }
            if (!loginBtn) {
                dbg('step 5 FAIL — Login btn did not appear in 12s');
                log('warn', `Login button did not appear after Connect for "${serverName}"`);
                return { saiOpened: false, fatal: false };
            }
        }
        dbg('step 5 ok — clicking Login');
        dom.clickEl(asBtn(loginBtn));
        await dom.sleep(700);

        // 6. login panel — find an Active Access row OR fall back to hack-tool
        let loginPanel = await dom.waitForEl(SEL.LOGIN_PANEL, { timeout: 5_000 });
        if (!loginPanel) {
            dbg('step 6 FAIL — login panel did not mount in 5s');
            return { saiOpened: false, fatal: false };
        }
        // What's actually IN the panel? Helps when Active Access "exists"
        // but its list is in some unexpected state.
        const aaEl = loginPanel.querySelector(SEL.ACTIVE_ACCESS);
        const aaList = aaEl?.querySelector(SEL.ACCESS_LIST);
        const htEl = loginPanel.querySelector(SEL.HACK_TOOLS);
        const htList = htEl?.querySelector(SEL.ACCESS_LIST);
        dbg(`step 6 — panel mounted. ActiveAccess=${!!aaEl}/${aaList ? aaList.children.length + ' rows' : 'no list'} HackTools=${!!htEl}/${htList ? htList.children.length + ' rows' : 'no list'}`);

        let firstRow = await waitForActiveAccessRow(loginPanel, 5_000);
        if (!firstRow) {
            // Commit 3 — pt 7: probe Hack Tools BEFORE we try to use them.
            // Two outcomes feed the readiness storage:
            //   • hackTools panel absent OR empty list → server is permanently
            //     unusable for the user. Mark canAccess=false so the planner
            //     stops queueing jobs against it (and anything behind it).
            //   • hackTools present → attempt the ice-wall flow as before.
            const hackTools = loginPanel.querySelector(SEL.HACK_TOOLS);
            const hackList = hackTools && hackTools.querySelector(SEL.ACCESS_LIST);
            const hasHackTools = !!(hackList && hackList.firstElementChild);
            if (!hasHackTools) {
                Bus.window.post(MSG.JOB.SERVER_ACCESS_PROBED, {
                    serverName, canAccess: false, hasHackTools: false,
                    reason: 'no-active-access-and-no-hack-tools',
                });
                Bus.window.post(MSG.JOB.LOG, { msg: `Server "${serverName}" has no Active Access AND no Hack Tools — marking unreachable`, level: 'warn' });
                return { saiOpened: false, fatal: true };
            }
            Bus.window.post(MSG.JOB.LOG, { msg: `Server "${serverName}" has no Active Access — attempting hack-tool path`, level: 'info' });
            const hacked = await runHackToolForAccess(loginPanel, serverName, log);
            if (hacked) {
                loginPanel = document.querySelector(SEL.LOGIN_PANEL) || loginPanel;
                firstRow = await waitForActiveAccessRow(loginPanel, 8_000);
                // Hack succeeded AND access row reappeared → server is usable.
                // Refresh readiness so any previous false-mark is cleared.
                if (firstRow) {
                    Bus.window.post(MSG.JOB.SERVER_ACCESS_PROBED, {
                        serverName, canAccess: true, hasHackTools: true,
                        reason: 'hack-tool-solved',
                    });
                }
            }
        } else {
            // Active Access was present immediately — fastest "yes you can
            // use this server" probe possible. Refresh the timestamp so
            // stale negatives don't linger.
            Bus.window.post(MSG.JOB.SERVER_ACCESS_PROBED, {
                serverName, canAccess: true, hasHackTools: undefined,
                reason: 'active-access-present',
            });
        }
        if (!firstRow) {
            dbg('step 6 FAIL — no row to click after hack attempt');
            Bus.window.post(MSG.JOB.LOG, { msg: `SAI login: no Active Access entry for "${serverName}" after hack attempt — solver will fail`, level: 'warn' });
            return { saiOpened: false, fatal: false };
        }
        // Click + verify with row-level retry. cor3.gg occasionally swallows
        // the first click on a freshly-mounted access row; re-clicking the
        // same row sometimes works (handled inside clickAccessRowUntilSaiOpens),
        // but if all SAI_CLICK_MAX_ATTEMPTS misses, the caller will redo
        // the whole chain — which is what actually fixes the stuck state.
        const opened = await clickAccessRowUntilSaiOpens(loginPanel, serverName, dbg, log);
        if (opened) {
            log('info', `SAI opened for "${serverName}"`);
            return { saiOpened: true };
        }
        Bus.window.post(MSG.JOB.LOG, { msg: `SAI did not open after ${SAI_CLICK_MAX_ATTEMPTS} click attempts on "${serverName}"`, level: 'warn' });
        return { saiOpened: false, fatal: false };
    }

    // Wait up to timeoutMs for SaiActiveAccess > SaiPanelListStyled to have
    // at least one row. Returns the first row, or null on timeout.
    async function waitForActiveAccessRow(loginPanel, timeoutMs) {
        const list = await dom.waitForEl(
            () => loginPanel.querySelector(`${SEL.ACTIVE_ACCESS} ${SEL.ACCESS_LIST}`),
            { timeout: timeoutMs }
        );
        return list?.firstElementChild || null;
    }

    // ─── Active-Access click + SAI-open verification ─────────────────────
    // SAI is the success signal we actually care about; the access-row click
    // is only the means. Retry up to MAX_ATTEMPTS times if SAI doesn't appear
    // within PER_ATTEMPT_MS — the row sometimes goes "click absorbed but no
    // SAI" and re-clicking is the documented workaround.
    const SAI_CLICK_MAX_ATTEMPTS  = 3;
    const SAI_CLICK_PER_ATTEMPT_MS = 4_000;

    async function clickAccessRowUntilSaiOpens(loginPanel, serverName, dbg, log) {
        for (let attempt = 1; attempt <= SAI_CLICK_MAX_ATTEMPTS; attempt++) {
            // Re-find the row each iteration: a failed click sometimes leaves
            // the list re-rendered, and the previous reference is detached.
            const row = (loginPanel.querySelector(`${SEL.ACTIVE_ACCESS} ${SEL.ACCESS_LIST}`) || {}).firstElementChild
                     || await waitForActiveAccessRow(loginPanel, 1_500);
            if (!row) {
                dbg(`step 6.${attempt} FAIL — no access row available to click`);
                return false;
            }
            const rowText = (row.textContent || '').trim().slice(0, 60);
            dbg(`step 6.${attempt} — clicking access row "${rowText}"`);
            dom.clickEl(row);

            // Poll for SAI to appear. cor3.gg usually opens within ~700 ms;
            // we give 4 s of slack for slow clients / lag spikes before
            // declaring this attempt failed.
            const deadline = Date.now() + SAI_CLICK_PER_ATTEMPT_MS;
            while (Date.now() < deadline && !root.__jobManagerAbort) {
                const sai = getSaiForServer(serverName);
                if (sai) {
                    dbg(`step 6.${attempt} ok — SAI opened`);
                    return true;
                }
                await dom.sleep(250);
            }
            dbg(`step 6.${attempt} — SAI did not open in ${SAI_CLICK_PER_ATTEMPT_MS}ms${attempt < SAI_CLICK_MAX_ATTEMPTS ? ', retrying' : ''}`);
            // Brief grace before retrying so any in-flight click / animation
            // settles. Without this the second click can land on the same
            // mid-render row and get swallowed too.
            if (attempt < SAI_CLICK_MAX_ATTEMPTS) await dom.sleep(800);
        }
        return false;
    }

    // Click the first available hack tool, then wait for the resulting
    // IceWallBreakApplication to (a) appear and (b) close — the close edge
    // is the auto-ice-wall solver's success signal. Returns true if the
    // window cycled cleanly, false on any timeout.
    //
    // Caveat: relies on auto-ice-wall being enabled. The Auto-Jobs UI
    // already gates START on it, so by the time this runs we're in
    // a session where the solver is active.
    async function runHackToolForAccess(loginPanel, serverName, log) {
        const hackTools = loginPanel.querySelector(SEL.HACK_TOOLS);
        if (!hackTools) {
            log('warn', `No SaiHackTools panel for "${serverName}"`);
            return false;
        }
        const hackList = hackTools.querySelector(SEL.ACCESS_LIST);
        const firstTool = hackList?.firstElementChild;
        if (!firstTool) {
            log('warn', `No hack tools available for "${serverName}"`);
            return false;
        }
        const toolName = (firstTool.textContent || '').trim().split(/\s+/).slice(0, 3).join(' ');
        Bus.window.post(MSG.JOB.LOG, { msg: `Triggering hack tool "${toolName || '?'}" on "${serverName}"`, level: 'info' });
        dom.clickEl(firstTool);

        // Wait for ice-wall window to mount.
        const iceApp = await dom.waitForEl(SEL.ICE_WALL_APP, { timeout: 8_000 });
        if (!iceApp) {
            log('warn', `Ice wall window did not appear for "${serverName}"`);
            return false;
        }
        Bus.window.post(MSG.JOB.LOG, { msg: 'Ice wall opened — waiting for solver…', level: 'info' });

        // Wait for it to close. 240 s ceiling — matches cor3.gg's own
        // in-game puzzle deadline (~4 min). The solver itself usually
        // wraps in 30-60 s, but partial-board phases / virtual-list
        // re-renders / WS hiccups can stretch a round; this gives the
        // full session time to finish before we declare the slot dead.
        const deadline = Date.now() + 240_000;
        while (Date.now() < deadline && !root.__jobManagerAbort) {
            if (!document.querySelector(SEL.ICE_WALL_APP)) {
                // Grace period for the active-access list to repopulate.
                await dom.sleep(1000);
                Bus.window.post(MSG.JOB.LOG, { msg: `Ice wall solved on "${serverName}"`, level: 'ok' });
                return true;
            }
            await dom.sleep(500);
        }
        log('warn', `Ice wall did not close in 240 s for "${serverName}"`);
        Bus.window.post(MSG.JOB.LOG, { msg: `Ice wall timeout on "${serverName}" — give up`, level: 'warn' });
        return false;
    }

    // ─── Module ───────────────────────────────────────────────────────────
    class ServerConnectModule extends Module {
        constructor() {
            super({
                id: 'server-connect',
                name: 'Server Connect',
                category: C.CATEGORY.GAME,
                dependsOn: ['network-map'],
                owns: { busTypes: [MSG.JOB.KD_DETECTED, MSG.JOB.SERVER_UNREACHABLE] },
            });
        }

        async start() {
            // Track no-path-to-server timestamps for the connect step's
            // fast-fail detection.
            this.track(Bus.window.on(MSG.WS.DARK_MARKET_UNREACHABLE, () => {
                root.__serverPathFailed = Date.now();
                this.warn('WS reported no path to server');
            }));
            this.info('server-connect ready');
        }
    }

    Registry.register(new ServerConnectModule());

    // Expose helpers
    root.COR3.game = root.COR3.game || {};
    root.COR3.game.serverConnect = { connect, getSaiForServer };
})();
