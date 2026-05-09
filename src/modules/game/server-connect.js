// src/modules/game/server-connect.js
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
        // The SaiActiveAccess panel used to mark each access row's chevron
        // with data-sentry-component="ArrowRightIcon"; the May 2026 cor3.gg
        // refactor dropped the component label and now renders a plain inline
        // SVG. The list itself still has stable identifiers though.
        ACCESS_LIST: '[data-sentry-element="SaiPanelListStyled"]',
        SAI_APP: '[data-sentry-component="ServerAdministrationInterfaceApplication"]',
        SAI_TITLE: '[data-sentry-element="SaiHeaderTitleStyled"]',
        // Connect / Login buttons — generic Button components now, but the
        // game ships them with stable onboarding ids (data-onboarding-300-id).
        // Replaces the previous data-sentry-component="ConnectIcon"/"LoginIcon"
        // selectors that broke with the same refactor.
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
        // tail-queues onto inflightAcceptChain so any in-flight remote dance
        // settles before connect proceeds.
        if (typeof root.__cor3EnsureHomeEndpoint === 'function') {
            await root.__cor3EnsureHomeEndpoint();
            dbg(`step 0 ok — endpoint after ensureHome=${(typeof root.__cor3CurrentEndpoint === 'string' ? root.__cor3CurrentEndpoint.slice(-12) : '?')}`);
        }

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

        // 3. select server
        const icon = item.querySelector(NM.SEL.SERVER_ICON);
        dom.clickEl(icon || item);
        await dom.sleep(400);
        dbg('step 3 — clicked server icon');

        // wait for side panel to reflect this server
        let panelReady = false;
        for (let i = 0; i < 20 && !root.__jobManagerAbort; i++) {
            const nameEl = document.querySelector(NM.SEL.PANEL_NAME);
            if (nameEl && nameEl.textContent.trim() === serverName) { panelReady = true; break; }
            await dom.sleep(250);
        }
        if (!panelReady) {
            const nameNow = document.querySelector(NM.SEL.PANEL_NAME)?.textContent?.trim();
            dbg(`step 3 FAIL — side panel name "${nameNow || '(none)'}" ≠ "${serverName}"`);
            log('warn', `Side panel did not update for "${serverName}"`);
            return false;
        }
        dbg('step 3 ok — panel name updated');

        // 4. click Connect — skip if Login already visible (already connected).
        const queryConnectBtn = () => document.querySelector(SEL.CONNECT_BTN_NEW) || document.querySelector(NM.SEL.CONNECT_BTN);
        const queryLoginBtn   = () => document.querySelector(SEL.LOGIN_BTN_NEW)   || document.querySelector(NM.SEL.LOGIN_BTN);
        root.__connectStartedAt = Date.now();
        const loginAlreadyShown = !!queryLoginBtn();
        dbg(`step 4 — login already visible? ${loginAlreadyShown}`);
        if (!loginAlreadyShown) {
            const connectBtn = await dom.waitForEl(queryConnectBtn, { timeout: 3_000 });
            if (connectBtn) {
                dbg('step 4 — clicking Connect');
                dom.clickEl(connectBtn.closest('button') || connectBtn);
                await dom.sleep(700);
            } else if (!queryLoginBtn()) {
                dbg('step 4 FAIL — Connect btn not found, Login also missing');
                log('warn', `Connect button not found for "${serverName}"`);
                return false;
            }
        }

        // 5. wait for Login or detect rejection / no-path
        let loginBtn = null;
        const loginDeadline = Date.now() + 12_000;
        while (Date.now() < loginDeadline && !root.__jobManagerAbort) {
            loginBtn = queryLoginBtn();
            if (loginBtn) break;
            if (getSaiForServer(serverName)) {
                dbg('step 5 — SAI opened directly');
                log('info', `SAI opened directly after Connect for "${serverName}"`);
                return true;
            }
            if (queryConnectBtn()) {
                dbg('step 5 FAIL — Connect btn reappeared (rejected)');
                log('warn', `Connect button reappeared — rejected for "${serverName}"`);
                Bus.window.post(MSG.JOB.SERVER_UNREACHABLE, { serverName });
                return false;
            }
            if (root.__serverPathFailed > (root.__connectStartedAt || 0)) {
                dbg('step 5 FAIL — no-path-to-server WS error');
                log('warn', `No path to server (WS): "${serverName}"`);
                root.__serverPathFailed = 0;
                const blockedByKD = NM.listServersOnKD(serverName);
                Bus.window.post(MSG.JOB.SERVER_UNREACHABLE, { serverName, blockedByKD });
                return false;
            }
            await dom.sleep(200);
        }
        if (!loginBtn) {
            dbg('step 5 FAIL — Login btn did not appear in 12s');
            log('warn', `Login button did not appear after Connect for "${serverName}"`);
            return false;
        }
        dbg('step 5 ok — clicking Login');
        dom.clickEl(loginBtn.closest('button') || loginBtn);
        await dom.sleep(700);

        // 6. login panel — find an Active Access row OR fall back to hack-tool
        let loginPanel = await dom.waitForEl(SEL.LOGIN_PANEL, { timeout: 5_000 });
        if (!loginPanel) {
            dbg('step 6 FAIL — login panel did not mount in 5s');
        } else {
            // What's actually IN the panel? Helps when Active Access "exists"
            // but its list is in some unexpected state.
            const aaEl = loginPanel.querySelector(SEL.ACTIVE_ACCESS);
            const aaList = aaEl?.querySelector(SEL.ACCESS_LIST);
            const htEl = loginPanel.querySelector(SEL.HACK_TOOLS);
            const htList = htEl?.querySelector(SEL.ACCESS_LIST);
            dbg(`step 6 — panel mounted. ActiveAccess=${!!aaEl}/${aaList ? aaList.children.length + ' rows' : 'no list'} HackTools=${!!htEl}/${htList ? htList.children.length + ' rows' : 'no list'}`);

            let firstRow = await waitForActiveAccessRow(loginPanel, 5_000);
            if (!firstRow) {
                Bus.window.post(MSG.JOB.LOG, { msg: `Server "${serverName}" has no Active Access — attempting hack-tool path`, level: 'info' });
                const hacked = await runHackToolForAccess(loginPanel, serverName, log);
                if (hacked) {
                    loginPanel = document.querySelector(SEL.LOGIN_PANEL) || loginPanel;
                    firstRow = await waitForActiveAccessRow(loginPanel, 8_000);
                }
            }
            if (firstRow) {
                const rowText = (firstRow.textContent || '').trim().slice(0, 60);
                const rowAttached = !!firstRow.isConnected;
                dbg(`step 6 — clicking access row "${rowText}" attached=${rowAttached}`);
                dom.clickEl(firstRow);
                await dom.sleep(700);

                // Post-click probe: did anything appear?
                const apps = Array.from(document.querySelectorAll(SEL.SAI_APP));
                const titles = apps.map(a => `"${a.querySelector(SEL.SAI_TITLE)?.textContent?.trim() || ''}"`);
                dbg(`step 6 post-click — SAI apps now: ${apps.length === 0 ? 'none' : titles.join(', ')}`);

                log('info', `Clicked Active Access entry for "${serverName}"`);
            } else {
                dbg('step 6 FAIL — no row to click after hack attempt');
                Bus.window.post(MSG.JOB.LOG, { msg: `SAI login: no Active Access entry for "${serverName}" after hack attempt — solver will fail`, level: 'warn' });
            }
        }

        Bus.window.post(MSG.JOB.LOG, { msg: `Connected to server: "${serverName}"`, level: 'ok' });
        return true;
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
            // Mirror legacy behavior: track no-path-to-server timestamps for
            // the connect step's fast-fail detection.
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
