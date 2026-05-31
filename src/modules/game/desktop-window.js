// MAIN-world desktop window-manager helper (namespace COR3.game.desktop).
//
// cor3.gg's desktop is a React app. Its windows (Network Map, SAI Terminal,
// file viewers, …) are opened by the client's OWN local UI actions — there is
// NO WebSocket request to "open a window" (verified against the live protocol:
// no open.app / launch / focus.window action exists). The window manager is a
// module-private store; the only reachable entry points are the React handlers
// the components already bind.
//
// This helper drives those handlers DIRECTLY (a plain function call) instead of
// synthesising DOM mouse-clicks at screen coordinates:
//   • openApp(key)        — invoke a dock launcher's React onClick (verified:
//                           mounts the app window with ZERO MouseEvents).
//   • invokeReactClick(el)— invoke any element's React onClick handler.
//   • findPanelButton(..) — locate a Network-Map panel control by its stable
//                           data-onboarding id or label.
//   • selectServerTile(n) — select a server NODE on the map. The map is an SVG
//                           driven by a pointer/tap controller with no callable
//                           selection handler, so this is the ONE residual:
//                           a single targeted pointer tap on the LOCATED tile
//                           element (not blind screen coordinates). Verified
//                           live: the panel switches to that server.
//
// Plain namespace, NOT a registered Module — it owns no Bus subscriptions or
// storage. Consumed by the Auto-Jobs v2 bridge.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    if (!root.COR3) return;

    // Dock launcher component-name per desktop app (data-component-name on the
    // TabBar item). Lifted from the live dock; extend as the game adds apps.
    const DOCK = {
        NETWORK_MAP: 'TabBarItem-NETWORK_MAP',
        TERMINAL:    'TabBarItem-TERMINAL',
        CODEX:       'TabBarItem-CODEX',
        MESSENGER:   'TabBarItem-MESSENGER',
        EXPEDITIONS: 'TabBarItem-EXPEDITIONS',
        BROWSER:     'TabBarItem-BROWSER',
        LOADOUT:     'LoadoutTabBarItem',
    };

    // The mounted-window component-name for an app (differs from the dock key).
    const MOUNTED = {
        NETWORK_MAP: 'NetworkMapApplication',
    };

    const SERVER_ITEM = '[data-sentry-component="ServerItem"]';
    const HOME_ICON   = '[data-sentry-component="HomeServerIcon"]';
    const NM_APP      = '[data-sentry-component="NetworkMapApplication"]';

    function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

    function reactProps(el) {
        if (!el) return null;
        const k = Object.keys(el).find((x) => x.startsWith('__reactProps$'));
        return k ? el[k] : null;
    }

    // Minimal synthetic event so handlers calling e.stopPropagation() /
    // e.preventDefault() don't throw. We invoke the handler directly — no DOM
    // event is dispatched.
    function syntheticEvent(el) {
        return { stopPropagation() {}, preventDefault() {}, currentTarget: el, target: el, nativeEvent: {}, type: 'click' };
    }

    function isAppOpen(mountedComponent) {
        return !!document.querySelector(`[data-sentry-component="${mountedComponent}"]`);
    }

    // Invoke an element's React onClick handler directly. Returns false if the
    // element carries no such handler (caller decides whether that's fatal).
    function invokeReactClick(el) {
        const p = reactProps(el);
        if (p && typeof p.onClick === 'function') { p.onClick(syntheticEvent(el)); return true; }
        return false;
    }

    // Within `rootEl`, find the first descendant whose textContent includes
    // `text` AND carries a React onClick (the actual clickable row — the visible
    // label DIV is often a level above/below the onClick node). Used for list
    // rows with no stable id (e.g. SAI access grants / hack tools).
    function findClickableByText(rootEl, text) {
        if (!rootEl) return null;
        for (const el of rootEl.querySelectorAll('*')) {
            if ((el.textContent || '').includes(text)) {
                const p = reactProps(el);
                if (p && typeof p.onClick === 'function') return el;
            }
        }
        return null;
    }

    // Open a desktop app by its dock key (e.g. 'NETWORK_MAP'). Throws on an
    // unknown key or a missing dock item / handler — v2 rule: fail loud, never
    // silently degrade.
    function openApp(appKey) {
        const comp = DOCK[appKey];
        if (!comp) throw new Error(`desktop.openApp: unknown app key "${appKey}"`);
        const el = document.querySelector(`[data-component-name="${comp}"]`);
        if (!el) throw new Error(`desktop.openApp: dock item "${comp}" not in DOM`);
        if (!invokeReactClick(el)) throw new Error(`desktop.openApp: dock item "${comp}" has no React onClick handler`);
        return true;
    }

    // Open an app and resolve once its window mounts (or time out → false).
    async function openAppAndWait(appKey, timeoutMs) {
        const mounted = MOUNTED[appKey];
        if (!mounted) throw new Error(`desktop.openAppAndWait: no mounted-component mapping for "${appKey}"`);
        if (isAppOpen(mounted)) return true;
        openApp(appKey);
        const deadline = Date.now() + (timeoutMs == null ? 8000 : timeoutMs);
        while (Date.now() < deadline) {
            if (isAppOpen(mounted)) return true;
            await sleep(150);
        }
        return false;
    }

    // Find a server tile on the open Network Map. serverName === null → the
    // HOME tile (matched by its home icon).
    //
    // The name is rendered as a discrete label, but a tile's full textContent
    // concatenates timer/faction/NEW with NO separators — e.g.
    // "9H:02MCEDRT01NEWRM7-E1L3" — so a LEFT word-boundary before the name can
    // never match ("W" of NEW / a cluster digit precedes it). Match the label
    // element exactly first; fall back to a RIGHT-bounded text match (the name
    // is the trailing token). Never anchor on the left.
    function findServerTile(serverName) {
        const tiles = [...document.querySelectorAll(SERVER_ITEM)];
        if (!serverName) return tiles.find((t) => t.querySelector(HOME_ICON)) || null;
        const esc = serverName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const right = new RegExp(`${esc}([^A-Za-z0-9_-]|$)`);
        return tiles.find((t) =>
            [...t.querySelectorAll('*')].some((el) => (el.textContent || '').trim() === serverName)
            || right.test(t.textContent || '')
        ) || null;
    }

    // Select a server node. The SVG map's selection is pointer/tap-driven with
    // no callable handler, so we dispatch a single targeted pointer tap on the
    // LOCATED tile element (its own centre — not blind screen coordinates).
    // Returns false if the tile isn't on the map. Verified live.
    function selectServerTile(serverName) {
        const tile = findServerTile(serverName);
        if (!tile) return false;
        const r = tile.getBoundingClientRect();
        const o = {
            bubbles: true, cancelable: true, view: window,
            clientX: Math.round(r.x + r.width / 2), clientY: Math.round(r.y + r.height / 2),
            button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true,
        };
        tile.dispatchEvent(new PointerEvent('pointerdown', o));
        tile.dispatchEvent(new PointerEvent('pointerup', o));
        tile.dispatchEvent(new MouseEvent('click', o));
        return true;
    }

    // Locate a Network-Map ServerInfoPanel control. opts = { onb } (a
    // data-onboarding-300-id, e.g. 'ServerInfoPanelLoginButton') or { text }
    // (exact button label, case-insensitive). Returns the <button> or null.
    function findPanelButton(opts) {
        const app = document.querySelector(NM_APP) || document;
        if (opts.onb) {
            const el = app.querySelector(`[data-onboarding-300-id="${opts.onb}"]`);
            if (el) return el.closest('button') || el;
        }
        if (opts.text) {
            const want = opts.text.trim().toLowerCase();
            for (const b of app.querySelectorAll('button')) {
                if ((b.textContent || '').trim().toLowerCase() === want) return b;
            }
        }
        return null;
    }

    // Poll fn() until it returns truthy or timeout. Used to await contextual
    // panel controls that mount after select/connect.
    async function waitFor(fn, timeoutMs) {
        const deadline = Date.now() + (timeoutMs == null ? 8000 : timeoutMs);
        while (Date.now() < deadline) {
            let v = null;
            try { v = fn(); } catch (_) { /* noop */ }
            if (v) return v;
            await sleep(200);
        }
        return null;
    }

    root.COR3.game = root.COR3.game || {};
    root.COR3.game.desktop = {
        DOCK, MOUNTED,
        openApp, openAppAndWait, isAppOpen,
        invokeReactClick, findClickableByText, findServerTile, selectServerTile, findPanelButton, waitFor,
    };
})();
