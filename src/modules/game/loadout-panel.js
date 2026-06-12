// src/modules/game/loadout-panel.js
// Site-embedded LOADOUT control panel. Lives as a pill anchored next to
// cor3.gg's native Notifications pill in the bottom-right of the
// desktop. Opening it just requests a fresh snapshot
// (`join-room loadout` → server replies) and renders from the cached
// data — we do NOT mount cor3.gg's native LOADOUT app, because it's a
// full-page REPLACEMENT of the desktop, not an overlay, so opening it
// would blank out whatever the user was looking at.
//
// Mutations are issued via plain WS frames captured from cor3.gg's own
// site:
//   • Software install   loadout / equip.software   { moduleConfigId }
//   • Software uninstall loadout / unequip.software { moduleConfigId }
//   • Hardware swap      loadout / equip.hardware   { moduleConfigId }
// (all with options.compress=true for bit-parity with the site)
// Helpers live on `window.__cor3LoadoutEquipSoftware` /
// `__cor3LoadoutUnequipSoftware` / `__cor3LoadoutEquipHardware` —
// see src/interceptors/ws-interceptor.js. Response is the full loadout
// snapshot, already routed through MSG.WS.LOADOUT, so our panel
// re-renders without polling.
//
// POWER toggle is purely client-side on cor3.gg — `localStorage[
// "loadout-powered"]` (JSON-bool) + an in-process observable. No WS
// involved. We mirror that here.
//
// MAIN-world module: still needs DOM access for the panel injection
// itself, but the native LOADOUT app is never touched.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Registry, dom, constants: C } = root.COR3;
    const MSG = C.MSG;
    // Translation helper. Falls back to the key name if i18n hasn't
    // loaded yet (shouldn't happen — manifest loads i18n.js before
    // this module — but defensive).
    function t(key, vars) {
        const i18n = root.COR3 && root.COR3.i18n;
        if (i18n && typeof i18n.t === 'function') return i18n.t(key, vars);
        return key;
    }
    // The Bus message the i18n bridge broadcasts when the user picks a
    // new language in the popup. Matches src/shared/i18n-bridge.js.
    const LANG_MSG = 'COR3_UI_LANGUAGE';

    // ─── ID / selector constants ─────────────────────────────────────────
    const HOST_ID   = 'cor3-loadout-panel-host';
    const PILL_ID   = 'cor3-loadout-panel-pill';
    const PANEL_ID  = 'cor3-loadout-panel-body';
    const DOCK_SEL  = 'div.go2090060298';
    // Local-storage key cor3.gg uses for the client-side POWER toggle.
    const LS_POWER_KEY = 'loadout-powered';
    // Our own setting: auto-power-off when opening the panel and
    // auto-restore on close. Defaults to ON.
    const LS_AUTO_POWER_KEY = 'cor3-lp-auto-power-off';
    // Pill position. One of:
    //   { mode: 'auto' }           docked left of the Notifications button (default)
    //   { mode: 'dock' }           right of the bottom-center app launcher bar
    //   { mode: 'hud' }            hanging under the top-right account HUD
    //                              (PATHFINDER/BALANCE) — panel opens DOWNWARD
    //   { mode: 'custom', frac }   free spot on the bottom edge; `frac` is the
    //                              right-offset as a fraction of the viewport
    //                              width, so it survives resizes proportionally
    const LS_POS_KEY = 'cor3-lp-pos';
    const POS_MODES = ['auto', 'dock', 'hud'];

    const TOAST_DURATION_MS = 4500;
    // Fixed widths from the CSS below — the layout math (_applyLayout)
    // keeps every part of the cluster on-screen using these.
    const PILL_W = 220;
    const PANEL_W = 480;
    const TOASTS_W = 320;
    // Drop the pill within this many px of a snap target → dock there.
    const SNAP_PX = 60;
    function findNotificationsAnchor() {
        // Anchor our pill next to cor3.gg's Notifications widget. We
        // pick a language-independent attribute baked into cor3.gg's
        // source code via the Sentry instrumentation plugin —
        //   data-sentry-source-file="notifications-history.tsx"
        // and the corresponding data-sentry-component / -element
        // attributes (NotificationsHistory*). These survive locale
        // switches; the previous text-match approach (looking for
        // "Уведомления") obviously broke when the user toggled cor3.gg
        // to English.
        //
        // We accept either spelling of the attribute (cor3.gg
        // occasionally rotates which level gets which marker), pick
        // any matching node, then walk up to the bottom-docked
        // container that wraps the whole widget.
        const node =
            document.querySelector('[data-sentry-source-file*="notifications-history"]')
            || document.querySelector('[data-sentry-component^="NotificationsHistory"]')
            || document.querySelector('[data-sentry-element^="NotificationsHistory"]')
            || document.querySelector('[data-sentry-source-file*="notifications"]')
            || document.querySelector('[data-sentry-component*="Notifications"]');
        if (!node) return null;
        // Walk up to the bottom-docked container that wraps the whole
        // widget. If we matched a Notifications-related node that
        // isn't part of the docked widget (e.g. a top-anchored toast
        // container the broad fallback selector caught), no ancestor
        // will satisfy the bottom-docked test — return null so the
        // panel's _reanchor falls back to right:4 bottom:0 instead of
        // mis-anchoring to a toast.
        let el = node;
        let wrap = null;
        while (el && el !== document.body) {
            const r = el.getBoundingClientRect();
            if (r.bottom >= window.innerHeight - 32 && r.width >= 200) { wrap = el; break; }
            el = el.parentElement;
        }
        if (!wrap) return null;
        // The wrapper is much wider than the visible "Notifications"
        // sticker button (it reserves the full width of the expanded
        // history list; the button is right-aligned inside it), so
        // anchoring to the wrapper's LEFT edge parks the pill way left of
        // the visible widget. Refine to the sticker button itself.
        return wrap.querySelector('button[data-sentry-element="StickerTabWrapperStyled"]')
            || wrap.querySelector('button')
            || wrap;
    }
    // The bottom-center app launcher bar (the "taskbar" of dock icons).
    // Its class hash (DOCK_SEL) rotates on cor3.gg deploys, so fall back
    // to a geometry scan; cache the hit — the scan walks every <div>.
    let dockElCache = null;
    function findDockAnchor() {
        const valid = (el) => {
            if (!el || !el.isConnected) return false;
            const r = el.getBoundingClientRect();
            return r.width >= 300 && r.width <= 1000 && r.height >= 30 && r.height <= 90
                && r.bottom >= window.innerHeight - 120;
        };
        if (valid(dockElCache)) return dockElCache;
        dockElCache = null;
        const bySel = document.querySelector(DOCK_SEL);
        if (valid(bySel)) { dockElCache = bySel; return bySel; }
        for (const d of document.querySelectorAll('div')) {
            const r = d.getBoundingClientRect();
            if (r.bottom >= window.innerHeight - 120 && r.height >= 30 && r.height <= 90
                && r.width >= 300 && r.width <= 1000
                && Math.abs((r.left + r.right) / 2 - window.innerWidth / 2) < 250) {
                dockElCache = d;
                return d;
            }
        }
        return null;
    }
    // The top-right account HUD (PATHFINDER / BALANCE / RENOWN) —
    // article[data-sentry-component="AccountOverview"], verified live.
    function findHudAnchor() {
        const el = document.querySelector('[data-sentry-component="AccountOverview"]')
            || document.querySelector('[data-sentry-source-file*="account-overview"]');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        // Sanity: it must actually be the top-right HUD, not a re-used
        // component somewhere else on the page.
        if (r.top > window.innerHeight / 2 || r.width < 200) return null;
        return el;
    }
    function readPowerLS() {
        try {
            const v = localStorage.getItem(LS_POWER_KEY);
            if (v === null) return null;
            return JSON.parse(v) === true;
        } catch (_) { return null; }
    }
    function writePowerLS(on) {
        try { localStorage.setItem(LS_POWER_KEY, JSON.stringify(!!on)); return true; }
        catch (_) { return false; }
    }
    function readAutoPower() {
        try {
            const v = localStorage.getItem(LS_AUTO_POWER_KEY);
            if (v === null) return true;   // default ON
            return JSON.parse(v) === true;
        } catch (_) { return true; }
    }
    function writeAutoPower(on) {
        try { localStorage.setItem(LS_AUTO_POWER_KEY, JSON.stringify(!!on)); }
        catch (_) {}
    }
    function readPos() {
        try {
            const v = localStorage.getItem(LS_POS_KEY);
            if (v === null) return { mode: 'auto' };
            const p = JSON.parse(v);
            if (p && p.mode === 'custom' && typeof p.frac === 'number' && isFinite(p.frac)) return p;
            if (p && POS_MODES.includes(p.mode)) return { mode: p.mode };
            return { mode: 'auto' };
        } catch (_) { return { mode: 'auto' }; }
    }
    function writePos(p) {
        try { localStorage.setItem(LS_POS_KEY, JSON.stringify(p)); }
        catch (_) {}
    }
    function clamp(v, lo, hi) {
        return Math.min(hi, Math.max(lo, v));
    }

    // ─── Resource maps ───────────────────────────────────────────────────
    // Which supply key each HW slot drives, and the key on hw.specs that
    // feeds it. Used to compute the hover-delta when a user previews an
    // alternative HW choice.
    const SLOT_SUPPLY = {
        cpu: [
            { supplyKey: 'cpu_frequency', specKey: 'cpuFrequency' },
            { supplyKey: 'cpu_cores',     specKey: 'cpuCores' },
        ],
        gpu: [
            { supplyKey: 'gpu_power',  specKey: 'gpuPower' },
            { supplyKey: 'gpu_memory', specKey: 'gpuMemory' },
        ],
        ram: [
            { supplyKey: 'ram_frequency', specKey: 'ramFrequency' },
            { supplyKey: 'ram_memory',    specKey: 'ramMemory' },
        ],
        psu: [
            { supplyKey: 'psu_power', specKey: 'psuPower' },
        ],
    };
    // demand.psu_total = sum of cpuConsuming + gpuConsuming on equipped
    // hardware (no SW-side psu draw on this account — verified from
    // resources.demand vs HW specs). Swapping CPU/GPU shifts demand.
    const SLOT_DEMAND = {
        cpu: { demandKey: 'psu_total', specKey: 'cpuConsuming' },
        gpu: { demandKey: 'psu_total', specKey: 'gpuConsuming' },
    };
    // The hardware slots, derived from SLOT_SUPPLY (the single source of which
    // slots exist). Every slot-iterating loop below uses this list; hw.category
    // is the slot name uppercased ('cpu' → 'CPU').
    const HW_SLOTS = Object.keys(SLOT_SUPPLY);

    // ─── Style ───────────────────────────────────────────────────────────
    const CSS = `
#${HOST_ID} { position: fixed; inset: 0; z-index: 2147483600; font-family: "Roboto Mono", monospace; color: #fff; pointer-events: none; }
#${PILL_ID} { position: absolute; bottom: 0; width: ${PILL_W}px; height: 34px; background: rgba(10,14,18,0.98); border-top-left-radius: 16px; border-top-right-radius: 16px; display: flex; align-items: center; justify-content: center; gap: 8px; font-size: 14px; font-weight: 700; letter-spacing: 0.5px; cursor: pointer; pointer-events: auto; user-select: none; touch-action: none; transition: background 120ms ease; }
#${PILL_ID}:hover { background: rgba(20,28,38,0.98); }
#${PILL_ID} .cor3-lp-chev { font-size: 10px; opacity: 0.7; transform: translateY(-1px); }
/* drag-to-reposition states */
#${PILL_ID}.cor3-lp-dragging { cursor: grabbing; box-shadow: 0 0 18px rgba(118,193,209,0.45); transition: none; }
#${PILL_ID}.cor3-lp-snap { background: rgba(118,193,209,0.28); }
/* ghost outlines marking the snap spots while dragging */
.cor3-lp-dock-hint { position: absolute; width: ${PILL_W}px; height: 34px; border: 2px dashed rgba(118,193,209,0.55); border-bottom: none; border-top-left-radius: 16px; border-top-right-radius: 16px; box-sizing: border-box; opacity: 0.85; pointer-events: none; }
.cor3-lp-dock-hint.hang { border: 2px dashed rgba(118,193,209,0.55); border-top: none; border-radius: 0 0 16px 16px; }
.cor3-lp-dock-hint.fill { border: 2px dashed rgba(118,193,209,0.55); border-radius: 10px; }
.cor3-lp-dock-hint.near { border-color: rgba(118,193,209,1); background: rgba(118,193,209,0.14); }
/* hud mode — the pill hangs UNDER the account HUD: radii flip down, the
 * panel opens DOWNWARD below the pill. */
#${HOST_ID}.cor3-lp-mode-hud #${PILL_ID} { border-radius: 0 0 16px 16px; }
#${HOST_ID}.cor3-lp-mode-hud .cor3-lp-auto { border-radius: 0 0 16px 16px; }
#${HOST_ID}.cor3-lp-mode-hud #${PANEL_ID} { border-top-left-radius: 0; border-bottom-left-radius: 16px; box-shadow: -8px 8px 32px rgba(0,0,0,0.4); }
/* dock mode — the cluster sits beside the app launcher bar and dresses
 * like it: ONE rounded block (outer corners only; the auto-pill's right
 * border is the divider) whose height/radius/background/border are
 * SAMPLED live from the bar (--cor3-lp-ds-* vars set by _applyLayout),
 * so a cor3.gg restyle carries over automatically. */
#${HOST_ID}.cor3-lp-mode-dock #${PILL_ID} { box-sizing: border-box; height: var(--cor3-lp-ds-h, 34px); background: var(--cor3-lp-ds-bg, rgba(10,14,18,0.98)); border: var(--cor3-lp-ds-border, 1px solid rgba(96,108,124,0.5)); border-left: none; border-radius: 0 var(--cor3-lp-ds-radius, 10px) var(--cor3-lp-ds-radius, 10px) 0; }
#${HOST_ID}.cor3-lp-mode-dock .cor3-lp-auto { box-sizing: border-box; height: var(--cor3-lp-ds-h, 34px); background: var(--cor3-lp-ds-bg, rgba(10,14,18,0.98)); border: var(--cor3-lp-ds-border, 1px solid rgba(96,108,124,0.5)); border-right: 1px solid rgba(96,108,124,0.35); border-radius: var(--cor3-lp-ds-radius, 10px) 0 0 var(--cor3-lp-ds-radius, 10px); }
#${HOST_ID}.cor3-lp-mode-dock #${PILL_ID}:hover, #${HOST_ID}.cor3-lp-mode-dock .cor3-lp-auto:hover { filter: brightness(1.3); }
/* Auto-power mini-pill — sits to the left of the main pill, toggles
 * the "shut off system on panel open" behaviour. */
.cor3-lp-auto { position: absolute; bottom: 0; height: 34px; padding: 0 12px; background: rgba(10,14,18,0.98); border-top-left-radius: 16px; border-top-right-radius: 16px; display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 700; letter-spacing: 0.5px; cursor: pointer; pointer-events: auto; user-select: none; transition: background 120ms ease; border-right: 1px solid rgba(96,108,124,0.25); }
.cor3-lp-auto:hover { background: rgba(20,28,38,0.98); }
.cor3-lp-auto .cor3-lp-auto-dot { width: 8px; height: 8px; border-radius: 50%; background: #4ade80; box-shadow: 0 0 6px #4ade80; }
.cor3-lp-auto.off .cor3-lp-auto-dot { background: #FE4949; box-shadow: 0 0 6px #FE4949; }
.cor3-lp-auto .cor3-lp-auto-label { color: rgba(255,255,255,0.85); }
#${PANEL_ID} { position: absolute; bottom: 34px; width: ${PANEL_W}px; max-height: 78vh; background: rgba(10,14,18,0.98); border-top-left-radius: 16px; display: none; flex-direction: column; overflow: hidden; pointer-events: auto; box-shadow: -8px -8px 32px rgba(0,0,0,0.4); }
#${PANEL_ID}.cor3-lp-open { display: flex; }
#${PANEL_ID} .cor3-lp-header { padding: 10px 14px 8px; font-size: 13px; font-weight: 700; color: #76C1D1; letter-spacing: 0.6px; border-bottom: 1px solid rgba(96,108,124,0.25); display: flex; justify-content: space-between; align-items: center; gap: 8px; }
#${PANEL_ID} .cor3-lp-hdr-left  { display: flex; align-items: center; gap: 10px; }
#${PANEL_ID} .cor3-lp-hdr-right { display: flex; align-items: center; gap: 8px; }
#${PANEL_ID} .cor3-lp-power-btn { background: rgba(254,73,73,0.12); color: #FE4949; border: 1px solid rgba(254,73,73,0.4); padding: 3px 8px; border-radius: 4px; font-size: 10px; font-weight: 700; letter-spacing: 0.5px; cursor: pointer; font-family: inherit; transition: background 120ms ease; }
#${PANEL_ID} .cor3-lp-power-btn.on  { background: rgba(74,222,128,0.12); color: #4ade80; border-color: rgba(74,222,128,0.4); }
#${PANEL_ID} .cor3-lp-power-btn:hover { filter: brightness(1.25); }
#${PANEL_ID} .cor3-lp-power-btn[disabled] { opacity: 0.5; cursor: not-allowed; }
#${PANEL_ID} .cor3-lp-status { font-size: 11px; color: rgba(255,255,255,0.55); font-weight: 400; }
#${PANEL_ID} .cor3-lp-status.ok    { color: #4ade80; }
#${PANEL_ID} .cor3-lp-status.warn  { color: #ffc857; }
#${PANEL_ID} .cor3-lp-status.err   { color: #FE4949; }
#${PANEL_ID} .cor3-lp-scroll { overflow-y: auto; padding: 10px 14px 12px; flex: 1; }
#${PANEL_ID} .cor3-lp-section { margin-bottom: 12px; }
#${PANEL_ID} .cor3-lp-section-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px; color: rgba(255,255,255,0.6); margin-bottom: 6px; }
/* bars */
#${PANEL_ID} .cor3-lp-bar { margin-bottom: 6px; font-size: 11px; }
#${PANEL_ID} .cor3-lp-bar-row { display: flex; justify-content: space-between; margin-bottom: 2px; }
#${PANEL_ID} .cor3-lp-bar-name { color: rgba(255,255,255,0.7); text-transform: uppercase; letter-spacing: 0.5px; }
#${PANEL_ID} .cor3-lp-bar-val  { color: #fff; font-variant-numeric: tabular-nums; }
#${PANEL_ID} .cor3-lp-bar-delta { font-variant-numeric: tabular-nums; margin-left: 8px; }
#${PANEL_ID} .cor3-lp-bar-delta.up   { color: #4ade80; }
#${PANEL_ID} .cor3-lp-bar-delta.down { color: #FE4949; }
#${PANEL_ID} .cor3-lp-bar-track { height: 5px; background: rgba(96,108,124,0.25); border-radius: 2px; overflow: hidden; position: relative; }
#${PANEL_ID} .cor3-lp-bar-fill  { height: 100%; background: #76C1D1; transition: width 200ms ease; }
#${PANEL_ID} .cor3-lp-bar-fill.hot  { background: #ffc857; }
#${PANEL_ID} .cor3-lp-bar-fill.over { background: #FE4949; }
#${PANEL_ID} .cor3-lp-bar-preview { position: absolute; top: 0; left: 0; height: 100%; background: rgba(118,193,209,0.35); border-right: 2px dashed rgba(255,255,255,0.7); transition: width 120ms ease; }
#${PANEL_ID} .cor3-lp-bar-cap-old { position: absolute; top: -1px; bottom: -1px; width: 1px; background: rgba(255,255,255,0.5); }
/* slots */
#${PANEL_ID} .cor3-lp-slot { background: rgba(21,28,34,0.6); border: 1px solid rgba(96,108,124,0.2); border-radius: 6px; margin-bottom: 6px; overflow: hidden; }
#${PANEL_ID} .cor3-lp-slot.equipped { border-color: rgba(118,193,209,0.45); }
#${PANEL_ID} .cor3-lp-slot-head { display: flex; gap: 10px; padding: 8px 10px; cursor: pointer; align-items: center; }
#${PANEL_ID} .cor3-lp-slot-head:hover { background: rgba(118,193,209,0.06); }
#${PANEL_ID} .cor3-lp-slot-head .cor3-lp-arrow { color: rgba(255,255,255,0.5); font-size: 10px; transition: transform 120ms ease; flex-shrink: 0; }
#${PANEL_ID} .cor3-lp-slot.open .cor3-lp-slot-head .cor3-lp-arrow { transform: rotate(90deg); color: #76C1D1; }
#${PANEL_ID} .cor3-lp-slot img { width: 36px; height: 36px; object-fit: contain; flex-shrink: 0; background: rgba(10,14,18,0.5); border-radius: 4px; }
#${PANEL_ID} .cor3-lp-slot-body { flex: 1; min-width: 0; }
#${PANEL_ID} .cor3-lp-slot-cat { color: rgba(118,193,209,0.7); font-size: 10px; letter-spacing: 0.5px; font-weight: 700; }
#${PANEL_ID} .cor3-lp-slot-name { font-weight: 700; color: #fff; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#${PANEL_ID} .cor3-lp-slot-meta { color: rgba(255,255,255,0.55); font-size: 10px; }
#${PANEL_ID} .cor3-lp-slot-options { padding: 0 10px 8px 56px; display: none; }
#${PANEL_ID} .cor3-lp-slot.open .cor3-lp-slot-options { display: block; }
#${PANEL_ID} .cor3-lp-opt { display: flex; gap: 8px; padding: 5px 8px; align-items: center; cursor: pointer; border-radius: 4px; border: 1px solid transparent; margin-bottom: 3px; }
#${PANEL_ID} .cor3-lp-opt:hover { background: rgba(118,193,209,0.1); border-color: rgba(118,193,209,0.3); }
#${PANEL_ID} .cor3-lp-opt-body { flex: 1; min-width: 0; }
#${PANEL_ID} .cor3-lp-opt-name { font-size: 11px; color: #fff; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#${PANEL_ID} .cor3-lp-opt-meta { font-size: 10px; color: rgba(255,255,255,0.55); }
#${PANEL_ID} .cor3-lp-opt-empty { color: rgba(255,255,255,0.4); font-style: italic; font-size: 11px; padding: 4px 0; }
/* programs */
#${PANEL_ID} .cor3-lp-prog { display: flex; gap: 10px; padding: 6px 10px; background: rgba(21,28,34,0.4); border: 1px solid rgba(96,108,124,0.15); border-radius: 6px; margin-bottom: 4px; font-size: 11px; align-items: center; }
#${PANEL_ID} .cor3-lp-prog.equipped { background: rgba(21,28,34,0.7); border-color: rgba(118,193,209,0.45); }
#${PANEL_ID} .cor3-lp-prog img { width: 32px; height: 32px; object-fit: contain; flex-shrink: 0; background: rgba(10,14,18,0.5); border-radius: 4px; }
#${PANEL_ID} .cor3-lp-prog-body { flex: 1; min-width: 0; }
#${PANEL_ID} .cor3-lp-prog-name { font-weight: 700; color: #fff; font-size: 12px; margin-bottom: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#${PANEL_ID} .cor3-lp-prog-meta { color: rgba(255,255,255,0.55); font-size: 10px; }
#${PANEL_ID} .cor3-lp-prog-toggle { width: 26px; height: 26px; border-radius: 4px; display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 700; cursor: pointer; border: 1px solid transparent; font-family: inherit; transition: background 120ms ease; flex-shrink: 0; }
#${PANEL_ID} .cor3-lp-prog-toggle.install   { background: rgba(74,222,128,0.12);  color: #4ade80; border-color: rgba(74,222,128,0.3); }
#${PANEL_ID} .cor3-lp-prog-toggle.uninstall { background: rgba(254,73,73,0.12); color: #FE4949; border-color: rgba(254,73,73,0.3); }
#${PANEL_ID} .cor3-lp-prog-toggle:hover { filter: brightness(1.3); }
#${PANEL_ID} .cor3-lp-prog-toggle[disabled] { opacity: 0.4; cursor: not-allowed; }
/* tier */
#${PANEL_ID} .cor3-lp-tier { flex-shrink: 0; font-size: 9px; color: rgba(255,255,255,0.5); padding: 1px 5px; border: 1px solid rgba(96,108,124,0.4); border-radius: 3px; line-height: 1.4; }
#${PANEL_ID} .cor3-lp-tier.t2 { color: #76C1D1; border-color: #76C1D1; }
#${PANEL_ID} .cor3-lp-tier.t3 { color: #ffc857; border-color: #ffc857; }
/* caps */
#${PANEL_ID} .cor3-lp-caps { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }
#${PANEL_ID} .cor3-lp-cap { padding: 2px 8px; border-radius: 10px; font-size: 10px; font-weight: 700; letter-spacing: 0.5px; cursor: pointer; transition: filter 100ms ease, transform 100ms ease; }
#${PANEL_ID} .cor3-lp-cap.have    { background: rgba(74,222,128,0.15); color: #4ade80; border: 1px solid rgba(74,222,128,0.35); }
#${PANEL_ID} .cor3-lp-cap.missing { background: rgba(254,73,73,0.10); color: #FE4949; border: 1px solid rgba(254,73,73,0.3); }
#${PANEL_ID} .cor3-lp-cap.missing:hover { filter: brightness(1.4); transform: scale(1.04); }
#${PANEL_ID} .cor3-lp-cap.unowned { background: rgba(96,108,124,0.10); color: rgba(255,255,255,0.45); border: 1px solid rgba(96,108,124,0.35); cursor: not-allowed; }
#${PANEL_ID} .cor3-lp-cap-line { font-size: 10px; color: rgba(255,255,255,0.6); margin-top: 4px; line-height: 1.5; }
#${PANEL_ID} .cor3-lp-cap-line-label { color: rgba(255,255,255,0.5); font-weight: 700; letter-spacing: 0.5px; }
#${PANEL_ID} .cor3-lp-cap-tgt { display: inline-block; padding: 1px 6px; border-radius: 3px; font-family: "Roboto Mono", monospace; font-size: 10px; margin-right: 2px; cursor: pointer; transition: filter 100ms ease, transform 100ms ease; }
#${PANEL_ID} .cor3-lp-cap-tgt:hover { filter: brightness(1.4); transform: scale(1.04); }
#${PANEL_ID} .cor3-lp-cap-tgt.on  { background: rgba(74,222,128,0.15); color: #4ade80; border: 1px solid rgba(74,222,128,0.3); }
#${PANEL_ID} .cor3-lp-cap-tgt.off { background: rgba(96,108,124,0.10); color: rgba(255,255,255,0.45); border: 1px solid rgba(96,108,124,0.3); }
/* program-card capability lines (targets + power band) */
#${PANEL_ID} .cor3-lp-prog-cap { display: flex; flex-wrap: wrap; align-items: baseline; gap: 5px; line-height: 1.5; }
#${PANEL_ID} .cor3-lp-prog-cap-type { color: #76C1D1; font-weight: 700; letter-spacing: 0.4px; }
#${PANEL_ID} .cor3-lp-prog-cap-pow { color: rgba(255,255,255,0.85); font-variant-numeric: tabular-nums; }
#${PANEL_ID} .cor3-lp-prog-cap-r { color: #ffc857; font-weight: 700; font-size: 9px; }
#${PANEL_ID} .cor3-lp-prog-cap-tgts { color: rgba(255,255,255,0.5); font-family: "Roboto Mono", monospace; }
/* capability-target chooser (overlay) */
#${PANEL_ID} .cor3-lp-chooser { position: absolute; left: 0; right: 0; top: 0; bottom: 0; background: rgba(8,11,15,0.97); z-index: 6; display: flex; flex-direction: column; padding: 10px 14px 12px; }
#${PANEL_ID} .cor3-lp-chooser-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; gap: 8px; }
#${PANEL_ID} .cor3-lp-chooser-title { font-size: 12px; font-weight: 700; color: #76C1D1; letter-spacing: 0.4px; }
#${PANEL_ID} .cor3-lp-chooser-close { background: none; border: 1px solid rgba(96,108,124,0.4); color: rgba(255,255,255,0.7); border-radius: 4px; width: 24px; height: 24px; cursor: pointer; font-family: inherit; font-size: 12px; flex-shrink: 0; }
#${PANEL_ID} .cor3-lp-chooser-close:hover { background: rgba(254,73,73,0.15); color: #FE4949; border-color: rgba(254,73,73,0.4); }
#${PANEL_ID} .cor3-lp-chooser-list { overflow-y: auto; flex: 1; }
#${PANEL_ID} .cor3-lp-chooser-row { display: flex; gap: 10px; align-items: center; padding: 6px 8px; border: 1px solid rgba(96,108,124,0.15); border-radius: 6px; margin-bottom: 4px; background: rgba(21,28,34,0.4); cursor: pointer; }
#${PANEL_ID} .cor3-lp-chooser-row:hover { border-color: rgba(118,193,209,0.4); background: rgba(118,193,209,0.08); }
#${PANEL_ID} .cor3-lp-chooser-row.equipped { border-color: rgba(74,222,128,0.4); background: rgba(21,28,34,0.7); }
#${PANEL_ID} .cor3-lp-chooser-row img { width: 30px; height: 30px; object-fit: contain; flex-shrink: 0; background: rgba(10,14,18,0.5); border-radius: 4px; }
#${PANEL_ID} .cor3-lp-chooser-body { flex: 1; min-width: 0; }
#${PANEL_ID} .cor3-lp-chooser-name { font-size: 12px; font-weight: 700; color: #fff; display: flex; align-items: center; gap: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#${PANEL_ID} .cor3-lp-chooser-meta { font-size: 10px; color: rgba(255,255,255,0.55); }
#${PANEL_ID} .cor3-lp-foot { padding: 8px 14px; border-top: 1px solid rgba(96,108,124,0.25); font-size: 10px; color: rgba(255,255,255,0.4); display: flex; justify-content: space-between; align-items: center; }
#${PANEL_ID} .cor3-lp-btn { background: rgba(118,193,209,0.12); color: #76C1D1; border: 1px solid rgba(118,193,209,0.35); padding: 3px 10px; border-radius: 4px; font-size: 10px; font-weight: 700; letter-spacing: 0.5px; cursor: pointer; font-family: inherit; }
#${PANEL_ID} .cor3-lp-btn:hover { background: rgba(118,193,209,0.22); }
/* toasts — stack above the pill, slide+fade in/out */
.cor3-lp-toasts { position: absolute; bottom: 38px; width: ${TOASTS_W}px; display: flex; flex-direction: column; gap: 6px; pointer-events: none; z-index: 2147483601; }
.cor3-lp-toast { background: rgba(10,14,18,0.98); border-left: 3px solid #76C1D1; border-radius: 4px; padding: 8px 12px; color: #fff; font-family: "Roboto Mono", monospace; font-size: 11px; line-height: 1.4; box-shadow: -4px -4px 16px rgba(0,0,0,0.4); pointer-events: auto; animation: cor3-lp-toast-in 200ms ease; }
.cor3-lp-toast.warn { border-left-color: #ffc857; }
.cor3-lp-toast.err  { border-left-color: #FE4949; }
.cor3-lp-toast.ok   { border-left-color: #4ade80; }
.cor3-lp-toast .cor3-lp-toast-title { font-weight: 700; color: #fff; margin-bottom: 2px; letter-spacing: 0.3px; }
.cor3-lp-toast.warn .cor3-lp-toast-title { color: #ffc857; }
.cor3-lp-toast.err  .cor3-lp-toast-title { color: #FE4949; }
.cor3-lp-toast.ok   .cor3-lp-toast-title { color: #4ade80; }
.cor3-lp-toast .cor3-lp-toast-text { color: rgba(255,255,255,0.75); font-size: 10px; }
.cor3-lp-toast.cor3-lp-toast-leaving { animation: cor3-lp-toast-out 200ms ease forwards; }
@keyframes cor3-lp-toast-in  { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
@keyframes cor3-lp-toast-out { from { opacity: 1; transform: translateY(0); } to { opacity: 0; transform: translateY(-8px); } }
`;

    // ─── Module ──────────────────────────────────────────────────────────
    class LoadoutPanelModule extends Module {
        constructor() {
            super({
                id: 'loadout-panel',
                name: 'Loadout Panel',
                category: C.CATEGORY.UI || C.CATEGORY.GAME,
            });
            this._snapshot = null;
            this._open = false;
            this._injected = false;
            this._mountTimer = null;
            this._reanchorTimer = null;
            this._openSlot = null;       // 'cpu' | 'gpu' | 'ram' | 'psu' | null
            this._hoveringHwId = null;   // id of HW being hovered in dropdown — drives delta overlay
            this._chooser = null;        // { cap, tgt } when a capability-target chooser is open
            this._powerState = null;     // true=on, false=off, null=unknown
            this._autoPower = readAutoPower();   // setting: auto-poweroff on open
            this._savedPowerState = null;        // remembered across open/close when _autoPower=true
            this._toastSeq = 0;
            // Drag-to-reposition state. While `_dragging`, the periodic
            // _reanchor is suspended — the pointer owns the position.
            this._dragging = false;
            // Watchdog for server-side mutation outcomes. When we send
            // equip/unequip/swap, we set `_pendingMutation` so the
            // snapshot handler can compare expected vs actual change.
            // Shape: { kind: 'equip-sw'|'unequip-sw'|'equip-hw', id, name, ts }
            this._pendingMutation = null;
            this._pendingMutationTimer = null;
        }

        async start() {
            this.track(Bus.window.on(MSG.WS.LOADOUT, (env) => {
                if (!env || !env.data) return;
                this._snapshot = env.data;
                // Check whether a pending mutation actually took effect.
                // Some failures (e.g. server-side resource conflict our
                // floor-check missed) come back as an unchanged snapshot.
                this._reconcilePendingMutation();
                if (this._open) this._render();
                this.debug('loadout snapshot received', {
                    canBoot: env.data.resources && env.data.resources.canBoot,
                });
            }));
            // Re-localise immediately on language change broadcast by
            // the i18n-bridge (popup picker → chrome.storage.sync →
            // bridge → Bus.window). Static chrome (pill / header /
            // refresh / auto pill) is rewritten in place; if the body
            // is open we re-render the whole panel.
            this.track(Bus.window.on(LANG_MSG, () => this._relocalize()));
            this._mountTimer = setInterval(() => {
                if (document.querySelector(DOCK_SEL)) {
                    clearInterval(this._mountTimer);
                    this._mountTimer = null;
                    this._injectUi();
                }
            }, 500);
            // Re-anchor on window resize. Keep a stable bound reference so
            // stop()/reload can remove it — a fresh `.bind()` each start would
            // be unremovable and leak one dead handler per reload.
            this._onResize = () => this._reanchor();
            window.addEventListener('resize', this._onResize);
        }

        async stop() {
            if (this._mountTimer) { clearInterval(this._mountTimer); this._mountTimer = null; }
            if (this._reanchorTimer) { clearInterval(this._reanchorTimer); this._reanchorTimer = null; }
            if (this._onResize) { window.removeEventListener('resize', this._onResize); this._onResize = null; }
            document.getElementById(HOST_ID)?.remove();
            document.getElementById('cor3-loadout-panel-style')?.remove();
            this._injected = false;
        }

        // ─── Mounting / anchoring ─────────────────────────────────────
        _injectUi() {
            if (this._injected) return;
            if (!document.getElementById('cor3-loadout-panel-style')) {
                const style = document.createElement('style');
                style.id = 'cor3-loadout-panel-style';
                style.textContent = CSS;
                document.head.appendChild(style);
            }
            const host = document.createElement('div');
            host.id = HOST_ID;
            host.innerHTML = `
                <div id="${PANEL_ID}">
                    <div class="cor3-lp-header">
                        <div class="cor3-lp-hdr-left">
                            <span data-role="hdr-title">${escapeHtml(t('loadout.title'))}</span>
                            <button class="cor3-lp-power-btn" data-role="power" title="${escapeHtml(t('loadout.power.tooltip'))}">⏻</button>
                        </div>
                        <div class="cor3-lp-hdr-right">
                            <span class="cor3-lp-status" data-role="status">…</span>
                        </div>
                    </div>
                    <div class="cor3-lp-scroll" data-role="body"></div>
                    <div class="cor3-lp-foot">
                        <span data-role="updated">—</span>
                        <button class="cor3-lp-btn" data-role="refresh">${escapeHtml(t('loadout.refresh'))}</button>
                    </div>
                </div>
                <div class="cor3-lp-toasts" data-role="toasts"></div>
                <div data-role="hints"></div>
                <div class="cor3-lp-auto" data-role="auto">
                    <span class="cor3-lp-auto-dot"></span>
                    <span class="cor3-lp-auto-label" data-role="auto-label">${escapeHtml(t('loadout.auto.label'))}</span>
                </div>
                <div id="${PILL_ID}">
                    <span data-role="pill-title">${escapeHtml(t('loadout.title'))}</span>
                    <span class="cor3-lp-chev" data-role="chev">▲</span>
                </div>
            `;
            document.body.appendChild(host);

            // cor3.gg's desktop starts a rubber-band (marquee) selection
            // from mousedown at the document level; presses on our UI
            // bubble there (the host is a body child, not a desktop
            // child). Stop them at the host so interacting with the pill
            // or panel never starts a selection box under it.
            host.addEventListener('pointerdown', (e) => e.stopPropagation());
            host.addEventListener('mousedown', (e) => e.stopPropagation());
            const pillEl = host.querySelector(`#${PILL_ID}`);
            pillEl.title = t('loadout.pos.dragHint');
            // No 'click' listener: open/close lives in _onPillPointerDown's
            // pointerup branch — the pointerdown is preventDefault-ed (to
            // also kill the marquee's compatibility mousedown + native
            // selection), and a click after a cancelled pointerdown is not
            // reliable across browsers.
            pillEl.addEventListener('pointerdown', (e) => this._onPillPointerDown(e));
            host.querySelector('[data-role="auto"]').addEventListener('click', (e) => {
                e.stopPropagation();
                this._toggleAutoPower();
            });
            host.querySelector('[data-role="refresh"]').addEventListener('click', (e) => {
                e.stopPropagation();
                this._requestSnapshot();
            });
            host.querySelector('[data-role="power"]').addEventListener('click', (e) => {
                e.stopPropagation();
                this._togglePower();
            });

            // Body event delegation — slot expand, opt click, opt hover, prog toggle, cap chip click.
            const body = host.querySelector('[data-role="body"]');
            body.addEventListener('click', (e) => this._onBodyClick(e));
            body.addEventListener('mouseover', (e) => this._onBodyHover(e, true));
            body.addEventListener('mouseout', (e) => this._onBodyHover(e, false));
            this._refreshAutoPill();

            this._injected = true;
            this._reanchor();
            // Anchor periodically too — Notifications collapses/expands
            // and that may shift our pill position if cor3.gg ever changes
            // the layout to anything other than fixed-bottom-right.
            this._reanchorTimer = setInterval(() => this._reanchor(), 1000);
            this.info('panel injected');
        }

        _reanchor() {
            if (this._dragging) return;   // drag owns the position until drop
            this._applyLayout(this._layoutFor(readPos()));
        }

        // Resolve a stored position to a concrete layout. A snap mode whose
        // anchor element is missing this cycle (game UI not mounted yet, or
        // a cor3.gg redesign) falls back to the Notifications dock WITHOUT
        // touching storage — it self-heals the moment the anchor reappears.
        _layoutFor(pos) {
            if (pos.mode === 'custom') {
                return {
                    mode: 'custom',
                    right: clamp(Math.round(pos.frac * window.innerWidth), 4, this._maxRight()),
                    bottom: 0,
                };
            }
            if (pos.mode === 'dock' || pos.mode === 'hud') {
                const target = this._snapTargets().find((s) => s.mode === pos.mode);
                if (target) return target;
            }
            const a = this._autoOffsets();
            return { mode: 'auto', right: a.right, bottom: a.bottom };
        }

        // The position the pill takes when docked to the Notifications
        // widget (or the bottom-right fallback when it isn't on screen).
        _autoOffsets() {
            const anchor = findNotificationsAnchor();
            // Default fallback: bottom-right with 4px gap.
            let right = 4;
            let bottom = 0;
            if (anchor) {
                const r = anchor.getBoundingClientRect();
                right = Math.max(0, window.innerWidth - r.left + 4);
                bottom = Math.max(0, window.innerHeight - (r.top + r.height));
            }
            return { right, bottom };
        }

        // Every snap target available right now, as a concrete layout:
        //   auto — left of the Notifications button (always present)
        //   dock — cluster starts just right of the app launcher bar,
        //          vertically centred on it
        //   hud  — hanging under the account HUD, right edges aligned;
        //          `hang: true` flips the pill shape + panel direction
        _snapTargets() {
            const targets = [];
            const a = this._autoOffsets();
            targets.push({ mode: 'auto', right: a.right, bottom: a.bottom, hang: false });
            const dock = findDockAnchor();
            if (dock) {
                const r = dock.getBoundingClientRect();
                const cs = getComputedStyle(dock);
                targets.push({
                    mode: 'dock',
                    right: Math.max(4, Math.round(window.innerWidth - r.right - 8 - this._autoPillW() - PILL_W)),
                    // same height as the bar, bottoms aligned
                    bottom: Math.max(0, Math.round(window.innerHeight - r.bottom)),
                    hang: false,
                    pillH: Math.round(r.height),
                    // live-sampled look of the launcher bar (see CSS vars)
                    skin: {
                        h: Math.round(r.height) + 'px',
                        radius: cs.borderRadius,
                        bg: cs.backgroundColor,
                        border: `${cs.borderTopWidth} ${cs.borderTopStyle} ${cs.borderTopColor}`,
                    },
                });
            }
            const hud = findHudAnchor();
            if (hud) {
                const r = hud.getBoundingClientRect();
                targets.push({
                    mode: 'hud',
                    right: Math.max(4, Math.round(window.innerWidth - r.right)),
                    bottom: Math.max(0, Math.round(window.innerHeight - r.bottom - 6 - 34)),
                    hang: true,
                });
            }
            return targets;
        }

        _autoPillW() {
            const auto = document.querySelector(`#${HOST_ID} [data-role="auto"]`);
            return (auto && auto.offsetWidth) || 90;
        }

        // Largest right-offset that still keeps the whole pill cluster
        // (auto mini-pill + main pill) on screen.
        _maxRight() {
            return Math.max(4, window.innerWidth - PILL_W - this._autoPillW() - 4);
        }

        // Position the whole cluster. `layout.mode === 'hud'` flips the
        // open direction: pill hangs below the HUD, panel + toasts open
        // DOWNWARD (host covers the whole viewport, so `top` works too).
        // Panel and toasts are wider than the pill, so each gets its own
        // clamp — a pill parked at the far left must not push them
        // off-screen.
        _applyLayout(layout) {
            const host = document.getElementById(HOST_ID);
            if (!host) return;
            const hud = layout.mode === 'hud';
            const dock = layout.mode === 'dock';
            const pillH = layout.pillH || 34;
            host.classList.toggle('cor3-lp-mode-hud', hud);
            host.classList.toggle('cor3-lp-mode-dock', dock);
            if (dock && layout.skin) {
                host.style.setProperty('--cor3-lp-ds-h', layout.skin.h);
                host.style.setProperty('--cor3-lp-ds-radius', layout.skin.radius);
                host.style.setProperty('--cor3-lp-ds-bg', layout.skin.bg);
                host.style.setProperty('--cor3-lp-ds-border', layout.skin.border);
            }
            const pill = document.getElementById(PILL_ID);
            const panel = document.getElementById(PANEL_ID);
            const auto = host.querySelector('[data-role="auto"]');
            const toasts = host.querySelector('[data-role="toasts"]');
            const panelRight = clamp(layout.right, 4, Math.max(4, window.innerWidth - PANEL_W - 4));
            const toastsRight = clamp(layout.right, 4, Math.max(4, window.innerWidth - TOASTS_W - 4));
            const pillTop = window.innerHeight - layout.bottom - pillH;
            if (pill)  { pill.style.right  = layout.right + 'px';  pill.style.bottom  = layout.bottom + 'px'; }
            // Auto-pill sits just to the LEFT of the main pill, sharing the same bottom.
            if (auto) { auto.style.right = (layout.right + PILL_W) + 'px'; auto.style.bottom = layout.bottom + 'px'; }
            if (panel) {
                panel.style.right = panelRight + 'px';
                if (hud) {
                    panel.style.bottom = 'auto';
                    panel.style.top = (pillTop + pillH) + 'px';
                    panel.style.maxHeight = Math.max(200, window.innerHeight - (pillTop + pillH) - 8) + 'px';
                } else {
                    panel.style.top = 'auto';
                    panel.style.bottom = (layout.bottom + pillH) + 'px';
                    panel.style.maxHeight = '';
                }
            }
            // Toasts stack on the panel side of the pill, aligned to its edge.
            if (toasts) {
                toasts.style.right = toastsRight + 'px';
                if (hud) { toasts.style.bottom = 'auto'; toasts.style.top = (pillTop + pillH + 4) + 'px'; }
                else { toasts.style.top = 'auto'; toasts.style.bottom = (layout.bottom + pillH + 4) + 'px'; }
            }
            this._refreshChev();
        }

        // The pill chevron points where the panel will open (down in hud
        // mode, up everywhere else) and flips while open.
        _refreshChev() {
            const chev = document.querySelector(`#${PILL_ID} [data-role="chev"]`);
            if (!chev) return;
            const hud = readPos().mode === 'hud';
            chev.textContent = this._open ? (hud ? '▲' : '▼') : (hud ? '▼' : '▲');
        }

        // ─── Drag-to-reposition ───────────────────────────────────────
        // The pill follows the pointer freely while dragging ("in hand");
        // dashed ghosts mark every snap target. Dropping within SNAP_PX of
        // one docks there; dropping anywhere else lets the pill fall to
        // the bottom edge at the drop X (a custom spot). A press without
        // movement is a click → toggles the panel (no 'click' listener —
        // see _injectUi).
        _onPillPointerDown(e) {
            if (e.button !== 0) return;
            // Kill the page's marquee selection (cancelling pointerdown
            // suppresses its compatibility mousedown) + native drag/text
            // selection; stopPropagation keeps document-level listeners
            // from ever seeing the press.
            e.preventDefault();
            e.stopPropagation();
            const pill = e.currentTarget;
            const startX = e.clientX;
            const startY = e.clientY;
            const rect = pill.getBoundingClientRect();
            const grabDX = e.clientX - rect.left;
            const grabDY = e.clientY - rect.top;
            let drop = null;   // { right, bottom, snap: target|null }
            const onMove = (ev) => {
                // 5px threshold separates a drag from a sloppy click.
                if (!this._dragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
                if (!this._dragging) {
                    this._dragging = true;
                    pill.classList.add('cor3-lp-dragging');
                    this._renderSnapHints();
                }
                const right = clamp(Math.round(window.innerWidth - (ev.clientX - grabDX) - PILL_W), 4, this._maxRight());
                const bottom = clamp(Math.round(window.innerHeight - (ev.clientY - grabDY) - 34), 0, window.innerHeight - 40);
                const snap = this._nearestSnap(right, bottom);
                drop = snap ? { right: snap.right, bottom: snap.bottom, snap } : { right, bottom, snap: null };
                pill.classList.toggle('cor3-lp-snap', !!snap);
                this._highlightSnapHint(snap);
                this._applyLayout({ mode: snap ? snap.mode : 'drag', right: drop.right, bottom: drop.bottom });
            };
            const onUp = (ev) => {
                pill.removeEventListener('pointermove', onMove);
                pill.removeEventListener('pointerup', onUp);
                pill.removeEventListener('pointercancel', onUp);
                try { pill.releasePointerCapture(e.pointerId); } catch (_) {}
                if (!this._dragging) {
                    if (ev.type === 'pointerup') this._toggle();   // plain click
                    return;
                }
                this._dragging = false;
                pill.classList.remove('cor3-lp-dragging', 'cor3-lp-snap');
                this._clearSnapHints();
                if (drop && drop.snap) {
                    writePos({ mode: drop.snap.mode });
                    this._showToast(t('loadout.pos.dockedTitle'), 'ok', t('loadout.pos.dockedBody'));
                } else if (drop) {
                    writePos({ mode: 'custom', frac: drop.right / window.innerWidth });
                    this._showToast(t('loadout.pos.movedTitle'), 'ok', t('loadout.pos.movedBody'));
                }
                this._reanchor();
            };
            try { pill.setPointerCapture(e.pointerId); } catch (_) {}
            pill.addEventListener('pointermove', onMove);
            pill.addEventListener('pointerup', onUp);
            pill.addEventListener('pointercancel', onUp);
        }

        _nearestSnap(right, bottom) {
            let best = null;
            let bestDist = Infinity;
            for (const s of this._snapTargets()) {
                const d = Math.hypot(right - s.right, bottom - s.bottom);
                if (d <= SNAP_PX && d < bestDist) { best = s; bestDist = d; }
            }
            return best;
        }

        _renderSnapHints() {
            const wrap = document.querySelector(`#${HOST_ID} [data-role="hints"]`);
            if (!wrap) return;
            const hints = [];
            for (const s of this._snapTargets()) {
                const h = document.createElement('div');
                h.className = 'cor3-lp-dock-hint' + (s.hang ? ' hang' : '') + (s.skin ? ' fill' : '');
                h.dataset.snapMode = s.mode;
                h.style.right = s.right + 'px';
                h.style.bottom = s.bottom + 'px';
                // preview the skinned shape (dock target matches the bar)
                if (s.skin) { h.style.height = s.skin.h; h.style.borderRadius = s.skin.radius; }
                hints.push(h);
            }
            wrap.replaceChildren(...hints);
        }

        _highlightSnapHint(snap) {
            const wrap = document.querySelector(`#${HOST_ID} [data-role="hints"]`);
            if (!wrap) return;
            for (const h of wrap.children) {
                h.classList.toggle('near', !!snap && h.dataset.snapMode === snap.mode);
            }
        }

        _clearSnapHints() {
            const wrap = document.querySelector(`#${HOST_ID} [data-role="hints"]`);
            if (wrap) wrap.replaceChildren();
        }

        // ─── Open / close ─────────────────────────────────────────────
        _toggle() {
            this._open ? this._close() : this._open_();
        }

        async _open_() {
            this._open = true;
            const panel = document.getElementById(PANEL_ID);
            if (panel) panel.classList.add('cor3-lp-open');
            // Re-layout right away — the panel's open direction (up, or
            // down in hud mode) and max-height are set by _applyLayout.
            this._reanchor();
            // Auto power-off (default ON) — remember the user's prior
            // state, then force off while the panel is open. Restored
            // on close. Skips if the user already had it off.
            if (this._autoPower) {
                const cur = readPowerLS();
                this._savedPowerState = cur;
                if (cur !== false) writePowerLS(false);
                this._powerState = false;
            } else {
                this._powerState = readPowerLS();
            }
            // Fetch a fresh snapshot. Cheap and idempotent; the WS
            // round-trip is the same one cor3.gg's native LOADOUT app
            // does on mount, but without the page navigation.
            this._requestSnapshot();
            this._refreshPowerBtn();
            this._render();
        }

        async _close() {
            this._open = false;
            this._openSlot = null;
            this._hoveringHwId = null;
            this._closeCapChooser();
            const panel = document.getElementById(PANEL_ID);
            if (panel) panel.classList.remove('cor3-lp-open');
            this._refreshChev();
            // Restore prior power state if auto-mode is on and we
            // actually changed it on open. If user had it off prior to
            // open, we leave it off — _savedPowerState captured that.
            if (this._autoPower && this._savedPowerState !== null) {
                writePowerLS(this._savedPowerState);
                this._powerState = this._savedPowerState;
                this._savedPowerState = null;
            }
        }

        _toggleAutoPower() {
            this._autoPower = !this._autoPower;
            writeAutoPower(this._autoPower);
            this._refreshAutoPill();
            // If the user just enabled auto WHILE the panel is open,
            // retroactively switch the system off and remember the
            // current state for restore-on-close.
            if (this._open && this._autoPower && this._savedPowerState === null) {
                this._savedPowerState = readPowerLS();
                if (this._savedPowerState !== false) writePowerLS(false);
                this._powerState = false;
                this._refreshPowerBtn();
            }
            // If just disabled and we'd previously forced off, restore now.
            if (!this._autoPower && this._savedPowerState !== null) {
                writePowerLS(this._savedPowerState);
                this._powerState = this._savedPowerState;
                this._savedPowerState = null;
                this._refreshPowerBtn();
            }
            this._showToast(
                t(this._autoPower ? 'loadout.auto.toggledOn' : 'loadout.auto.toggledOff'),
                'ok',
                t(this._autoPower ? 'loadout.auto.toggledOnBody' : 'loadout.auto.toggledOffBody')
            );
        }

        _refreshAutoPill() {
            const auto = document.querySelector(`#${HOST_ID} [data-role="auto"]`);
            if (!auto) return;
            auto.classList.toggle('off', !this._autoPower);
            auto.title = t(this._autoPower ? 'loadout.auto.titleOn' : 'loadout.auto.titleOff');
        }

        // Re-apply translated labels to the static chrome of the panel
        // (pill + header + refresh + auto-pill + power tooltip). Called
        // on language-change broadcast. If the body is currently
        // visible, also re-render so section titles / chips / toasts
        // pick up the new locale.
        _relocalize() {
            const host = document.getElementById(HOST_ID);
            if (!host) return;
            const setText = (sel, value) => {
                const el = host.querySelector(sel);
                if (el) el.textContent = value;
            };
            setText('[data-role="hdr-title"]',  t('loadout.title'));
            setText('[data-role="pill-title"]', t('loadout.title'));
            setText('[data-role="refresh"]',   t('loadout.refresh'));
            setText('[data-role="auto-label"]', t('loadout.auto.label'));
            const power = host.querySelector('[data-role="power"]');
            if (power) power.title = t('loadout.power.tooltip');
            const pill = host.querySelector(`#${PILL_ID}`);
            if (pill) pill.title = t('loadout.pos.dragHint');
            this._refreshPowerBtn();
            this._refreshAutoPill();
            if (this._open) this._render();
        }

        _requestSnapshot() {
            this._setStatus(t('loadout.status.requesting'), '');
            if (typeof root.__cor3RequestLoadout === 'function') root.__cor3RequestLoadout();
            else this._setStatus(t('loadout.status.wsNotReady'), 'err');
        }

        _refreshPowerBtn() {
            const btn = document.querySelector(`#${PANEL_ID} [data-role="power"]`);
            if (!btn) return;
            btn.disabled = false;
            btn.classList.remove('on');
            if (this._powerState === true) {
                btn.textContent = t('loadout.power.on');
                btn.classList.add('on');
            } else if (this._powerState === false) {
                btn.textContent = t('loadout.power.off');
            } else {
                btn.textContent = '⏻';
            }
        }

        // ─── Mutations ────────────────────────────────────────────────
        // All hardware/software mutations ship as plain WS frames to the
        // cor3.gg "loadout" event channel. No native UI is touched.
        // Server responds with a full snapshot, which the interceptor
        // routes back through MSG.WS.LOADOUT and we re-render
        // automatically — no need to manually re-request after.
        _togglePower() {
            // POWER toggle is purely client-side on cor3.gg — just flip
            // the localStorage flag. The native app's React observable
            // doesn't share scope with us, so it won't auto-update its
            // own pill in the same tab; it'll catch up next remount.
            const current = readPowerLS();
            const next = current === true ? false : true;
            writePowerLS(next);
            this._powerState = next;
            this._refreshPowerBtn();
            this.info('power toggled (client-only)', { next });
        }

        _swapHardware(_category, hwId) {
            // Category is purely informational — the server resolves it
            // from the hardware id. We keep the arg for symmetry with
            // the panel's data-cat attribute and for logging.
            if (typeof root.__cor3LoadoutEquipHardware === 'function') {
                const hw = (this._snapshot.ownedHardware || []).find((h) => h.id === hwId);
                this._armMutationWatchdog('equip-hw', hwId, hw && hw.name);
                root.__cor3LoadoutEquipHardware(hwId);
                this.info('equip.hardware sent', { hwId });
            } else {
                this.warn('equip.hardware: WS helper missing');
            }
        }

        _toggleSoftware(swId) {
            const sw = (this._snapshot.ownedSoftware || []).find((s) => s.id === swId);
            if (!sw) { this.warn('toggle: sw not in snapshot', { swId }); return; }
            const equipped = (this._snapshot.equippedSoftware || []).some((e) => e.id === swId);
            if (equipped) {
                if (typeof root.__cor3LoadoutUnequipSoftware === 'function') {
                    this._armMutationWatchdog('unequip-sw', swId, sw.name);
                    root.__cor3LoadoutUnequipSoftware(swId);
                    this.info('unequip.software sent', { swId });
                } else { this.warn('unequip.software: WS helper missing'); }
                return;
            }
            // Pre-flight: would equipping this software exceed any
            // resource cap? If so, toast + abort — the server would
            // silently reject and the user would be confused.
            const issues = this._checkInstallFeasibility(sw);
            if (issues.length > 0) {
                this._showToast(
                    t('loadout.toast.notEnoughResources'),
                    'err',
                    t('loadout.toast.notEnoughResourcesBody', {
                        name: sw.name,
                        issues: issues.map((i) => i.label + ' +' + fmt(i.short) + ' ' + i.unit).join(', '),
                    })
                );
                return;
            }
            if (typeof root.__cor3LoadoutEquipSoftware === 'function') {
                this._armMutationWatchdog('equip-sw', swId, sw.name);
                root.__cor3LoadoutEquipSoftware(swId);
                this.info('equip.software sent', { swId });
            } else { this.warn('equip.software: WS helper missing'); }
        }

        // ─── Mutation watchdog ────────────────────────────────────────
        _armMutationWatchdog(kind, id, name) {
            if (this._pendingMutationTimer) clearTimeout(this._pendingMutationTimer);
            this._pendingMutation = { kind, id, name, ts: Date.now() };
            this._pendingMutationTimer = setTimeout(() => {
                if (!this._pendingMutation || this._pendingMutation.id !== id) return;
                this._showToast(
                    t('loadout.toast.serverNoReply'),
                    'warn',
                    t('loadout.toast.serverNoReplyBody', { name })
                );
                this._pendingMutation = null;
                this._pendingMutationTimer = null;
            }, 3000);
        }
        _reconcilePendingMutation() {
            const p = this._pendingMutation;
            if (!p) return;
            const snap = this._snapshot;
            const eqSw = new Set((snap.equippedSoftware || []).map((s) => s.id));
            const eqHw = new Set(
                Object.values(snap.equippedHardware || {})
                    .filter(Boolean)
                    .map((h) => h.id)
            );
            let success;
            if (p.kind === 'equip-sw')   success = eqSw.has(p.id);
            else if (p.kind === 'unequip-sw') success = !eqSw.has(p.id);
            else if (p.kind === 'equip-hw')   success = eqHw.has(p.id);
            else return;
            // Only RESOLVE on success. A snapshot that doesn't yet reflect the
            // mutation is NOT proof of failure — an unrelated/early loadout
            // frame (concurrent refresh, native-UI change, the headless Auto Jobs flow
            // driving the same helpers) can arrive before our change applies.
            // Leave the pending mutation armed: the watchdog timer fires the
            // no-reply toast if it never applies, and a later success snapshot
            // resolves it. Clearing here on a mismatch fired a spurious
            // "could not equip/swap" toast AND dropped reconciliation of the
            // real success snapshot.
            if (!success) return;
            if (this._pendingMutationTimer) { clearTimeout(this._pendingMutationTimer); this._pendingMutationTimer = null; }
            this._pendingMutation = null;
        }

        // ─── Pre-flight resource check ────────────────────────────────
        // Conservative floor-check: each consuming[key] is an array
        // [min, …, max] where the FIRST element is the minimum the
        // software needs to even start. The actual demand cor3.gg
        // reports is somewhere between first and last (varies by
        // resource — cpu_cores tends to sum the first element across
        // equipped sw, cpu_frequency tends to take the max of first
        // elements, ram_memory uses the middle when present). Mixing
        // those rules in JS is brittle; instead we use the FLOOR
        // (curDemand + sw.min) as a "if even THIS doesn't fit, the
        // server will definitely reject" gate. False negatives (server
        // rejects on something we passed) get caught by snapshot
        // diffing — see the post-mutation watchdog in _toggleSoftware.
        _checkInstallFeasibility(sw) {
            const r = this._snapshot && this._snapshot.resources;
            if (!r || !r.supply || !r.demand) return [];   // can't check
            const consuming = (sw && sw.consuming) || {};
            const RES_INFO = {
                cpu_frequency: { labelKey: 'loadout.resIssue.cpuFreq',    unit: 'GHz' },
                cpu_cores:     { labelKey: 'loadout.resIssue.cpuCores',   unit: '' },
                gpu_power:     { labelKey: 'loadout.resIssue.gpuPower',   unit: 'PFLOPS' },
                gpu_memory:    { labelKey: 'loadout.resIssue.gpuMemory',  unit: 'TB' },
                ram_frequency: { labelKey: 'loadout.resIssue.ramFreq',    unit: 'GHz' },
                ram_memory:    { labelKey: 'loadout.resIssue.ramMemory',  unit: 'TB' },
            };
            const issues = [];
            const rows = [];
            for (const key of Object.keys(consuming)) {
                const arr = consuming[key];
                if (!Array.isArray(arr) || arr.length === 0) continue;
                const delta = Number(arr[0]) || 0;
                const curD = Number(r.demand[key] ?? 0);
                const cap  = Number(r.supply[key] ?? 0);
                // 2-elt arrays (cpu_frequency, ram_frequency) are
                // [min_supply, max_supply] — shared across equipped sw,
                // so the post-install demand is max(curD, arr[0]),
                // not a sum. 3-elt arrays
                // ([per_install, min_supply, max_supply]) add to the
                // running demand.
                const rule = arr.length === 2 ? 'max' : 'sum';
                const newD = rule === 'max' ? Math.max(curD, delta) : curD + delta;
                const fits = newD <= cap + 1e-9;
                rows.push({
                    key,
                    consuming: arr,
                    'arr[0]': delta,
                    'curD(demand)': curD,
                    'cap(supply)': cap,
                    rule,
                    newD,
                    short: fits ? 0 : (newD - cap),
                    fits: fits ? 'OK' : 'FAIL',
                });
                if (!fits) {
                    const info = RES_INFO[key];
                    const label = info ? t(info.labelKey) : key;
                    const unit  = info ? info.unit : '';
                    issues.push({ key, label, unit, cap, newD, short: newD - cap });
                }
            }
            try {
                const tag = `[COR3 loadout pre-flight] ${sw && sw.name} (id=${sw && sw.id}) — ${issues.length === 0 ? 'PASS' : 'BLOCK (' + issues.length + ' issue' + (issues.length === 1 ? '' : 's') + ')'}`;
                console.groupCollapsed(tag);
                console.log('sw.consuming:', consuming);
                console.log('snapshot.resources.supply:', { ...r.supply });
                console.log('snapshot.resources.demand:', { ...r.demand });
                console.table(rows);
                if (issues.length > 0) {
                    console.warn('Blocking issues:', issues);
                    console.info('Floor-check rule: newD = curD + arr[0]. Real game may use MAX/middle/sum depending on key — if in-game install succeeds despite a BLOCK here, the floor-check is over-conservative.');
                }
                console.groupEnd();
            } catch (_) { /* DevTools console may be closed; non-fatal */ }
            return issues;
        }

        // ─── Programmatic API for Auto Jobs (headless, no UI) ──────────
        // Exposed via COR3.game.loadout so the file-decryption flow can ask
        // "can we decrypt <ext>?" and "make us able to" without driving the
        // panel UI. Reuses _checkInstallFeasibility + the __cor3Loadout* WS
        // helpers. No toasts, no i18n — pure logic + the supplied log fn.
        _equippedDecryptExts() {
            const exts = new Set();
            for (const sw of (this._snapshot && this._snapshot.equippedSoftware) || []) {
                for (const sp of (sw.specs || [])) {
                    if (sp && sp.type === 'DECRYPT' && Array.isArray(sp.fileTypes)) {
                        for (const e of sp.fileTypes) if (typeof e === 'string') exts.add(e.toLowerCase());
                    }
                }
            }
            return exts;
        }
        // ─── Loadout capability optimizer (headless, for Auto Jobs) ────────
        // VERIFIED-LIVE power model (reference_hack_power_model /
        // reference_decrypt_power_model, captured 2026-06-10):
        //   • a capability spec is { type, <matchKey>:[targets], power:[pmin,pmax] }
        //     (matchKey = fileTypes for DECRYPT, serverTypes for HACK/SEARCH).
        //   • software.consuming[res] is a band array. 2-elt [lo,hi]; 3-elt
        //     [floor,lo,hi]. BOOT floor (min supply to install) = arr[0]; the ratio
        //     band is (2-elt) [arr0,arr1] / (3-elt) [arr1,arr2].
        //   • per-resource ratio = clamp01((supply−lo)/(hi−lo)); the OVERALL ratio
        //     = MIN across the consuming resources (validated: not product/avg).
        //     supply for a resource comes from exactly ONE hardware slot
        //     (SLOT_SUPPLY); PSU is never a ratio input.
        //   • computedPower = floor(pmin + ratio·(pmax−pmin)) — the SAME ratio
        //     drives every ability; equals live softwarePower[].computedPower and
        //     sai hackTools[].hackPower (validated to the integer across configs).
        //   • canBoot needs every consuming res supply ≥ its floor AND the PSU to
        //     cover the draw: Σ(cpuConsuming+gpuConsuming) ≤ psu.psuPower.
        // _optimize enumerates owned software × cpu × gpu × ram × psu (a few hundred
        // combos) → provably optimal for the cost (fewest swaps from the current
        // rig → lowest tier → lowest vulnerability → most power). No tier-first
        // heuristics, no blind maxing.
        _consumingBands(sw) {
            const out = {};
            for (const [k, a] of Object.entries((sw && sw.consuming) || {})) {
                if (!Array.isArray(a) || !a.length) continue;
                if (a.length === 2)     out[k] = { floor: +a[0], lo: +a[0], hi: +a[1] };
                else if (a.length >= 3) out[k] = { floor: +a[0], lo: +a[1], hi: +a[2] };
                else                    out[k] = { floor: +a[0], lo: +a[0], hi: +a[0] };
            }
            return out;
        }
        // Supply per consuming-resource from a {cpu,gpu,ram,psu} hardware pick.
        _supplyOf(hw) {
            const s = {};
            for (const slot of HW_SLOTS) {
                const piece = hw[slot];
                for (const { supplyKey, specKey } of SLOT_SUPPLY[slot]) {
                    s[supplyKey] = piece && piece.specs ? (Number(piece.specs[specKey]) || 0) : 0;
                }
            }
            return s;
        }
        // PSU draw of a hardware pick — derived from SLOT_DEMAND (the single source
        // of which slot.spec feeds psu_total) so the formula isn't re-encoded here.
        _psuDraw(hw) {
            let draw = 0;
            for (const [slot, { demandKey, specKey }] of Object.entries(SLOT_DEMAND)) {
                if (demandKey !== 'psu_total') continue;
                const piece = hw[slot];
                if (piece && piece.specs) draw += Number(piece.specs[specKey]) || 0;
            }
            return draw;
        }
        // PSU draws of the cpu↔gpu swap TRANSITION from (curCpu,curGpu) to
        // (cpu,gpu): the peak draw along each one-slot-at-a-time order, floored
        // by the final draw. ONE formula shared by the optimizer's feasibility
        // pre-check and _applyHwConfig's headroom/ordering decision — the two
        // MUST agree, or the optimizer would pick configs the applier can't
        // physically reach (the server rejects over-draw equips).
        _transitionDraws(curCpu, curGpu, cpu, gpu) {
            const targetDraw = this._psuDraw({ cpu, gpu });
            return {
                targetDraw,
                cpuFirst: Math.max(this._psuDraw({ cpu, gpu: curGpu }), targetDraw),
                gpuFirst: Math.max(this._psuDraw({ cpu: curCpu, gpu }), targetDraw),
            };
        }
        // Overall feed ratio on `supply` = min component ratio (clamped). `bands` is
        // the precomputed _consumingBands(sw) (hoisted out of the hw loop by callers).
        _ratioFor(bands, supply) {
            let r = 1;
            for (const [res, b] of Object.entries(bands)) {
                const sup = supply[res];
                if (sup === undefined) continue;   // resource not fed by any known slot
                const span = b.hi - b.lo;
                const cr = span <= 0 ? (sup >= b.floor ? 1 : 0) : Math.max(0, Math.min(1, (sup - b.lo) / span));
                if (cr < r) r = cr;
            }
            return r;
        }
        // Does a tool with these consuming `bands` boot on `supply` (every res ≥ floor)?
        _bootableOn(bands, supply) {
            for (const [res, b] of Object.entries(bands)) {
                const sup = supply[res];
                if (sup !== undefined && sup < b.floor) return false;
            }
            return true;
        }
        // Does a spec provide `capType` covering `target` (by its matchKey list)?
        _specCovers(spec, capType, matchKey, target) {
            const t = String(target || '').toLowerCase();
            return !!spec && spec.type === capType && Array.isArray(spec[matchKey])
                && spec[matchKey].some((x) => String(x).toLowerCase() === t);
        }
        // The spec on `sw` that provides `capType` for `target`, or null.
        _coveringSpec(sw, capType, matchKey, target) {
            return (sw.specs || []).find((sp) => this._specCovers(sp, capType, matchKey, target)) || null;
        }
        // computedPower a spec yields at `ratio`. null if the spec carries no band.
        _powerFromSpec(spec, ratio) {
            if (!spec || !Array.isArray(spec.power) || spec.power.length < 2) return null;
            const lo = Number(spec.power[0]), hi = Number(spec.power[spec.power.length - 1]);
            if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
            return Math.floor(lo + ratio * (hi - lo));
        }
        // Owned hardware grouped by slot (includes the currently-equipped pieces —
        // the snapshot's ownedHardware lists equipped items too).
        _ownedBySlot() {
            const out = {};
            for (const slot of HW_SLOTS) out[slot] = [];
            for (const h of ((this._snapshot && this._snapshot.ownedHardware) || [])) {
                for (const slot of HW_SLOTS) if (h.category === slot.toUpperCase()) out[slot].push(h);
            }
            return out;
        }
        // Live server-computed power of the currently-equipped covering tool for
        // `target` (the real number, accounts for whatever else is equipped), or
        // null if nothing equipped covers it.
        _equippedPowerFor(capType, matchKey, target) {
            let best = null;
            for (const sw of ((this._snapshot && this._snapshot.equippedSoftware) || [])) {
                if (!this._coveringSpec(sw, capType, matchKey, target)) continue;
                const cp = this._computedPowerFor(sw.id, capType);
                if (cp != null) best = Math.max(best == null ? -Infinity : best, cp);
            }
            return best;
        }
        // Exhaustively find the optimal { sw, hw } to reach `need` power for
        // `target`, dedicating the rig to ONE tool. Returns:
        //   { status:'apply', sw, spec, hw, power, swaps }  feasible config reaches need
        //   { status:'underpower', maxPower, sw, hw }       owns covering SW, none reaches
        //   { status:'none' }                               no owned SW covers target
        //   { status:'unknown' }                            no snapshot / incomplete inventory
        _optimize(capType, matchKey, target, need) {
            if (!this._snapshot) return { status: 'unknown' };
            const owned = this._ownedBySlot();
            if (!owned.cpu.length || !owned.gpu.length || !owned.ram.length || !owned.psu.length) return { status: 'unknown' };
            const swCands = ((this._snapshot.ownedSoftware) || [])
                .map((sw) => ({ sw, spec: this._coveringSpec(sw, capType, matchKey, target) }))
                .filter((c) => c.spec);
            if (!swCands.length) return { status: 'none' };

            const curHw = this._snapshot.equippedHardware || {};
            const curSw = new Set(((this._snapshot.equippedSoftware) || []).map((s) => s.id));
            const swapCount = (sw, hw) => {
                let n = curSw.has(sw.id) ? 0 : 1;
                for (const slot of HW_SLOTS) if (!curHw[slot] || curHw[slot].id !== hw[slot].id) n++;
                return n;
            };
            const tierSum = (sw, hw) => (Number(sw.tier) || 0)
                + HW_SLOTS.reduce((t, s) => t + (Number(hw[s].tier) || 0), 0);
            const vulnSum = (hw) => HW_SLOTS.reduce((v, s) => v + (Number(hw[s].itemVulnerability) || 0), 0);
            // Lower cost is better: fewest swaps → lowest tier → lowest vulnerability
            // → (tie) more power. A band-less tool (power=Infinity sentinel) is treated
            // as LOWEST preference on the power tie-break — prefer a known-banded tool.
            const pw = (c) => c.power === Infinity ? -1 : c.power;
            const better = (a, b) => a.swaps !== b.swaps ? a.swaps < b.swaps
                : a.tier !== b.tier ? a.tier < b.tier
                : a.vuln !== b.vuln ? a.vuln < b.vuln
                : pw(a) > pw(b);
            // Strongest owned PSU — the most headroom any transition can be given.
            const maxPsuPower = owned.psu.reduce((m, p) => Math.max(m, Number(p.specs && p.specs.psuPower) || 0), 0);
            const curCpu = curHw.cpu, curGpu = curHw.gpu;

            let best = null, maxAny = null;
            for (const { sw, spec } of swCands) {
                const bands = this._consumingBands(sw);   // invariant across the hw loop
                for (const cpu of owned.cpu) for (const gpu of owned.gpu) {
                    // PSU draw + transition feasibility depend only on (cpu,gpu) —
                    // computed once per pair, not per ram×psu combo. Reject pairs
                    // whose mid-swap TRANSITION peak no owned PSU can power (the
                    // server rejects over-draw equips, so such a config can never
                    // be physically applied — _applyHwConfig would never converge).
                    const trans = this._transitionDraws(curCpu, curGpu, cpu, gpu);
                    if (Math.min(trans.cpuFirst, trans.gpuFirst) > maxPsuPower + 1e-9) continue;
                    for (const ram of owned.ram) for (const psu of owned.psu) {
                        if (trans.targetDraw > (Number(psu.specs && psu.specs.psuPower) || 0) + 1e-9) continue;
                        const hw = { cpu, gpu, ram, psu };
                        const supply = this._supplyOf(hw);
                        if (!this._bootableOn(bands, supply)) continue;
                        const p = this._powerFromSpec(spec, this._ratioFor(bands, supply));
                        const cand = { sw, spec, hw, power: p == null ? Infinity : p,
                            swaps: swapCount(sw, hw), tier: tierSum(sw, hw), vuln: vulnSum(hw) };
                        // maxAny (the "best achievable" diagnostic) tracks only FINITE
                        // powers — a band-less Infinity must not shadow a real banded ceiling.
                        if (p != null && (maxAny == null || p > maxAny.power)) maxAny = { sw, hw, power: p };
                        const reaches = need <= 0 || (p != null && p >= need);
                        if (reaches && (best == null || better(cand, best))) best = cand;
                    }
                }
            }
            if (best) return { status: 'apply', sw: best.sw, spec: best.spec, hw: best.hw,
                power: best.power === Infinity ? null : best.power, swaps: best.swaps };
            return { status: 'underpower', sw: maxAny && maxAny.sw, hw: maxAny && maxAny.hw,
                maxPower: maxAny ? maxAny.power : null };
        }
        // Plan a capability: 'ready' (current rig already clears it — live-checked,
        // so multi-tool resource sharing is accounted for) else delegate to the
        // exhaustive optimizer ('apply'/'underpower'/'none'/'unknown').
        _planCapability(capType, matchKey, target, need) {
            if (!this._snapshot) return { status: 'unknown' };
            const livePow = this._equippedPowerFor(capType, matchKey, target);
            if (livePow != null && (need <= 0 || livePow >= need)) return { status: 'ready', power: livePow };
            // Cache the (exhaustive) optimizer result keyed by snapshot identity, so a
            // planX immediately followed by ensureX on the same snapshot runs it ONCE.
            // The snapshot object is replaced wholesale on every loadout WS frame, so
            // identity is a sound cache key (the cache auto-invalidates on any change).
            const key = `${capType}|${String(target || '').toLowerCase()}|${need}`;
            if (!this._optCache || this._optCache.snap !== this._snapshot) this._optCache = { snap: this._snapshot, map: new Map() };
            if (this._optCache.map.has(key)) return this._optCache.map.get(key);
            const r = this._optimize(capType, matchKey, target, need);
            this._optCache.map.set(key, r);
            return r;
        }
        // Map an optimizer plan onto the legacy { status, sw } shape the flows log /
        // gate a UI node on (ready | install | swap | underpower | none | unknown).
        _toLegacyPlan(r) {
            if (!r || r.status === 'unknown') return { status: 'unknown' };
            if (r.status === 'ready' || r.status === 'none') return { status: r.status };
            if (r.status === 'underpower') return { status: 'underpower', maxPower: r.maxPower };
            // 'swap' = the apply will change hardware OR free other equipped software
            // (the rig is always dedicated to the chosen tool); 'install' = nothing
            // else moves. Both light the same UI node — the label is for the log.
            const cur = this._snapshot.equippedHardware || {};
            const hwChanges = HW_SLOTS.some((s) => !cur[s] || !r.hw || cur[s].id !== r.hw[s].id);
            const freesOther = ((this._snapshot.equippedSoftware) || []).some((s) => !r.sw || s.id !== r.sw.id);
            return { status: (hwChanges || freesOther) ? 'swap' : 'install', sw: r.sw, hw: r.hw, power: r.power };
        }
        // Apply a hardware config with the MINIMAL number of equips. The server
        // REJECTS any equip that transiently over-draws the PSU (verified live), so
        // CPU/GPU are swapped in the lower-draw-first order, and a higher-wattage
        // PSU is inserted FIRST only when the current one can't cover the transition
        // (Σ cpuConsuming+gpuConsuming). RAM draws no PSU power → swapped freely. The
        // target PSU is settled last, once the draw is final.
        // Returns true iff every target slot is actually equipped afterwards (a
        // rejected/late equip → false, so the caller can RETRY rather than mistake a
        // partial rig for a power shortfall).
        async _applyHwConfig(target, say) {
            if (typeof root.__cor3LoadoutEquipHardware !== 'function') return false;
            const eq = () => this._snapshot.equippedHardware || {};
            const eqId = (slot) => { const h = eq()[slot]; return h && h.id; };
            const psuP = (p) => Number(p && p.specs && p.specs.psuPower) || 0;
            const swap = async (slot, want) => {
                if (!want || eqId(slot) === want.id) return true;
                say('info', `equipping ${slot.toUpperCase()} → "${want.name}"`);
                root.__cor3LoadoutEquipHardware(want.id);
                return this._waitHardwareEquipped(want.id, 6000);
            };
            await swap('ram', target.ram);   // no PSU draw — free to move first
            if ((target.cpu && eqId('cpu') !== target.cpu.id) || (target.gpu && eqId('gpu') !== target.gpu.id)) {
                const trans = this._transitionDraws(eq().cpu, eq().gpu, target.cpu, target.gpu);
                const headroom = Math.min(trans.cpuFirst, trans.gpuFirst);
                const seq = trans.cpuFirst <= trans.gpuFirst ? ['cpu', 'gpu'] : ['gpu', 'cpu'];
                // Insert PSU headroom ONLY if the current PSU can't cover the swap.
                if (psuP(eq().psu) + 1e-9 < headroom) {
                    const owned = this._ownedBySlot();
                    const pre = (target.psu && psuP(target.psu) + 1e-9 >= headroom) ? target.psu
                        : owned.psu.slice().sort((a, b) => psuP(b) - psuP(a))[0];
                    await swap('psu', pre);
                }
                // Converge CPU+GPU (idempotent; a couple of passes clear any
                // transient over-draw rejection in the lower-draw-first order).
                for (let pass = 0; pass < 3 && ((target.cpu && eqId('cpu') !== target.cpu.id) || (target.gpu && eqId('gpu') !== target.gpu.id)); pass++) {
                    for (const slot of seq) await swap(slot, target[slot]);
                }
            }
            await swap('psu', target.psu);   // settle the target PSU last
            return HW_SLOTS.every((slot) => !target[slot] || eqId(slot) === target[slot].id);
        }
        // Execute an optimizer 'apply' plan: dedicate the rig to the chosen tool,
        // apply its optimal hardware, equip it, then VERIFY the live power clears
        // the bar (the predictor is exact, but never trust a write blindly).
        async _applyOptimized(plan, capType, matchKey, target, need, say) {
            // Both WS helpers must exist BEFORE we tear the rig down — checked up
            // front so a missing hardware helper is a clean transient 'no-helper',
            // not a half-stripped rig + a false permanent verdict.
            if (typeof root.__cor3LoadoutEquipSoftware !== 'function' || typeof root.__cor3LoadoutEquipHardware !== 'function')
                return { ok: false, status: 'no-helper', transient: true, reason: 'equip-helper-missing' };
            const { sw, hw } = plan;
            await this._freeAllSoftwareExcept(sw.id, say);
            // An equip that didn't take effect (transient over-draw rejection, WS /
            // snapshot lag, or a transition no PSU can power) is RETRYABLE — never let
            // a partial rig masquerade as a permanent 'underpower' that bugs a
            // feasible job. Permanent 'underpower' is the optimizer's pre-apply
            // verdict (handled in _ensureCapability), not an apply-time miss.
            if (!await this._applyHwConfig(hw, say)) {
                say('warn', `hardware for "${sw.name}" did not fully apply — retrying next cycle`);
                return { ok: false, status: 'apply-incomplete', transient: true, reason: 'hardware-not-applied' };
            }
            if (!this._isEquipped(sw.id)) {
                root.__cor3LoadoutEquipSoftware(sw.id);
                if (!await this._waitEquipped(sw.id, true, 8000)) {
                    say('warn', `install of "${sw.name}" did not take effect — retrying next cycle`);
                    return { ok: false, status: 'apply-incomplete', transient: true, reason: 'install-not-applied' };
                }
            }
            if (need <= 0) return { ok: true, status: 'applied', power: this._equippedPowerFor(capType, matchKey, target) };
            // Poll the live server-computed power: equippedSoftware membership can update
            // a frame before resources.softwarePower recomputes, so a single read may be
            // null/stale. Settle before judging — the loop re-reads once more AFTER the
            // final sleep so a value landing in that last window isn't missed.
            let live = null;
            const end = Date.now() + 4000;
            for (;;) {
                live = this._equippedPowerFor(capType, matchKey, target);
                if (live != null && live >= need) return { ok: true, status: 'applied', power: live };
                if (Date.now() >= end) break;
                await dom.sleep(300);
            }
            // live === null at timeout means the power never became READABLE — the
            // softwarePower recompute is still in flight (snapshot lag), NOT a power
            // verdict. Transient: retry next cycle instead of bugging a feasible job.
            if (live == null) {
                say('warn', `applied "${sw.name}" but its live ${capType} power never appeared in the snapshot — retrying next cycle`);
                return { ok: false, status: 'apply-incomplete', transient: true, reason: 'live-power-not-readable' };
            }
            // The optimal config IS fully applied and READS a number short of the bar —
            // the prediction diverged for this exact config, so retrying it is futile →
            // genuine permanent shortfall (the optimizer already enumerated every
            // alternative).
            say('warn', `applied "${sw.name}" (optimal config) but live power ${live} < required ${need}`);
            return { ok: false, status: 'underpower', transient: false, reason: `power-unreachable:${target}:${need}` };
        }
        // Shared ensure: plan → (ready/none/underpower/unknown short-circuit) →
        // apply the optimal config. Used by apiEnsureDecrypt / apiEnsureHack.
        async _ensureCapability(capType, matchKey, target, need, say) {
            const verb = capType === 'HACK' ? 'hack' : capType === 'DECRYPT' ? 'decrypt' : capType.toLowerCase();
            const plan = this._planCapability(capType, matchKey, target, need);
            if (plan.status === 'ready')      { say('info', `loadout already ${verb}s ${target}${need ? ` (power ≥ ${need})` : ''}`); return { ok: true, status: 'ready', power: plan.power }; }
            if (plan.status === 'unknown')    { say('warn', 'loadout snapshot still not loaded after request'); return { ok: false, status: 'unknown', transient: true, reason: 'no-loadout-snapshot' }; }
            if (plan.status === 'none')       { say('warn', `no owned software can ${verb} ${target}`); return { ok: false, status: 'none', transient: false, reason: `no-software:${capType}:${target}` }; }
            if (plan.status === 'underpower') { say('warn', `no owned software+hardware can ${verb} ${target} at power ${need} (best achievable ${plan.maxPower})`); return { ok: false, status: 'underpower', transient: false, reason: `power-too-high:${target}:${need}`, maxPower: plan.maxPower }; }
            say('info', `optimal loadout to ${verb} ${target}${need ? ` (need ${need})` : ''}: "${plan.sw.name}" on [${plan.hw.cpu.name} · ${plan.hw.gpu.name} · ${plan.hw.ram.name} · ${plan.hw.psu.name}] → predicted power ${plan.power} (${plan.swaps} swap${plan.swaps === 1 ? '' : 's'})`);
            return this._applyOptimized(plan, capType, matchKey, target, need, say);
        }
        // The server-computed DECRYPT/HACK/SEARCH power of an EQUIPPED software,
        // from resources.softwarePower (depends on the equipped hardware feeding
        // it — `computedPower ≈ pmin + ratio·(pmax−pmin)`). null if not equipped /
        // no such ability. This is the number the game compares against a file's
        // CRYPT RATE.
        _computedPowerFor(swId, capType) {
            const list = (this._snapshot && this._snapshot.resources && this._snapshot.resources.softwarePower) || [];
            const sp = list.find((p) => p && p.moduleId === swId);
            if (!sp || !Array.isArray(sp.abilities)) return null;
            const ab = sp.abilities.find((a) => a && a.type === capType);
            return (ab && Number.isFinite(Number(ab.computedPower))) ? Number(ab.computedPower) : null;
        }
        // ── Public capability API (DECRYPT by fileTypes, HACK by serverTypes) ──
        // planX → legacy { status, sw } for the flow's log + UI-node gate;
        // ensureX applies the OPTIMAL owned software+hardware combination.
        apiPlanDecrypt(ext, requiredPower) {
            return this._toLegacyPlan(this._planCapability('DECRYPT', 'fileTypes', ext, Number(requiredPower) || 0));
        }
        _isEquipped(id) {
            return ((this._snapshot && this._snapshot.equippedSoftware) || []).some((s) => s.id === id);
        }
        async _waitEquipped(id, want, deadlineMs) {
            const end = Date.now() + deadlineMs;
            while (Date.now() < end) {
                if (this._isEquipped(id) === want) return true;
                await dom.sleep(300);
            }
            return this._isEquipped(id) === want;
        }
        // Ensure the loadout snapshot is loaded — the headless plan/ensure API
        // needs it. If it isn't in yet (the user never opened the Loadout panel
        // this session), REQUEST it over WS (join-room loadout → loadout/get.options
        // → MSG.WS.LOADOUT → this._snapshot) and wait, instead of bailing with
        // 'no-loadout-snapshot'. So ensureDecrypt/ensureHack — and thus the Auto Jobs
        // flows + the SAI bridge — work without manually warming the panel.
        async _ensureSnapshot(timeoutMs, log) {
            if (this._snapshot) return true;
            const say = typeof log === 'function' ? log : () => {};
            if (typeof root.__cor3RequestLoadout !== 'function') return false;
            say('info', 'loadout snapshot not loaded — requesting it over WS');
            root.__cor3RequestLoadout();
            const end = Date.now() + (timeoutMs || 8000);
            while (Date.now() < end && !this._snapshot) await dom.sleep(250);
            return !!this._snapshot;
        }
        // Unequip every equipped software EXCEPT `keepId` — dedicates all
        // hardware to one tool, maximising its server-computed power (ratio).
        async _freeAllSoftwareExcept(keepId, say) {
            if (typeof root.__cor3LoadoutUnequipSoftware !== 'function') return;
            for (const sw of ((this._snapshot && this._snapshot.equippedSoftware) || []).slice()) {
                if (sw.id === keepId) continue;
                say('info', `freeing resources — unequipping "${sw.name}"`);
                root.__cor3LoadoutUnequipSoftware(sw.id);
                await this._waitEquipped(sw.id, false, 6000);
            }
        }
        async _waitHardwareEquipped(id, deadlineMs) {
            const isEq = () => Object.values((this._snapshot && this._snapshot.equippedHardware) || {})
                .some((h) => h && h.id === id);
            const end = Date.now() + deadlineMs;
            while (Date.now() < end) { if (isEq()) return true; await dom.sleep(300); }
            return isEq();
        }
        // Make the loadout able to decrypt `ext` at `requiredPower` (the file's
        // CRYPT RATE), OPTIMALLY — the exhaustive optimizer picks the best owned
        // software + hardware. Resolves to
        //   { ok:true,  status:'ready'|'applied', power }
        //   { ok:false, status:'none'|'underpower'|'unknown'|'no-helper'|'apply-incomplete',
        //     transient, reason }
        // `transient` is the retry verdict the flows act on: false for
        // 'none'/'underpower' (PERMANENT — the orchestrator bugs the job), true
        // for 'unknown'/'no-helper'/'apply-incomplete' (retry next cycle).
        // Back-compat: an old (ext, log) call (log fn in arg 2) ⇒ no power gate.
        async apiEnsureDecrypt(ext, requiredPower, log) {
            if (typeof requiredPower === 'function' && log === undefined) { log = requiredPower; requiredPower = 0; }
            const say = typeof log === 'function' ? log : () => {};
            await this._ensureSnapshot(8000, say);   // auto-fetch the snapshot if not warmed yet
            return this._ensureCapability('DECRYPT', 'fileTypes', String(ext || '').toLowerCase(), Number(requiredPower) || 0, say);
        }

        // _equippedHackTypes — server TYPEs any equipped HACK tool covers (drives
        // the `hackServerTypes` export used by Auto Jobs eligibility). Power-aware
        // planning/ensuring for HACK lives in the shared optimizer above; the
        // target is a server TYPE (e.g. "SOYUZ public") and `requiredPower` is the
        // server's `serverDefenceRate` (from sai get.login.status) — the bar the
        // equipped tool's `hackPower` must clear. See reference_hack_power_model.
        _equippedHackTypes() {
            const types = new Set();
            for (const sw of (this._snapshot && this._snapshot.equippedSoftware) || []) {
                for (const sp of (sw.specs || [])) {
                    if (sp && sp.type === 'HACK' && Array.isArray(sp.serverTypes)) {
                        for (const st of sp.serverTypes) if (typeof st === 'string') types.add(st.toLowerCase());
                    }
                }
            }
            return types;
        }
        apiPlanHack(serverType, requiredPower) {
            return this._toLegacyPlan(this._planCapability('HACK', 'serverTypes', serverType, Number(requiredPower) || 0));
        }
        // Make the loadout able to hack `serverType` at `requiredPower` (the
        // server's serverDefenceRate), OPTIMALLY. Same result shape as
        // apiEnsureDecrypt. Back-compat: (serverType, log) ⇒ no gate.
        async apiEnsureHack(serverType, requiredPower, log) {
            if (typeof requiredPower === 'function' && log === undefined) { log = requiredPower; requiredPower = 0; }
            const say = typeof log === 'function' ? log : () => {};
            await this._ensureSnapshot(8000, say);   // auto-fetch the snapshot if not warmed yet
            return this._ensureCapability('HACK', 'serverTypes', serverType, Number(requiredPower) || 0, say);
        }

        // ─── Capability chip click: equip cheapest available ──────────
        _installCheapestForCapability(capType) {
            const owned   = this._snapshot.ownedSoftware   || [];
            const equipped= new Set((this._snapshot.equippedSoftware || []).map((s) => s.id));
            // Candidates: owned but not equipped, with at least one
            // spec providing the target capability.
            const candidates = owned
                .filter((sw) => !equipped.has(sw.id))
                .filter((sw) => (sw.specs || []).some((sp) => sp && sp.type === capType))
                .sort((a, b) => (Number(a.price) || 0) - (Number(b.price) || 0));
            if (candidates.length === 0) {
                this._showToast(
                    t('loadout.toast.noSoftwareWith', { cap: capType }),
                    'warn',
                    t('loadout.toast.noSoftwareWithBody')
                );
                return;
            }
            // Walk through cheapest → most expensive, find the first
            // that passes pre-flight. This way "click on red DECRYPT"
            // doesn't silently fail if the very cheapest item is too
            // resource-hungry for the current loadout.
            for (const sw of candidates) {
                const issues = this._checkInstallFeasibility(sw);
                if (issues.length === 0) {
                    if (typeof root.__cor3LoadoutEquipSoftware === 'function') {
                        this._armMutationWatchdog('equip-sw', sw.id, sw.name);
                        root.__cor3LoadoutEquipSoftware(sw.id);
                        this._showToast(
                            t('loadout.toast.installing'),
                            'ok',
                            t('loadout.toast.installingBody', { name: sw.name, cap: capType })
                        );
                        this.info('install cheapest cap', { capType, name: sw.name, price: sw.price });
                    }
                    return;
                }
            }
            // Nothing fits — explain why with the cheapest candidate's shortfalls.
            const issues = this._checkInstallFeasibility(candidates[0]);
            const need = issues.map((i) => i.label + ' +' + fmt(i.short) + ' ' + i.unit).join(', ');
            this._showToast(
                t('loadout.toast.capNotFits', { cap: capType }),
                'err',
                t('loadout.toast.capNotFitsBody', { cap: capType, name: candidates[0].name, need })
            );
        }

        // ─── Capability-target chooser ────────────────────────────────
        // Clicking a target (e.g. ".eb54x" or "CEDRT private") in the
        // CAPABILITIES breakdown opens a list of EVERY owned software that
        // provides that exact target so the user picks which to equip / unequip.
        _openCapChooser(cap, tgt) {
            this._chooser = { cap, tgt };
            this._renderChooser();
        }
        _closeCapChooser() {
            this._chooser = null;
            const el = document.querySelector(`#${PANEL_ID} [data-role="chooser"]`);
            if (el) el.remove();
        }
        // Software (owned) providing `cap` on the exact `tgt`.
        _swProviding(cap, tgt) {
            const tgtL = String(tgt || '').toLowerCase();
            const match = (sp) => sp && sp.type === cap && specTargets(sp).some((x) => String(x).toLowerCase() === tgtL);
            const equipped = new Set(((this._snapshot && this._snapshot.equippedSoftware) || []).map((s) => s.id));
            return ((this._snapshot && this._snapshot.ownedSoftware) || [])
                .filter((sw) => (sw.specs || []).some(match))
                .sort((a, b) => (equipped.has(b.id) ? 1 : 0) - (equipped.has(a.id) ? 1 : 0)
                    || (Number(a.tier) || 0) - (Number(b.tier) || 0)
                    || (Number(a.price) || 0) - (Number(b.price) || 0));
        }
        _renderChooser() {
            const panel = document.getElementById(PANEL_ID);
            if (!panel) return;
            let el = panel.querySelector('[data-role="chooser"]');
            if (!this._chooser || !this._snapshot) { if (el) el.remove(); return; }
            const { cap, tgt } = this._chooser;
            const tgtL = String(tgt || '').toLowerCase();
            const equipped = new Set((this._snapshot.equippedSoftware || []).map((s) => s.id));
            const match = (sp) => sp && sp.type === cap && specTargets(sp).some((x) => String(x).toLowerCase() === tgtL);
            const cands = this._swProviding(cap, tgt);
            const rows = cands.map((sw) => {
                const sp = (sw.specs || []).find(match);
                const max = Array.isArray(sp && sp.power) && sp.power.length ? sp.power[sp.power.length - 1] : null;
                const isEq = equipped.has(sw.id);
                const comp = isEq ? this._computedPowerFor(sw.id, cap) : null;
                const powTxt = (comp != null && max != null) ? `${comp}/${max}` : powerBand(sp);
                const verb = isEq ? t('loadout.verb.unequipSw') : t('loadout.verb.equipSw');
                return `
                    <div class="cor3-lp-chooser-row ${isEq ? 'equipped' : ''}" data-role="chooser-row" data-sw="${sw.id}">
                        ${sw.image ? `<img src="${sw.image}" alt="">` : ''}
                        <div class="cor3-lp-chooser-body">
                            <div class="cor3-lp-chooser-name">${escapeHtml(sw.name)} ${tierBadge(sw.tier)}</div>
                            <div class="cor3-lp-chooser-meta">${escapeHtml(cap)} ${powTxt ? escapeHtml(String(powTxt)) : ''}${isEq ? ` · ${escapeHtml(t('loadout.cap.equipped'))}` : ''}</div>
                        </div>
                        <button class="cor3-lp-prog-toggle ${isEq ? 'uninstall' : 'install'}" data-role="chooser-row" data-sw="${sw.id}">${isEq ? '−' : '+'}</button>
                    </div>`;
            }).join('') || `<div class="cor3-lp-opt-empty">${escapeHtml(t('loadout.cap.noProviders'))}</div>`;
            const html = `
                <div class="cor3-lp-chooser-head">
                    <span class="cor3-lp-chooser-title">${escapeHtml(t('loadout.cap.chooseTitle', { cap, tgt }))}</span>
                    <button class="cor3-lp-chooser-close" data-role="chooser-close" title="${escapeHtml(t('loadout.cap.close'))}">✕</button>
                </div>
                <div class="cor3-lp-chooser-list">${rows}</div>`;
            if (!el) {
                el = document.createElement('div');
                el.className = 'cor3-lp-chooser';
                el.setAttribute('data-role', 'chooser');
                el.addEventListener('click', (e) => {
                    if (e.target.closest('[data-role="chooser-close"]')) { this._closeCapChooser(); return; }
                    const row = e.target.closest('[data-role="chooser-row"]');
                    if (row) { this._toggleSoftware(row.getAttribute('data-sw')); /* snapshot re-render refreshes rows */ }
                });
                panel.appendChild(el);
            }
            el.innerHTML = html;
        }

        // ─── Toasts ───────────────────────────────────────────────────
        _showToast(title, severity, text) {
            const wrap = document.querySelector(`#${HOST_ID} [data-role="toasts"]`);
            if (!wrap) return;
            const t = document.createElement('div');
            t.className = 'cor3-lp-toast ' + (severity || 'ok');
            const id = ++this._toastSeq;
            t.dataset.id = String(id);
            const titleEsc = escapeHtml(title);
            const textEsc  = text ? escapeHtml(text) : '';
            t.innerHTML = `<div class="cor3-lp-toast-title">${titleEsc}</div>${textEsc ? `<div class="cor3-lp-toast-text">${textEsc}</div>` : ''}`;
            t.addEventListener('click', () => this._dismissToast(t));
            wrap.appendChild(t);
            setTimeout(() => this._dismissToast(t), TOAST_DURATION_MS);
        }
        _dismissToast(t) {
            if (!t || !t.parentNode) return;
            if (t.classList.contains('cor3-lp-toast-leaving')) return;
            t.classList.add('cor3-lp-toast-leaving');
            setTimeout(() => { try { t.remove(); } catch(_) {} }, 220);
        }

        // ─── Event delegation ─────────────────────────────────────────
        _onBodyClick(e) {
            const capTgt = e.target.closest('[data-role="cap-tgt"]');
            if (capTgt) {
                this._openCapChooser(capTgt.getAttribute('data-cap'), capTgt.getAttribute('data-tgt'));
                return;
            }
            const cap = e.target.closest('[data-role="cap"]');
            if (cap) {
                const capType = cap.getAttribute('data-cap');
                const status  = cap.getAttribute('data-status');   // have | missing | unowned
                // Have: maybe show what's providing it (not now). Unowned: dead.
                // Missing: install cheapest viable.
                if (status === 'missing') this._installCheapestForCapability(capType);
                else if (status === 'unowned') this._showToast(
                    t('loadout.toast.noSoftwareWith', { cap: capType }),
                    'warn',
                    t('loadout.toast.installFirstBody')
                );
                return;
            }
            const slotHead = e.target.closest('[data-role="slot-head"]');
            if (slotHead) {
                const cat = slotHead.getAttribute('data-cat');
                this._openSlot = (this._openSlot === cat) ? null : cat;
                this._hoveringHwId = null;
                this._render();
                return;
            }
            const opt = e.target.closest('[data-role="opt"]');
            if (opt) {
                const cat = opt.getAttribute('data-cat');
                const hwId = opt.getAttribute('data-hw');
                this._swapHardware(cat, hwId);
                return;
            }
            const prog = e.target.closest('[data-role="prog-toggle"]');
            if (prog) {
                const swId = prog.getAttribute('data-sw');
                this._toggleSoftware(swId);
                return;
            }
        }

        _onBodyHover(e, enter) {
            const opt = e.target.closest('[data-role="opt"]');
            if (!opt) return;
            const hwId = opt.getAttribute('data-hw');
            const next = enter ? hwId : null;
            if (next === this._hoveringHwId) return;
            this._hoveringHwId = next;
            this._renderBars();   // only the bars need to update on hover
        }

        // ─── Status helpers ───────────────────────────────────────────
        _setStatus(text, klass) {
            const el = document.querySelector(`#${PANEL_ID} [data-role="status"]`);
            if (!el) return;
            el.textContent = text;
            el.classList.remove('ok','warn','err');
            if (klass) el.classList.add(klass);
        }
        _setUpdated() {
            const el = document.querySelector(`#${PANEL_ID} [data-role="updated"]`);
            if (!el) return;
            const d = new Date();
            const hh = String(d.getHours()).padStart(2,'0');
            const mm = String(d.getMinutes()).padStart(2,'0');
            const ss = String(d.getSeconds()).padStart(2,'0');
            el.textContent = t('loadout.updatedAt', { time: `${hh}:${mm}:${ss}` });
        }

        // ─── Hover delta math ─────────────────────────────────────────
        // Produces { supply: {key: newVal,...}, demand: {key: newVal,...} }
        // when a candidate HW would replace the current slot, else null.
        _previewResources() {
            if (!this._hoveringHwId || !this._snapshot) return null;
            const r = this._snapshot.resources;
            if (!r || !r.supply || !r.demand) return null;
            const all = this._snapshot.ownedHardware || [];
            const hovered = all.find((h) => h.id === this._hoveringHwId);
            if (!hovered) return null;
            const cat = (hovered.category || '').toLowerCase();
            const equipped = (this._snapshot.equippedHardware || {})[cat];
            if (!equipped) return null;
            const supply = { ...r.supply };
            const demand = { ...r.demand };
            for (const m of (SLOT_SUPPLY[cat] || [])) {
                const before = (equipped.specs || {})[m.specKey] ?? 0;
                const after  = (hovered.specs  || {})[m.specKey] ?? 0;
                supply[m.supplyKey] = (supply[m.supplyKey] ?? 0) - before + after;
            }
            const d = SLOT_DEMAND[cat];
            if (d) {
                const before = (equipped.specs || {})[d.specKey] ?? 0;
                const after  = (hovered.specs  || {})[d.specKey] ?? 0;
                demand[d.demandKey] = (demand[d.demandKey] ?? 0) - before + after;
            }
            return { supply, demand };
        }

        // ─── Render ───────────────────────────────────────────────────
        _render() {
            const body = document.querySelector(`#${PANEL_ID} [data-role="body"]`);
            if (!body) return;
            const snap = this._snapshot;
            if (!snap) {
                body.innerHTML = `<div class="cor3-lp-opt-empty">${escapeHtml(t('loadout.loading'))}</div>`;
                return;
            }
            const r = snap.resources || {};
            const equippedSw = snap.equippedSoftware || [];
            const equippedHw = snap.equippedHardware || {};
            const ownedHw   = snap.ownedHardware   || [];
            const ownedSw   = snap.ownedSoftware   || [];

            const equippedSwIds = new Set(equippedSw.map((s) => s.id));

            // capDetails[type] = { owned: Set<target>, active: Set<target> }
            //   target = file extension (for DECRYPT) or server type
            //            (for HACK / SEARCH). Generalised via spec.fileTypes
            //            OR spec.serverTypes — whichever the cor3.gg WS
            //            payload uses for this capability. Future cap
            //            types are picked up automatically as long as the
            //            spec carries one of those arrays.
            //
            //   owned   — every target reachable IF the user equips the
            //             right owned software. Whole superset.
            //   active  — subset currently provided by EQUIPPED software.
            // Rendering paints active green, owned-but-not-active gray.
            const capDetails = {};
            for (const sw of ownedSw) for (const sp of (sw.specs || [])) {
                if (!sp || !sp.type) continue;
                if (!capDetails[sp.type]) capDetails[sp.type] = { owned: new Set(), active: new Set() };
                for (const t of specTargets(sp)) capDetails[sp.type].owned.add(t);
            }
            for (const sw of equippedSw) for (const sp of (sw.specs || [])) {
                if (!sp || !sp.type) continue;
                if (!capDetails[sp.type]) capDetails[sp.type] = { owned: new Set(), active: new Set() };
                for (const t of specTargets(sp)) capDetails[sp.type].active.add(t);
            }

            const capsHave = new Set();
            for (const sw of equippedSw) for (const sp of (sw.specs || [])) {
                if (sp && sp.type) capsHave.add(sp.type);
            }
            const capsAvailable = new Set(Object.keys(capDetails));

            const canBoot = !!r.canBoot;
            this._setStatus(t(canBoot ? 'loadout.status.ready' : 'loadout.status.notReady'), canBoot ? 'ok' : 'warn');

            // CAPABILITIES — dynamic, discovered from snapshot. Order
            // alphabetically for stable visual layout. Equipped types
            // shown in green; owned-but-unequipped in red — clicking
            // those triggers an auto-install of the cheapest software
            // providing that capability (see _installCheapestForCapability).
            // (Chips for capabilities we don't even OWN yet are not
            // rendered — there's nothing useful to click for those.)
            const caps = [...capsAvailable].sort().map((c) => {
                const status = capsHave.has(c) ? 'have' : 'missing';
                const tip = status === 'missing' ? t('loadout.cap.installCheapest', { cap: c }) : '';
                return `<span class="cor3-lp-cap ${status}" data-role="cap" data-cap="${escapeHtml(c)}" data-status="${status}" title="${escapeHtml(tip)}">${escapeHtml(c)}</span>`;
            }).join('');
            // Per-capability target breakdown — full union of what the
            // user could decrypt / hack / search if they equipped the
            // right software, with currently active ones highlighted
            // green. Ordered alphabetically for stable rendering.
            const capLines = [...capsAvailable].sort().map((capType) => {
                const det = capDetails[capType];
                if (!det || det.owned.size === 0) return '';
                // Each target is clickable → opens a chooser of every owned
                // software providing it (equip / swap). Active (equipped) = green.
                const items = [...det.owned].sort().map((tg) => {
                    const cls = det.active.has(tg) ? 'on' : 'off';
                    return `<span class="cor3-lp-cap-tgt ${cls}" data-role="cap-tgt" data-cap="${escapeHtml(capType)}" data-tgt="${escapeHtml(tg)}" title="${escapeHtml(t('loadout.cap.chooseTip', { tgt: tg }))}">${escapeHtml(tg)}</span>`;
                }).join(' ');
                return `<div class="cor3-lp-cap-line"><span class="cor3-lp-cap-line-label">${escapeHtml(capType)}:</span> ${items}</div>`;
            }).filter(Boolean).join('');

            // HW slots — discover slot keys from equippedHardware. Server
            // owns the set; if cor3.gg ever adds a new slot type
            // (e.g. "cooler"), we'll render it without a code change.
            // ownedHw alternatives are filtered by hw.category (the
            // server-side enum, e.g. "CPU" — language-independent).
            const slotKeys = Object.keys(equippedHw);
            const slotHtml = slotKeys.map((slotKey) => {
                const eq = equippedHw[slotKey];
                const catEnum = eq && eq.category;  // server-side category enum
                const alternatives = ownedHw
                    .filter((h) => h.category === catEnum && (!eq || h.id !== eq.id))
                    .sort((a, b) => (b.tier || 0) - (a.tier || 0));
                return this._slotHtml(slotKey, eq, alternatives);
            }).join('');

            // PROGRAMS — single list, sorted equipped→not, then by tier desc
            const sortedSw = ownedSw.slice().sort((a, b) => {
                const ae = equippedSwIds.has(a.id), be = equippedSwIds.has(b.id);
                if (ae !== be) return ae ? -1 : 1;
                return (b.tier || 0) - (a.tier || 0);
            });
            const progsHtml = sortedSw.map((sw) => this._programHtml(sw, equippedSwIds.has(sw.id), r.softwarePower)).join('');

            body.innerHTML = `
                <div class="cor3-lp-section">
                    <div class="cor3-lp-section-title">${escapeHtml(t('loadout.section.capabilities'))}</div>
                    <div class="cor3-lp-caps">${caps}</div>
                    ${capLines}
                </div>
                <div class="cor3-lp-section" data-role="bars-section">
                    <div class="cor3-lp-section-title">${escapeHtml(t('loadout.section.resources'))}</div>
                    <div data-role="bars">${this._barsHtml(null)}</div>
                </div>
                <div class="cor3-lp-section">
                    <div class="cor3-lp-section-title">${escapeHtml(t('loadout.section.hardware'))}</div>
                    ${slotHtml}
                </div>
                <div class="cor3-lp-section">
                    <div class="cor3-lp-section-title">${escapeHtml(t('loadout.section.programs'))}</div>
                    ${progsHtml || `<div class="cor3-lp-opt-empty">${escapeHtml(t('loadout.noPrograms'))}</div>`}
                </div>
            `;
            this._setUpdated();
            this._refreshPowerBtn();
            // Keep an open capability-target chooser in sync with the fresh
            // snapshot (equip/unequip results show immediately).
            this._renderChooser();
        }

        // Only the bars block re-renders on hover — saves a full re-render
        // (which would tear the slot-options open state).
        _renderBars() {
            const wrap = document.querySelector(`#${PANEL_ID} [data-role="bars"]`);
            if (!wrap) return;
            wrap.innerHTML = this._barsHtml(this._previewResources());
        }

        _barsHtml(preview) {
            const r = this._snapshot && this._snapshot.resources;
            if (!r || !r.supply || !r.demand) return '';
            const supply = r.supply;
            const demand = r.demand;
            const previewSupply = preview ? preview.supply : null;
            const previewDemand = preview ? preview.demand : null;
            // Labels are i18n keys; resolved per render so a live
            // language change picks up immediately. Units are
            // language-neutral abbreviations.
            const DEFS = [
                [t('loadout.res.cpuFreq'),    'cpu_frequency', 'GHZ'],
                [t('loadout.res.cpuCores'),   'cpu_cores',     'COUNT'],
                [t('loadout.res.gpuPower'),   'gpu_power',     'PFLOPS'],
                [t('loadout.res.gpuMemory'),  'gpu_memory',    'TB'],
                [t('loadout.res.ramFreq'),    'ram_frequency', 'GHZ'],
                [t('loadout.res.ramMemory'),  'ram_memory',    'TB'],
                [t('loadout.res.psuPower'),   'psu_total',     'KW', 'psu_power'],
            ];
            return DEFS.map(([label, demandKey, unit, supplyKeyOverride]) => {
                const supplyKey = supplyKeyOverride || demandKey;
                const used = Number(demand[demandKey] ?? 0);
                const cap  = Number(supply[supplyKey] ?? 0);
                const pct  = cap > 0 ? Math.min(100, (used / cap) * 100) : 0;
                const cls  = used > cap ? 'over' : (pct > 80 ? 'hot' : '');

                let deltaHtml = '';
                let previewBar = '';
                let oldCapMark = '';
                if (preview) {
                    const usedP = Number(previewDemand[demandKey] ?? used);
                    const capP  = Number(previewSupply[supplyKey] ?? cap);
                    const supplyDelta = capP - cap;
                    const demandDelta = usedP - used;
                    // Show delta on the metric that changed (priority: supply, then demand).
                    let dShow = 0; let dDir = '';
                    if (Math.abs(supplyDelta) > 1e-6) { dShow = supplyDelta; dDir = supplyDelta > 0 ? 'up' : 'down'; }
                    else if (Math.abs(demandDelta) > 1e-6) { dShow = -demandDelta; dDir = demandDelta < 0 ? 'up' : 'down'; }
                    if (dShow !== 0) deltaHtml = `<span class="cor3-lp-bar-delta ${dDir}">(${dShow > 0 ? '+' : ''}${fmt(dShow)})</span>`;

                    // Preview overlay shows the new used/cap ratio.
                    const pctP = capP > 0 ? Math.min(100, (usedP / capP) * 100) : 0;
                    previewBar = `<div class="cor3-lp-bar-preview" style="width:${pctP}%"></div>`;
                    // If cap shifted, mark the OLD cap position as a faint line.
                    if (Math.abs(supplyDelta) > 1e-6 && capP > 0) {
                        const oldCapPct = Math.min(100, (cap / capP) * 100);
                        oldCapMark = `<div class="cor3-lp-bar-cap-old" style="left:${oldCapPct}%"></div>`;
                    }
                }
                return `
                    <div class="cor3-lp-bar">
                        <div class="cor3-lp-bar-row">
                            <span class="cor3-lp-bar-name">${label}</span>
                            <span class="cor3-lp-bar-val">${fmt(used)} / ${fmt(cap)} ${unit}${deltaHtml}</span>
                        </div>
                        <div class="cor3-lp-bar-track">
                            <div class="cor3-lp-bar-fill ${cls}" style="width:${pct}%"></div>
                            ${previewBar}
                            ${oldCapMark}
                        </div>
                    </div>`;
            }).join('');
        }

        _slotHtml(cat, equipped, alternatives) {
            const isOpen = this._openSlot === cat;
            const slotClass = `cor3-lp-slot ${equipped ? 'equipped' : ''} ${isOpen ? 'open' : ''}`;
            const optsHtml = alternatives.length
                ? alternatives.map((h) => this._optHtml(cat, h)).join('')
                : `<div class="cor3-lp-opt-empty">${escapeHtml(t('loadout.noAlternatives'))}</div>`;
            return `
                <div class="${slotClass}">
                    <div class="cor3-lp-slot-head" data-role="slot-head" data-cat="${cat}">
                        <span class="cor3-lp-arrow">▶</span>
                        ${equipped && equipped.image ? `<img src="${equipped.image}" alt="">` : ''}
                        <div class="cor3-lp-slot-body">
                            <div class="cor3-lp-slot-cat">${cat.toUpperCase()}</div>
                            <div class="cor3-lp-slot-name">${equipped ? escapeHtml(equipped.name) : escapeHtml(t('loadout.noSlot'))}</div>
                            <div class="cor3-lp-slot-meta">${equipped ? hwSummary(equipped) : ''}</div>
                        </div>
                        ${equipped ? tierBadge(equipped.tier) : ''}
                    </div>
                    <div class="cor3-lp-slot-options">${optsHtml}</div>
                </div>`;
        }

        _optHtml(cat, hw) {
            return `
                <div class="cor3-lp-opt" data-role="opt" data-cat="${cat}" data-hw="${hw.id}">
                    ${hw.image ? `<img src="${hw.image}" alt="" style="width:24px;height:24px;border-radius:3px;background:rgba(10,14,18,0.5);">` : ''}
                    <div class="cor3-lp-opt-body">
                        <div class="cor3-lp-opt-name">${escapeHtml(hw.name)}</div>
                        <div class="cor3-lp-opt-meta">${hwSummary(hw)}</div>
                    </div>
                    ${tierBadge(hw.tier)}
                </div>`;
        }

        _programHtml(sw, isEquipped, softwarePower) {
            const specs = Array.isArray(sw.specs) ? sw.specs : [];
            const power = (softwarePower || []).find((p) => p && p.moduleId === sw.id);
            // One line per capability spec: TYPE · power (computed/max when
            // equipped, else the min–max band) · the targets it covers
            // (file extensions for DECRYPT, server types for HACK/SEARCH).
            const caps = specs.map((sp) => {
                if (!sp || !sp.type) return '';
                const max = Array.isArray(sp.power) && sp.power.length ? sp.power[sp.power.length - 1] : null;
                const eff = isEquipped && power && Array.isArray(power.abilities)
                    ? (power.abilities.find((a) => a.type === sp.type) || {}).computedPower
                    : null;
                const powTxt = (eff != null && max != null) ? `${eff}/${max}` : powerBand(sp);
                const tgts = specTargets(sp);
                const tgtTxt = tgts.length ? tgts.map((x) => escapeHtml(x)).join(' ') : '';
                return `<div class="cor3-lp-prog-cap">`
                    + `<span class="cor3-lp-prog-cap-type">${escapeHtml(sp.type)}</span>`
                    + (powTxt ? `<span class="cor3-lp-prog-cap-pow">${escapeHtml(String(powTxt))}</span>` : '')
                    + (sp.remote ? `<span class="cor3-lp-prog-cap-r" title="${escapeHtml(t('loadout.cap.remote'))}">R</span>` : '')
                    + (tgtTxt ? `<span class="cor3-lp-prog-cap-tgts">${tgtTxt}</span>` : '')
                    + `</div>`;
            }).filter(Boolean).join('');
            const toggleClass = isEquipped ? 'uninstall' : 'install';
            const toggleSym   = isEquipped ? '−' : '+';
            // Reuse the verb translations from the watchdog toast,
            // title-cased for tooltip context. Works for ru/en/fr/es/de/pl/uk/tr;
            // CJK locales don't case (operations are no-ops there).
            const verbKey = isEquipped ? 'loadout.verb.unequipSw' : 'loadout.verb.equipSw';
            const verb = t(verbKey);
            const toggleTitle = verb.charAt(0).toUpperCase() + verb.slice(1);
            return `
                <div class="cor3-lp-prog ${isEquipped ? 'equipped' : ''}">
                    ${sw.image ? `<img src="${sw.image}" alt="">` : ''}
                    <div class="cor3-lp-prog-body">
                        <div class="cor3-lp-prog-name">${escapeHtml(sw.name)}</div>
                        <div class="cor3-lp-prog-meta">${caps || '—'}</div>
                    </div>
                    ${tierBadge(sw.tier)}
                    <button class="cor3-lp-prog-toggle ${toggleClass}" data-role="prog-toggle" data-sw="${sw.id}" title="${toggleTitle}">${toggleSym}</button>
                </div>`;
        }
    }

    // ─── Render helpers ─────────────────────────────────────────────────
    function fmt(n) {
        if (n === 0 || n === null || n === undefined) return String(n ?? 0);
        if (Number.isInteger(n)) return String(n);
        return Number(n).toFixed(2).replace(/\.?0+$/, '');
    }
    function tierBadge(tier) {
        const t = Number(tier) || 1;
        return `<span class="cor3-lp-tier t${t}">T${t}</span>`;
    }
    // A capability spec's targets — file extensions (DECRYPT) or server types
    // (HACK / SEARCH), whichever array the cor3.gg WS payload uses for this spec.
    function specTargets(sp) {
        if (!sp) return [];
        if (Array.isArray(sp.fileTypes))   return sp.fileTypes;
        if (Array.isArray(sp.serverTypes)) return sp.serverTypes;
        return [];
    }
    // [min,max] power band of a spec → "min–max" (or "/max" / "" when partial).
    function powerBand(sp) {
        const arr = Array.isArray(sp && sp.power) ? sp.power : [];
        if (!arr.length) return '';
        const lo = Number(arr[0]);
        const hi = Number(arr[arr.length - 1]);
        if (Number.isFinite(lo) && Number.isFinite(hi) && lo !== hi) return `${fmt(lo)}–${fmt(hi)}`;
        return Number.isFinite(hi) ? `/${fmt(hi)}` : '';
    }
    function hwSummary(hw) {
        if (!hw || !hw.specs) return '';
        const s = hw.specs;
        const c = t('loadout.hw.coresShort');
        let line;
        if (hw.category === 'CPU') line = `${s.cpuFrequency} GHz • ${s.cpuCores}${c} • ${s.cpuConsuming} kW`;
        else if (hw.category === 'GPU') line = `${s.gpuPower} PFLOPS • ${s.gpuMemory} TB • ${s.gpuConsuming} kW`;
        else if (hw.category === 'RAM') line = `${s.ramFrequency} GHz • ${s.ramMemory} TB`;
        else if (hw.category === 'PSU') line = `${s.psuPower} kW • ${s.psuProtection}% ${t('loadout.hw.psuProtection')}`;
        else line = '';
        const vuln = (typeof hw.itemVulnerability === 'number') ? ` • ${hw.itemVulnerability}% ${t('loadout.hw.vuln')}` : '';
        return line + vuln;
    }
    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
            .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }

    const loadoutPanel = new LoadoutPanelModule();
    Registry.register(loadoutPanel);

    // Headless loadout API for Auto Jobs's flow modules (MAIN world).
    root.COR3.game = root.COR3.game || {};
    root.COR3.game.loadout = {
        getSnapshot: () => loadoutPanel._snapshot,
        decryptExtensions: () => [...loadoutPanel._equippedDecryptExts()],
        planDecrypt: (ext, requiredPower) => loadoutPanel.apiPlanDecrypt(ext, requiredPower),
        ensureDecrypt: (ext, requiredPower, log) => loadoutPanel.apiEnsureDecrypt(ext, requiredPower, log),
        hackServerTypes: () => [...loadoutPanel._equippedHackTypes()],
        planHack: (serverType, requiredPower) => loadoutPanel.apiPlanHack(serverType, requiredPower),
        ensureHack: (serverType, requiredPower, log) => loadoutPanel.apiEnsureHack(serverType, requiredPower, log),
    };
})();
