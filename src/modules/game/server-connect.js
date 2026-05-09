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
    };

    function getSaiForServer(serverName) {
        for (const app of document.querySelectorAll(SEL.SAI_APP)) {
            const title = app.querySelector(SEL.SAI_TITLE);
            if (title && title.textContent.trim() === serverName) return app;
        }
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

        // 1. locate
        const item = NM.findServerItemByName(serverName);
        if (!item) {
            Bus.window.post(MSG.JOB.LOG, { msg: `Server not found in Network Map: "${serverName}"`, level: 'error' });
            return false;
        }

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

        // wait for side panel to reflect this server
        let panelReady = false;
        for (let i = 0; i < 20 && !root.__jobManagerAbort; i++) {
            const nameEl = document.querySelector(NM.SEL.PANEL_NAME);
            if (nameEl && nameEl.textContent.trim() === serverName) { panelReady = true; break; }
            await dom.sleep(250);
        }
        if (!panelReady) {
            log('warn', `Side panel did not update for "${serverName}"`);
            return false;
        }

        // 4. click Connect — skip if Login already visible (already connected).
        // Try the new onboarding-id selector first, then fall back to the
        // legacy data-sentry-component for older builds. Same goes for Login.
        const queryConnectBtn = () => document.querySelector(SEL.CONNECT_BTN_NEW) || document.querySelector(NM.SEL.CONNECT_BTN);
        const queryLoginBtn   = () => document.querySelector(SEL.LOGIN_BTN_NEW)   || document.querySelector(NM.SEL.LOGIN_BTN);
        root.__connectStartedAt = Date.now();
        if (!queryLoginBtn()) {
            const connectBtn = await dom.waitForEl(queryConnectBtn, { timeout: 3_000 });
            if (connectBtn) {
                dom.clickEl(connectBtn.closest('button') || connectBtn);
                await dom.sleep(700);
            } else if (!queryLoginBtn()) {
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
            // SAI opened directly (auto-login)
            if (getSaiForServer(serverName)) {
                log('info', `SAI opened directly after Connect for "${serverName}"`);
                return true;
            }
            // Connect button reappeared → rejected
            if (queryConnectBtn()) {
                log('warn', `Connect button reappeared — rejected for "${serverName}"`);
                Bus.window.post(MSG.JOB.SERVER_UNREACHABLE, { serverName });
                return false;
            }
            // WS reported no-path-to-server after our connect started
            if (root.__serverPathFailed > (root.__connectStartedAt || 0)) {
                log('warn', `No path to server (WS): "${serverName}"`);
                root.__serverPathFailed = 0;
                const blockedByKD = NM.listServersOnKD(serverName);
                Bus.window.post(MSG.JOB.SERVER_UNREACHABLE, { serverName, blockedByKD });
                return false;
            }
            await dom.sleep(200);
        }
        if (!loginBtn) {
            log('warn', `Login button did not appear after Connect for "${serverName}"`);
            return false;
        }
        dom.clickEl(loginBtn.closest('button') || loginBtn);
        await dom.sleep(700);

        // 6. login method dialog → click first Active Access entry. The
        // chevron icon used to be a stable selector (ArrowRightIcon); now
        // we walk SaiPanelListStyled and click its first row. The list mounts
        // empty during the React skeleton phase, so wait for it to populate.
        const loginPanel = await dom.waitForEl(SEL.LOGIN_PANEL, { timeout: 5_000 });
        if (loginPanel) {
            const list = await dom.waitForEl(
                () => loginPanel.querySelector(`${SEL.ACTIVE_ACCESS} ${SEL.ACCESS_LIST}`),
                { timeout: 5_000 }
            );
            const firstRow = list?.firstElementChild;
            if (firstRow) {
                dom.clickEl(firstRow);
                await dom.sleep(700);
                log('info', `Clicked Active Access entry for "${serverName}"`);
            } else {
                Bus.window.post(MSG.JOB.LOG, { msg: `SAI login: no Active Access entry for "${serverName}" — solver will fail`, level: 'warn' });
            }
        }

        Bus.window.post(MSG.JOB.LOG, { msg: `Connected to server: "${serverName}"`, level: 'ok' });
        return true;
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
