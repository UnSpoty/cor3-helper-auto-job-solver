// Auto-Jobs v2 — MAIN-world bridge for the Network Map context menu.
//
// The v2 Network Map (popup) lets the user Open SAI / Open Market for a
// server. Those are in-game DOM actions, so the request travels:
//
//   popup → (runtime) v2 orchestrator (isolated) → (window) here (MAIN)
//
// This file is the MAIN-world endpoint. It does NOT reimplement navigation —
// it drives the generic game helpers already exposed by the v1 game modules
// (networkMap.ensureNetworkMapOpen / serverConnect.connect /
// networkMap.openServerMarket). That keeps v2 from duplicating v1 logic while
// reusing the shared game plumbing.
//
// Open SAI preconditions handled here:
//   • Network Map must be open — we open it first (connect() assumes it's open).
//   • Active Access / Hack-tool fallback / server-access — handled INSIDE
//     connect()'s chain; we surface its progress (see the log mirror below).
//   • HOME has no SAI terminal — the popup never offers Open SAI for HOME, so
//     it never reaches here.
//
// Logging: connect()/openServerMarket() only emit via MSG.JOB.LOG (the v1
// channel), which never shows up in the v2 Activity Log. While a v2-initiated
// action runs we MIRROR those entries into the v2 logger id ('auto-jobs-v2'),
// plus log each step ourselves — so the v2 tab shows exactly what happened.
//
// The orchestrator refuses to forward these while the v2 loop is running, so
// by the time a message reaches this bridge the pipeline is idle.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    if (!root.COR3 || !root.COR3.constants || !root.COR3.Bus) return;
    const { Bus, constants: C } = root.COR3;
    const AJV2 = C.MSG.AUTOJOBS_V2;
    const MSG = C.MSG;
    const LOG_ID = 'auto-jobs-v2';

    function game() { return root.COR3.game || {}; }

    function log(level, msg, ctx) {
        const L = root.COR3 && root.COR3.Logger;
        if (L && typeof L.push === 'function') L.push(LOG_ID, level, msg, ctx);
        else console.log(`[ajv2-bridge:${level}] ${msg}`, ctx || '');
    }

    // Mirror the game modules' MSG.JOB.LOG entries into the v2 Activity Log
    // for the duration of one v2-initiated action — connect()/openServerMarket
    // log only on that (v1) channel, so this is the only way their step-by-step
    // diagnostics surface in the v2 tab.
    async function withGameLogMirror(fn) {
        const unsub = Bus.window.on(MSG.JOB.LOG, (env) => {
            if (env && env.msg) log(env.level || 'info', `· ${env.msg}`);
        });
        try {
            return await fn();
        } finally {
            // Detach LATER, not now: window.postMessage delivers async, so the
            // helper's FINAL line (e.g. "Market button not found…") is posted
            // in the same tick it returns and its message event fires after
            // this finally runs. Unsubscribing immediately drops it — which is
            // exactly why the failure reason was missing from the log.
            setTimeout(() => { try { unsub(); } catch (_) { /* noop */ } }, 1500);
        }
    }

    // Snapshot the relevant DOM at a failure point so we can see WHY a button
    // wasn't found (does it exist at all? which tiles/panels are present?).
    // Uses the selectors the game module already publishes.
    function dumpDom(tag) {
        const NM = game().networkMap;
        const SEL = (NM && NM.SEL) || {};
        const n = (sel) => { try { return sel ? document.querySelectorAll(sel).length : '?'; } catch (_) { return 'err'; } };
        let homeTile = false;
        try {
            const items = document.querySelectorAll(SEL.SERVER_ITEM || '[data-sentry-component="ServerItem"]');
            for (const it of items) {
                if (it.querySelector(SEL.HOME_ICON || '[data-sentry-component="HomeServerIcon"]')) { homeTile = true; break; }
            }
        } catch (_) { /* noop */ }
        log('info', `DOM @ ${tag}: serverItems=${n(SEL.SERVER_ITEM)} homeTilePresent=${homeTile} `
            + `marketIcon=${n(SEL.MARKET_ICON)} jobCard=${n(SEL.JOB_CARD)} marketNav=${n(SEL.MARKET_NAV)} `
            + `nmApp=${n(SEL.NM_APP)} saiApp=${n(SEL.SAI_APP)}`);
    }

    // The market-button selectors are clearly stale (marketIcon=0). Probe the
    // live DOM for the CURRENT identifiers so we can rewrite them precisely:
    //   • every data-onboarding-300-id present (Connect already uses this
    //     scheme: "ServerInfoPanelConnectButton" — the market one is likely a
    //     sibling), and
    //   • any attribute value mentioning "market".
    function marketProbe() {
        try {
            const ids = new Set();
            for (const el of document.querySelectorAll('[data-onboarding-300-id]')) {
                ids.add(el.getAttribute('data-onboarding-300-id'));
                if (ids.size >= 40) break;
            }
            const marketAttrs = new Set();
            const wanted = /^(data-sentry-component|data-sentry-element|data-component-name|data-onboarding-300-id|aria-label|title)$/i;
            for (const el of document.querySelectorAll('*')) {
                for (const a of el.attributes) {
                    if (wanted.test(a.name) && /market/i.test(a.value)) marketAttrs.add(`${a.name}="${a.value}"`);
                }
                if (marketAttrs.size >= 20) break;
            }
            log('info', `onboarding-300-ids present: ${[...ids].join(', ') || '(none)'}`);
            log('info', `attrs mentioning "market": ${[...marketAttrs].join(' | ') || '(none)'}`);
        } catch (e) {
            log('warn', `marketProbe failed: ${(e && e.message) || e}`);
        }
    }

    // ── v2 market navigation ────────────────────────────────────────────
    // The v1 openServerMarket (MarketIcon/JobCard selectors) is dead in this
    // build, so we drive the flow the user described instead:
    //   HOME : click Home tile → click the full-width "Market" button.
    //   other: click tile → Connect (if needed) → click the chest icon button
    //          to the RIGHT of Login in the panel's actions row.
    function findHomeTile(NM) {
        const SEL = NM.SEL || {};
        for (const it of document.querySelectorAll(SEL.SERVER_ITEM || '[data-sentry-component="ServerItem"]')) {
            if (it.querySelector(SEL.HOME_ICON || '[data-sentry-component="HomeServerIcon"]')) return it;
        }
        return null;
    }

    function findMarketButton() {
        // (a) Labelled button — the HOME panel's full-width "Market" button.
        for (const b of document.querySelectorAll('button')) {
            if ((b.textContent || '').trim().toLowerCase() === 'market') return b;
        }
        // (b) Connected non-home server — the icon-only "chest" button placed
        //     immediately to the RIGHT of Login in the actions row.
        const login = document.querySelector('[data-onboarding-300-id="ServerInfoPanelLoginButton"]');
        if (login) {
            const loginBtn = login.closest('button') || login;
            const row = loginBtn.closest('[data-sentry-element="ActionsRowStyled"]') || loginBtn.parentElement;
            if (row) {
                const btns = [...row.querySelectorAll('button')];
                for (let i = btns.indexOf(loginBtn) + 1; i < btns.length; i++) {
                    if (!(btns[i].textContent || '').trim()) return btns[i];  // icon-only ⇒ chest/Market
                }
            }
        }
        return null;
    }

    async function waitFor(fn, timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            let v = null;
            try { v = fn(); } catch (_) { /* noop */ }
            if (v) return v;
            await new Promise((r) => setTimeout(r, 250));
        }
        return null;
    }

    async function openMarketV2(serverName, NM, dom) {
        const SEL = NM.SEL || {};

        const nmOk = await NM.ensureNetworkMapOpen();
        log(nmOk ? 'debug' : 'error', `Open Market: Network Map open → ${nmOk}`);
        if (!nmOk) return false;

        const tile = serverName ? NM.findServerItemByName(serverName) : findHomeTile(NM);
        if (!tile) { log('error', `Open Market: server tile not found for "${serverName || 'home'}"`); return false; }
        dom.clickEl(tile.querySelector(SEL.SERVER_ICON) || tile);
        await dom.sleep(700);

        // Non-home markets need an active connection before the chest appears.
        if (serverName) {
            const connectEl = document.querySelector('[data-onboarding-300-id="ServerInfoPanelConnectButton"]')
                || document.querySelector(SEL.CONNECT_BTN);
            const connectBtn = connectEl && (connectEl.closest('button') || connectEl);
            if (connectBtn && !connectBtn.disabled) {
                log('info', `Open Market: connecting to "${serverName}"…`);
                dom.clickEl(connectBtn);
                const ready = await waitFor(() => findMarketButton()
                    || document.querySelector('[data-onboarding-300-id="ServerInfoPanelLoginButton"]'), 15000);
                log('debug', `Open Market: post-connect control appeared → ${!!ready}`);
            }
        }

        const btn = await waitFor(() => findMarketButton(), 8000);
        if (!btn) { log('warn', `Open Market: Market button not found for "${serverName || 'home'}"`); return false; }
        dom.clickEl(btn);
        log('info', `Open Market: clicked Market for "${serverName || 'home'}"`);
        return true;
    }

    Bus.window.on(AJV2.OPEN_SAI, async (env) => {
        const serverName = env && env.serverName;
        log('info', `Open SAI requested → "${serverName || '(none)'}"`);
        const g = game();
        const NM = g.networkMap;
        const SC = g.serverConnect;
        if (!serverName) { log('error', 'Open SAI aborted — no server name in message'); return; }
        if (!NM || typeof NM.ensureNetworkMapOpen !== 'function') { log('error', 'Open SAI aborted — networkMap helper missing'); return; }
        if (!SC || typeof SC.connect !== 'function') { log('error', 'Open SAI aborted — serverConnect helper missing'); return; }

        await withGameLogMirror(async () => {
            // 1. Network Map must be open (connect() looks the server up in it).
            const nmOk = await NM.ensureNetworkMapOpen();
            log(nmOk ? 'debug' : 'error', `Network Map open check → ${nmOk}`);
            if (!nmOk) { log('error', 'Open SAI aborted — Network Map did not open'); return; }

            // 2. connect() runs Connect → Login → Active-Access (else Hack tool)
            //    → SAI. Its own log() calls are routed into the v2 log too.
            try {
                const ok = await SC.connect(serverName, (lvl, m) => log(lvl, m));
                log(ok ? 'info' : 'warn', `Open SAI ${ok ? 'succeeded — SAI open' : 'failed — could not open SAI'} for "${serverName}"`);
                if (!ok) dumpDom('open-sai-fail');
            } catch (e) {
                log('error', `Open SAI threw for "${serverName}": ${(e && e.message) || e}`);
                dumpDom('open-sai-throw');
            }
        });
    });

    Bus.window.on(AJV2.OPEN_MARKET, async (env) => {
        // serverName === null → the HOME market.
        const serverName = (env && env.serverName) || null;
        log('info', `Open Market requested → "${serverName || '(home)'}"`);
        const NM = game().networkMap;
        const dom = root.COR3 && root.COR3.dom;
        if (!NM || typeof NM.ensureNetworkMapOpen !== 'function' || !dom) { log('error', 'Open Market aborted — game helpers missing'); return; }

        await withGameLogMirror(async () => {
            try {
                const ok = await openMarketV2(serverName, NM, dom);
                log(ok ? 'info' : 'warn', `Open Market ${ok ? 'done — Market clicked' : 'failed'} for "${serverName || 'home'}"`);
                if (!ok) { dumpDom('open-market-fail'); marketProbe(); }
            } catch (e) {
                log('error', `Open Market threw for "${serverName || 'home'}": ${(e && e.message) || e}`);
                dumpDom('open-market-throw');
                marketProbe();
            }
        });
    });

    console.log('[COR3] Auto-Jobs v2 bridge installed (MAIN)');
})();
