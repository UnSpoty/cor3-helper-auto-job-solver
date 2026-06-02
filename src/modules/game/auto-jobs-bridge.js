// Auto Jobs — MAIN-world bridge for the Network Map context menu.
//
// The Network Map (popup) lets the user Open SAI / Open Market for a
// server. The request travels:
//
//   popup → (runtime) orchestrator (isolated) → (window) here (MAIN)
//
// This is the MAIN-world endpoint. It drives these flows through the game's
// own client functions and direct WS requests (no synthesised DOM clicks at
// screen coordinates):
//
//   • Open the Network Map window  → COR3.game.desktop.openAppAndWait()
//        (invokes the dock launcher's React onClick — no MouseEvent).
//   • Connect to the server        → __cor3SetEndpoint(serverId)  (WS
//        network-map.set.endpoint — the panel's "Connect" as a request).
//   • Open the SAI / Market view   → invoke the panel control's React onClick
//        (COR3.game.desktop.invokeReactClick) — no MouseEvent.
//   • Gain server access (SAI)     → saiAccess(): ACTIVE ACCESS, not the
//        password fields (__cor3SaiGetLoginStatus → __cor3SaiLoginWithAccess,
//        a task_access grant), OR — with no grant — HACK the server
//        (loadout.ensureHack installs HACK software → click the hack-tool →
//        the standalone solver wins the minigame → use the granted access).
//        No password, no login-attempt spend.
//
// The ONE residual screen interaction is selecting the server NODE on the map:
// the SVG map's selection is pointer/tap-driven with no callable handler, so
// desktop.selectServerTile() dispatches a single targeted pointer tap on the
// LOCATED tile element (its own centre, not blind coordinates). Everything else
// is a function call or a WS frame.
//
// The message carries `serverId` (the popup reads it from NM_GRAPH) — required
// for the WS connect. design rule: a missing precondition fails LOUD, never a
// silent DOM fallback.
//
// Logging: connect()/panel controls emit on the MSG.JOB.LOG channel; while a
// Auto-Jobs-initiated action runs we MIRROR those into the logger id
// ('auto-jobs') so the Activity Log shows every step.
//
// The orchestrator refuses to forward these while the loop is running, so by
// the time a message reaches this bridge the pipeline is idle.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    if (!root.COR3 || !root.COR3.constants || !root.COR3.Bus) return;
    const { Bus, dom, constants: C } = root.COR3;
    const AJ = C.MSG.AUTOJOBS;
    const MSG = C.MSG;
    const LOG_ID = 'auto-jobs';

    function desktop() { return (root.COR3.game || {}).desktop || null; }

    function log(level, msg, ctx) {
        const L = root.COR3 && root.COR3.Logger;
        if (L && typeof L.push === 'function') L.push(LOG_ID, level, msg, ctx);
        else console.log(`[aj-bridge:${level}] ${msg}`, ctx || '');
    }

    // Mirror the game's MSG.JOB.LOG entries into the Activity Log for the
    // duration of one Auto-Jobs-initiated action. Detach LATER, not immediately:
    // window.postMessage delivers async, so a helper's FINAL line is posted in
    // the same tick it returns and its message event fires after this finally.
    async function withGameLogMirror(fn) {
        const unsub = Bus.window.on(MSG.JOB.LOG, (env) => {
            if (env && env.msg) log(env.level || 'info', `· ${env.msg}`);
        });
        try {
            return await fn();
        } finally {
            setTimeout(() => { try { unsub(); } catch (_) { /* noop */ } }, 1500);
        }
    }

    // Shared navigation: open the Network Map window (client fn) and connect to
    // the server (WS). Returns true once both are done, false (logged) on any
    // failed precondition. serverName === null → HOME (no connect needed).
    async function navigateToServer(serverName, serverId, label) {
        const D = desktop();
        if (!D) { log('error', `${label} aborted — COR3.game.desktop helper not loaded`); return false; }

        // 1. Open the Network Map window via the client's own launcher.
        const nmOk = await D.openAppAndWait('NETWORK_MAP', 8000);
        if (!nmOk) { log('error', `${label} aborted — Network Map window did not mount`); return false; }
        log('debug', `${label}: Network Map window open (client fn)`);

        // 2. Select the server node on the map. NetworkMapApplication mounts a
        //    beat before its SVG tiles render, so wait for the tile to EXIST
        //    first — otherwise the select is a false-negative on a cold open.
        //    The selection itself is the one residual pointer tap (the SVG map
        //    exposes no callable selection handler).
        const tile = await D.waitFor(() => D.findServerTile(serverName), 8000);
        if (!tile) { log('error', `${label} aborted — server tile "${serverName || 'home'}" not found on the map`); return false; }
        if (!D.selectServerTile(serverName)) { log('error', `${label} aborted — could not select tile "${serverName || 'home'}"`); return false; }
        await dom.sleep(500);

        // HOME needs no connect — its endpoint is always local.
        if (!serverName) return true;

        // 3. Connect via a direct WS request (replaces the panel "Connect" click).
        if (typeof root.__cor3SetEndpoint !== 'function') { log('error', `${label} aborted — __cor3SetEndpoint WS helper missing`); return false; }
        if (!serverId) { log('error', `${label} aborted — no serverId in message (the popup must send it)`); return false; }
        const sent = root.__cor3SetEndpoint(serverId);
        if (!sent) { log('error', `${label} aborted — set.endpoint not sent (no open socket?)`); return false; }
        log('info', `${label}: Connect sent over WS (set.endpoint → "${serverName}")`);
        return true;
    }

    // Locate the Market control in the open ServerInfoPanel. HOME (and any
    // market with a labelled button) shows a full-width "Market"/"Рынок"
    // button; a remote connected market server (DARK/SRM/USOL) shows an icon-only
    // "chest" button immediately to the RIGHT of the Login control in the
    // actions row (no stable id, so we walk the row — the shape the game uses).
    // Without the icon fallback, Open Market on a remote market would never
    // find its (text-less) button.
    function findMarketControl(D) {
        const labelled = D.findPanelButton({ text: 'Market' }) || D.findPanelButton({ text: 'Рынок' });
        if (labelled) return labelled;
        const login = D.findPanelButton({ onb: 'ServerInfoPanelLoginButton' });
        if (!login) return null;
        const row = login.closest('[data-sentry-element="ActionsRowStyled"]') || login.parentElement;
        if (!row) return null;
        const btns = [...row.querySelectorAll('button')];
        for (let i = btns.indexOf(login) + 1; i < btns.length; i++) {
            if (!(btns[i].textContent || '').trim()) return btns[i];   // icon-only ⇒ chest/Market
        }
        return null;
    }

    // ── SAI server access (Active Access, or hack the server) ─────────────────
    // The minigames a hack opens are the SAME set as file-decryption; their
    // standalone solvers watch for these components.
    const MINIGAME_SELS = [
        '[data-sentry-element="LogContentStyled"][data-sentry-source-file="config-hack-application.tsx"]',
        '[data-sentry-component="IceWallBreakApplication"]',
        '[data-sentry-component="SimpleDecryptApplication"]',
        '[data-component-name="SimpleDecryptApplication"]',
    ];
    const SOLVER_START = [MSG.SOLVER.START_DECRYPT, MSG.SOLVER.START_ICE_WALL, MSG.SOLVER.START_SIMPLE_DECRYPT];
    // Driven under the 'flow' owner: all three solvers ref-count owners, so STOP
    // removes only 'flow' and leaves a user's standalone watcher (owner 'user')
    // running. We DO stop ICE WALL here: if the user has Auto ICE WALL OFF (no
    // 'user' owner), starting it for the hack must not leave it solving the
    // user's own ICE WALLs afterwards.
    const SOLVER_STOP  = [MSG.SOLVER.STOP_DECRYPT,  MSG.SOLVER.STOP_ICE_WALL, MSG.SOLVER.STOP_SIMPLE_DECRYPT];
    const startSolvers = () => { for (const m of SOLVER_START) Bus.window.post(m, { owner: 'flow' }); };
    const stopSolvers  = () => { for (const m of SOLVER_STOP)  Bus.window.post(m, { owner: 'flow' }); };
    const findMinigame = () => { for (const s of MINIGAME_SELS) { if (document.querySelector(s)) return true; } return false; };

    // Pick a usable access grant from a get.login.status snapshot: a job
    // task_access grant, else whatever grant is present (e.g. one just minted by
    // a successful hack).
    const pickSaiGrant = (s) => ((s && s.activeAccesses) || []).find((g) => g.sourceType === 'task_access') || ((s && s.activeAccesses) || [])[0] || null;

    // After a hack WIN the server writes the access grant ASYNCHRONOUSLY — a
    // single get.login.status right after the minigame closes RACES the grant and
    // misses it (that was the "hack finished but no grant" bug). So POLL until a
    // grant appears (the solver wins the minigame in the background meanwhile).
    async function pollForGrant(serverId, timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const g = pickSaiGrant(await root.__cor3SaiGetLoginStatus(serverId));
            if (g) return g;
            await dom.sleep(2000);
        }
        return null;
    }

    // Locate the clickable hack-tool row (by software name) in the open SAI
    // terminal's Hack-Tools section.
    function findHackToolRow(D, moduleName) {
        const sect = document.querySelector('[data-onboarding-300-id="SaiHackTools"]')
            || document.querySelector('[data-sentry-source-file*="hack-tools"]');
        return D.findClickableByText(sect, moduleName);
    }

    // Drive SAI server access end-to-end (the SaiLogin terminal is already open):
    //   active-access grant present → log in.
    //   no grant → hack: install HACK software if the Hack-Tools section is empty
    //   (loadout.ensureHack), click the hack tool (mounts the minigame), let the
    //   solver win, then the granted access logs us in. Password/passhack unused.
    async function saiAccess(D, serverName, serverId, serverType) {
        if (typeof root.__cor3SaiGetLoginStatus !== 'function' || typeof root.__cor3SaiLoginWithAccess !== 'function') {
            log('error', 'Open SAI — SAI WS helpers missing'); return;
        }
        await dom.sleep(600);   // let the SAI terminal mount before the status query

        let status = await root.__cor3SaiGetLoginStatus(serverId);
        if (!status) { log('error', 'Open SAI — no sai.get.login.status reply'); return; }
        let grant = pickSaiGrant(status);

        if (!grant) {
            // No Active Access → HACK the server.
            // 1. Ensure a Hack Tool exists — install HACK software if empty.
            if (!(status.hackTools && status.hackTools.length)) {
                const LO = (root.COR3.game || {}).loadout;
                if (!LO || typeof LO.ensureHack !== 'function') { log('error', 'Open SAI — COR3.game.loadout.ensureHack unavailable'); return; }
                if (!serverType) { log('error', 'Open SAI — no serverType in message (needed to pick HACK software)'); return; }
                log('info', `Open SAI → no Active Access, no Hack Tool — installing HACK software for "${serverType}"`);
                const cap = await LO.ensureHack(serverType, (lvl, m) => log(lvl, m));
                if (!cap.ok) { log('warn', `Open SAI → cannot gain hack capability for "${serverType}" (${cap.status}${cap.reason ? ': ' + cap.reason : ''})`); return; }
                status = await root.__cor3SaiGetLoginStatus(serverId);
                if (!status || !(status.hackTools && status.hackTools.length)) { log('warn', 'Open SAI → Hack Tool still absent after install'); return; }
            }
            // 2. Launch the hack: click the hack-tool row in the SAI terminal
            //    (mounts the minigame window) and run the solvers.
            const tool = status.hackTools[0];
            const toolEl = await D.waitFor(() => findHackToolRow(D, tool.moduleName), 8000);
            if (!toolEl) { log('error', `Open SAI — hack tool "${tool.moduleName}" not found in the SAI terminal`); return; }
            log('info', `Open SAI → hacking "${serverName}" with "${tool.moduleName}" (power ${tool.hackPower} vs defence ${status.serverDefenceRate})`);
            startSolvers();
            try {
                const clickAt = Date.now();
                if (!D.invokeReactClick(toolEl)) { log('error', 'Open SAI — hack tool row has no React onClick'); return; }
                // Confirm the hack minigame launched (else don't poll for a grant
                // that will never come).
                if (!(await D.waitFor(() => findMinigame(), 30000))) { log('warn', 'Open SAI → hack minigame did not appear after clicking the tool'); return; }
                // Size the grant-poll budget to the LAUNCHED minigame's OWN timer
                // (the interceptor captures timerDurationMs from
                // minigames.start.minigame) + a buffer for the async grant write —
                // each minigame type (decrypt / ICE WALL / simple) has its own
                // duration, so this is no longer a hardcoded ceiling.
                const mg = root.__cor3LastMinigame;
                let timerMs = (mg && mg.at >= clickAt - 1500 && mg.timerDurationMs) ? mg.timerDurationMs : null;
                if (!timerMs) { log('warn', 'Open SAI → could not read the hack minigame timer — using 300s'); timerMs = 300000; }
                const budget = timerMs + 15000;
                log('debug', `Open SAI → hack minigame open (timer ${Math.round(timerMs / 1000)}s) — solver running, polling for the grant`);
                // The solver wins the minigame in the background; the access grant
                // lands ASYNC after the win, so poll for it (a single immediate
                // query raced the grant and missed it — that was the bug). The poll
                // returns the instant the grant appears, well before `budget`.
                grant = await pollForGrant(serverId, budget);
                if (!grant) { log('warn', `Open SAI → hack did not grant access within ${Math.round(budget / 1000)}s (lost / timed out?)`); return; }
            } finally { stopSolvers(); }
            log('info', 'Open SAI → hack succeeded — access granted');
        }

        // Log in with the grant (Active Access — no password / passhack). The
        // server's verdict is surfaced by the `sai` inbound handler.
        if (!root.__cor3SaiLoginWithAccess(serverId, grant.id)) { log('error', 'Open SAI — login.with-access send failed'); return; }
        log('info', `Open SAI → logged in via Active Access (sai.login.with-access) for "${serverName}"`);
    }

    // ── Open SAI ────────────────────────────────────────────────────────────
    // Navigate (client fn + WS), open the SAI terminal (React onClick), then
    // gain access via saiAccess() — Active Access, or hack the server. The whole
    // body is wrapped: openApp()/invokeReactClick() can THROW (missing dock item
    // / handler), and an uncaught throw in an async Bus handler is an unhandled
    // rejection — we want a loud LOG instead.
    Bus.window.on(AJ.OPEN_SAI, async (env) => {
        const serverName = env && env.serverName;
        const serverId = env && env.serverId;
        const serverType = env && env.serverType;
        log('info', `Open SAI → "${serverName || '(none)'}"`);
        if (!serverName) { log('error', 'Open SAI aborted — no server name in message'); return; }

        try {
            await withGameLogMirror(async () => {
                const D = desktop();
                if (!(await navigateToServer(serverName, serverId, 'Open SAI'))) return;

                // Open the SAI terminal via the panel's Login/access control
                // (client fn — mounts the SaiLogin window).
                const loginBtn = await D.waitFor(() => D.findPanelButton({ onb: 'ServerInfoPanelLoginButton' }), 12000);
                if (!loginBtn) {
                    log('warn', `Open SAI → connected to "${serverName}", but the SAI/Login control never appeared (server may need access granted first)`);
                    return;
                }
                if (!D.invokeReactClick(loginBtn)) {
                    log('error', 'Open SAI — SAI/Login control has no React onClick handler');
                    return;
                }
                log('info', `Open SAI → SAI terminal open for "${serverName}"`);

                // Gain access — Active Access, or hack the server (install HACK
                // software → run the hack minigame → use the granted access).
                await saiAccess(D, serverName, serverId, serverType);
            });
        } catch (e) {
            log('error', `Open SAI threw for "${serverName}": ${(e && e.message) || e}`, { stack: e && e.stack });
        }
    });

    // ── Open Market ───────────────────────────────────────────────────────────
    // HOME: open the map, select the Home tile, click the full-width "Market".
    // Remote market server: navigate (client fn + WS connect), then click the
    // panel's Market control (text button for HOME, chest icon for DARK/SRM/USOL).
    // All control clicks are React-onClick invocations. Wrapped in try/catch for
    // the same reason as Open SAI.
    Bus.window.on(AJ.OPEN_MARKET, async (env) => {
        const serverName = (env && env.serverName) || null;   // null → HOME market
        const serverId = (env && env.serverId) || null;
        log('info', `Open Market → "${serverName || '(home)'}"`);

        try {
            await withGameLogMirror(async () => {
                const D = desktop();
                if (!(await navigateToServer(serverName, serverId, 'Open Market'))) return;
                // Remote markets need a moment after connect for the chest control
                // to appear in the panel.
                if (serverName) await dom.sleep(1000);

                const marketBtn = await D.waitFor(() => findMarketControl(D), 10000);
                if (!marketBtn) { log('warn', `Open Market → Market control not found for "${serverName || 'home'}"`); return; }
                if (!D.invokeReactClick(marketBtn)) { log('error', 'Open Market — Market control has no React onClick handler'); return; }
                log('info', `Open Market → Market opened (client fn) for "${serverName || 'home'}"`);
            });
        } catch (e) {
            log('error', `Open Market threw for "${serverName || 'home'}": ${(e && e.message) || e}`, { stack: e && e.stack });
        }
    });

    console.log('[COR3] Auto Jobs bridge installed (MAIN) — WS + client-fn navigation');
})();
