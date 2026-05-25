// src/modules/game/network-map.js
// Owns: Network Map UI interactions in MAIN world.
//   • find server tile by name; K/D detection
//   • ensureNetworkMapOpen — opens NM tab via taskbar shortcut
//   • scrape server list and post via Bus
//   • openServerMarket — NM → server → connect → market navigation
//   • UI lock click handler — blocks NM/SAI close while pipeline / autoJobs run
// Helpers exposed on root.COR3.game.networkMap for sibling game modules.
//
// MAIN-world Module. Logger logs forward to isolated world via Bus.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Registry, dom, constants: C } = root.COR3;
    const MSG = C.MSG;

    // ─── Selectors ────────────────────────────────────────────────────────
    const SEL = {
        SERVER_ITEM: '[data-sentry-component="ServerItem"]',
        SERVER_NAME: '[data-sentry-element="ServerItemNameStyled"] span',
        SERVER_ICON: '[data-sentry-element="ServerIconStyled"]',
        MAINT_TIMER: '[data-sentry-component="MaintenanceTimer"]',
        TIMER_ICON:  '[data-sentry-component="TimerIcon"]',
        HOME_ICON:   '[data-sentry-component="HomeServerIcon"]',
        PANEL_NAME:  '[data-sentry-element="ServerNameStyled"]',
        CONNECT_BTN: '[data-sentry-component="ConnectIcon"]',
        LOGIN_BTN:   '[data-sentry-component="LoginIcon"]',
        NM_APP:      '[data-sentry-component="NetworkMapApplication"]',
        TAB_BTN:     '[data-component-name="TabBarItem-NETWORK_MAP"]',
        MARKET_ICON: '[data-sentry-component="MarketIcon"]',
        JOB_CARD:    '[data-component-name="JobCard"]',
        MARKET_NAV:  '[data-component-name="MarketNav"]',
        APPLICATION: '[data-sentry-component="Application"]',
        CLOSE_APP:   '[data-sentry-component="CloseApp"]',
        SAI_APP:     '[data-sentry-component="ServerAdministrationInterfaceApplication"]',
    };

    // ─── Helpers (exposed to sibling modules) ─────────────────────────────
    function findServerItemByName(serverName) {
        for (const item of document.querySelectorAll(SEL.SERVER_ITEM)) {
            const nameEl = item.querySelector(SEL.SERVER_NAME);
            if (nameEl && nameEl.textContent.trim() === serverName) return item;
        }
        return null;
    }

    /** @returns {{hasKD: boolean, timerText: string|null}} */
    function checkServerKD(serverItem) {
        const timer = serverItem.querySelector(SEL.MAINT_TIMER);
        if (!timer) return { hasKD: false, timerText: null };
        const icon = timer.querySelector(SEL.TIMER_ICON);
        return { hasKD: !!icon, timerText: timer.textContent.trim() };
    }

    /**
     * Walk every ServerItem; collect all servers currently on K/D except `excludeName`.
     * Used by server-unreachable detection to identify the chain blocker.
     */
    function listServersOnKD(excludeName) {
        const out = [];
        for (const item of document.querySelectorAll(SEL.SERVER_ITEM)) {
            const { hasKD, timerText } = checkServerKD(item);
            if (!hasKD) continue;
            const nameEl = item.querySelector(SEL.SERVER_NAME);
            const name = nameEl?.textContent.trim();
            if (name && name !== excludeName) out.push({ serverName: name, timerText });
        }
        return out;
    }

    async function ensureNetworkMapOpen(timeoutMs = 15_000) {
        if (document.querySelector(SEL.SERVER_ITEM)) return true;
        const tabBtn = document.querySelector(SEL.TAB_BTN);
        if (!tabBtn) {
            Bus.window.post(MSG.JOB.LOG, { msg: 'Network Map button not found in taskbar — open it manually', level: 'error' });
            return false;
        }
        tabBtn.click();
        Bus.window.post(MSG.JOB.LOG, { msg: 'Opening Network Map…', level: 'info' });
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline && !root.__jobManagerAbort) {
            if (document.querySelector(SEL.SERVER_ITEM)) return true;
            await dom.sleep(300);
        }
        Bus.window.post(MSG.JOB.LOG, { msg: 'Network Map failed to open in time', level: 'error' });
        return false;
    }

    function scrapeAndPostServers() {
        const items = document.querySelectorAll(SEL.SERVER_ITEM);
        if (items.length === 0) return;
        const names = new Set();
        for (const item of items) {
            if (item.querySelector(SEL.HOME_ICON)) continue;
            const nameEl = item.querySelector(SEL.SERVER_NAME);
            const name = nameEl ? nameEl.textContent.trim() : '';
            if (name) names.add(name);
        }
        const list = [...names].sort();
        Bus.window.post(MSG.GAME.NM_SERVERS, { servers: list });
    }

    /**
     * Navigate to NM → click server → click Connect (if needed) → click Market icon
     * → ensure Job tab is active. Returns true on success.
     * `serverName === null` ⇒ home market (first server tile in NM).
     */
    async function openServerMarket(serverName, timeoutMs = 20_000) {
        if (document.querySelector(SEL.JOB_CARD)) return true;

        const nmOk = await ensureNetworkMapOpen(Math.min(timeoutMs / 2, 12_000));
        if (!nmOk) return false;

        let item;
        if (serverName) {
            item = findServerItemByName(serverName);
            if (!item) {
                Bus.window.post(MSG.JOB.LOG, { msg: `Market: server "${serverName}" not found in NM`, level: 'error' });
                return false;
            }
        } else {
            item = document.querySelector(SEL.SERVER_ITEM);
            if (!item) return false;
        }

        const icon = item.querySelector(SEL.SERVER_ICON);
        dom.clickEl(icon || item);
        await dom.sleep(600);

        const deadline = Date.now() + timeoutMs;

        if (serverName) {
            // Prefer the onboarding-id selector; fall back to the older
            // data-sentry-component for builds that still ship it.
            const queryConnect = () =>
                document.querySelector('[data-onboarding-300-id="ServerInfoPanelConnectButton"]') ||
                document.querySelector(SEL.CONNECT_BTN);
            const connectBtn = queryConnect();
            if (connectBtn) {
                dom.clickEl(connectBtn.closest('button') || connectBtn);
                while (Date.now() < deadline && !root.__jobManagerAbort) {
                    if (!queryConnect()) break;
                    await dom.sleep(400);
                }
                await dom.sleep(500);
            }
        }

        while (Date.now() < deadline && !root.__jobManagerAbort) {
            const mktBtn = document.querySelector(SEL.MARKET_ICON)?.closest('button');
            if (mktBtn) {
                const label = serverName ? 'D4RK Market' : 'Home Market';
                Bus.window.post(MSG.JOB.LOG, { msg: `Opening ${label}…`, level: 'info' });
                mktBtn.click();
                await dom.sleep(800);
                if (!document.querySelector(SEL.JOB_CARD)) {
                    const nav = document.querySelector(SEL.MARKET_NAV);
                    const jobTabBtn = nav && nav.querySelectorAll('button')[1];
                    if (jobTabBtn) { jobTabBtn.click(); await dom.sleep(500); }
                }
                const cardDeadline = Date.now() + 8_000;
                while (Date.now() < cardDeadline && !root.__jobManagerAbort) {
                    if (document.querySelector(SEL.JOB_CARD)) return true;
                    await dom.sleep(300);
                }
                Bus.window.post(MSG.JOB.LOG, { msg: `${label} opened but no job cards visible`, level: 'warn' });
                return false;
            }
            await dom.sleep(400);
        }
        Bus.window.post(MSG.JOB.LOG, { msg: `Market button not found for ${serverName || 'home server'}`, level: 'error' });
        return false;
    }

    // ─── Module ───────────────────────────────────────────────────────────
    class NetworkMapModule extends Module {
        constructor() {
            super({
                id: 'network-map',
                name: 'Network Map',
                category: C.CATEGORY.GAME,
                owns: {
                    busTypes: [
                        MSG.GAME.OPEN_NETWORK_MAP,
                        MSG.GAME.REQUEST_NM_SERVERS,
                        MSG.GAME.OPEN_MARKET_JOBS,
                        MSG.GAME.NM_SERVERS,
                        MSG.JOB.AUTOJOBS_ACTIVE_CHANGED,
                    ],
                },
            });
        }

        async start() {
            // Bus listener for NM open/scrape/market triggers
            this.track(Bus.window.on(MSG.GAME.OPEN_NETWORK_MAP, async () => {
                this.info('open Network Map (request)');
                const ok = await ensureNetworkMapOpen();
                if (ok) {
                    await dom.sleep(400);
                    scrapeAndPostServers();
                }
            }));

            this.track(Bus.window.on(MSG.GAME.REQUEST_NM_SERVERS, async () => {
                const ok = await ensureNetworkMapOpen();
                if (!ok) return;
                await dom.sleep(400);
                scrapeAndPostServers();
            }));

            this.track(Bus.window.on(MSG.GAME.OPEN_MARKET_JOBS, async (env) => {
                const home = env.home !== false;
                const dark = env.dark !== false;
                this.info(`open markets — home=${home} dark=${dark}`);
                if (home) await openServerMarket(null, 20_000);
                if (dark) await openServerMarket('D4RK RM7MI', 20_000);
            }));

            this.track(Bus.window.on(MSG.JOB.AUTOJOBS_ACTIVE_CHANGED, (env) => {
                root.__autoJobsActive = !!env.active;
                this.info(`auto-jobs active = ${root.__autoJobsActive}`);
            }));

            // UI Lock: capture-phase click handler that blocks Close-App on
            // NetworkMapApplication / SAI while a flow runs or auto-jobs is on.
            //
            // Only acts on user-driven clicks (e.isTrusted === true). The
            // flow's own programmatic SAI cleanup (closeAllSaiTerminals) uses
            // dom.clickEl → dispatchEvent, which produces non-trusted events;
            // letting those through removes the spurious "Cannot close SAI
            // terminal — pipeline is running" warning that fired on every
            // single flow startup.
            const onClick = (e) => {
                if (!e.isTrusted) return;
                if (!root.__pipelineLocked && !root.__autoJobsActive) return;
                const closeBtn = e.target.closest(SEL.CLOSE_APP);
                if (!closeBtn) return;
                const parentApp = closeBtn.closest(SEL.APPLICATION);
                if (!parentApp) return;
                if (parentApp.querySelector(SEL.NM_APP)) {
                    if (!root.__pipelineLocked && !root.__autoJobsActive) return;
                    e.stopImmediatePropagation();
                    e.preventDefault();
                    const reason = root.__pipelineLocked ? 'pipeline running' : 'auto-jobs running';
                    Bus.window.post(MSG.JOB.LOG, { msg: `Cannot close Network Map — ${reason}`, level: 'warn' });
                } else if (parentApp.querySelector(SEL.SAI_APP)) {
                    if (!root.__pipelineLocked) return;
                    e.stopImmediatePropagation();
                    e.preventDefault();
                    Bus.window.post(MSG.JOB.LOG, { msg: 'Cannot close SAI terminal — pipeline is running', level: 'warn' });
                }
            };
            document.addEventListener('click', onClick, true);
            this.track(() => document.removeEventListener('click', onClick, true));

            this.info('network-map ready');
        }
    }

    Registry.register(new NetworkMapModule());

    // Expose helpers for sibling game modules
    root.COR3.game = root.COR3.game || {};
    root.COR3.game.networkMap = {
        SEL,
        findServerItemByName,
        checkServerKD,
        listServersOnKD,
        ensureNetworkMapOpen,
        scrapeAndPostServers,
        openServerMarket,
    };
})();
