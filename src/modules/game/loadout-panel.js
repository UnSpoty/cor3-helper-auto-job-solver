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

    const TOAST_DURATION_MS = 4500;
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
        while (el && el !== document.body) {
            const r = el.getBoundingClientRect();
            if (r.bottom >= window.innerHeight - 32 && r.width >= 200) return el;
            el = el.parentElement;
        }
        return null;
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

    // ─── Style ───────────────────────────────────────────────────────────
    const CSS = `
#${HOST_ID} { position: fixed; left: 0; right: 0; bottom: 0; height: 0; z-index: 2147483600; font-family: "Roboto Mono", monospace; color: #fff; pointer-events: none; }
#${PILL_ID} { position: absolute; bottom: 0; width: 220px; height: 34px; background: rgba(10,14,18,0.98); border-top-left-radius: 16px; border-top-right-radius: 16px; display: flex; align-items: center; justify-content: center; gap: 8px; font-size: 14px; font-weight: 700; letter-spacing: 0.5px; cursor: pointer; pointer-events: auto; user-select: none; transition: background 120ms ease; }
#${PILL_ID}:hover { background: rgba(20,28,38,0.98); }
#${PILL_ID} .cor3-lp-chev { font-size: 10px; opacity: 0.7; transform: translateY(-1px); }
/* Auto-power mini-pill — sits to the left of the main pill, toggles
 * the "shut off system on panel open" behaviour. */
.cor3-lp-auto { position: absolute; bottom: 0; height: 34px; padding: 0 12px; background: rgba(10,14,18,0.98); border-top-left-radius: 16px; border-top-right-radius: 16px; display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 700; letter-spacing: 0.5px; cursor: pointer; pointer-events: auto; user-select: none; transition: background 120ms ease; border-right: 1px solid rgba(96,108,124,0.25); }
.cor3-lp-auto:hover { background: rgba(20,28,38,0.98); }
.cor3-lp-auto .cor3-lp-auto-dot { width: 8px; height: 8px; border-radius: 50%; background: #4ade80; box-shadow: 0 0 6px #4ade80; }
.cor3-lp-auto.off .cor3-lp-auto-dot { background: #FE4949; box-shadow: 0 0 6px #FE4949; }
.cor3-lp-auto .cor3-lp-auto-label { color: rgba(255,255,255,0.85); }
#${PANEL_ID} { position: absolute; bottom: 34px; width: 480px; max-height: 78vh; background: rgba(10,14,18,0.98); border-top-left-radius: 16px; display: none; flex-direction: column; overflow: hidden; pointer-events: auto; box-shadow: -8px -8px 32px rgba(0,0,0,0.4); }
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
#${PANEL_ID} .cor3-lp-cap-tgt { display: inline-block; padding: 1px 6px; border-radius: 3px; font-family: "Roboto Mono", monospace; font-size: 10px; margin-right: 2px; }
#${PANEL_ID} .cor3-lp-cap-tgt.on  { background: rgba(74,222,128,0.15); color: #4ade80; border: 1px solid rgba(74,222,128,0.3); }
#${PANEL_ID} .cor3-lp-cap-tgt.off { background: rgba(96,108,124,0.10); color: rgba(255,255,255,0.45); border: 1px solid rgba(96,108,124,0.3); }
#${PANEL_ID} .cor3-lp-foot { padding: 8px 14px; border-top: 1px solid rgba(96,108,124,0.25); font-size: 10px; color: rgba(255,255,255,0.4); display: flex; justify-content: space-between; align-items: center; }
#${PANEL_ID} .cor3-lp-btn { background: rgba(118,193,209,0.12); color: #76C1D1; border: 1px solid rgba(118,193,209,0.35); padding: 3px 10px; border-radius: 4px; font-size: 10px; font-weight: 700; letter-spacing: 0.5px; cursor: pointer; font-family: inherit; }
#${PANEL_ID} .cor3-lp-btn:hover { background: rgba(118,193,209,0.22); }
/* toasts — stack above the pill, slide+fade in/out */
.cor3-lp-toasts { position: absolute; bottom: 38px; width: 320px; display: flex; flex-direction: column; gap: 6px; pointer-events: none; z-index: 2147483601; }
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
            this._powerState = null;     // true=on, false=off, null=unknown
            this._autoPower = readAutoPower();   // setting: auto-poweroff on open
            this._savedPowerState = null;        // remembered across open/close when _autoPower=true
            this._toastSeq = 0;
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

            host.querySelector(`#${PILL_ID}`).addEventListener('click', () => this._toggle());
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
            const host = document.getElementById(HOST_ID);
            if (!host) return;
            const anchor = findNotificationsAnchor();
            const pill = document.getElementById(PILL_ID);
            const panel = document.getElementById(PANEL_ID);
            const auto = host.querySelector('[data-role="auto"]');
            const toasts = host.querySelector('[data-role="toasts"]');
            // Default fallback: bottom-right with 4px gap.
            let rightOffset = 4;
            let bottomOffset = 0;
            if (anchor) {
                const r = anchor.getBoundingClientRect();
                rightOffset = Math.max(0, window.innerWidth - r.left + 4);
                bottomOffset = Math.max(0, window.innerHeight - (r.top + r.height));
            }
            // Main pill anchors at rightOffset; panel above it.
            const PILL_W = 220;
            const AUTO_W = (auto ? auto.getBoundingClientRect().width : 60) || 60;
            if (pill)  { pill.style.right  = rightOffset + 'px';  pill.style.bottom  = bottomOffset + 'px'; }
            if (panel) { panel.style.right = rightOffset + 'px';  panel.style.bottom = (bottomOffset + 34) + 'px'; }
            // Auto-pill sits just to the LEFT of the main pill, sharing the same bottom.
            if (auto) { auto.style.right = (rightOffset + PILL_W) + 'px'; auto.style.bottom = bottomOffset + 'px'; }
            // Toasts stack above the main pill, aligned to its left edge.
            if (toasts) { toasts.style.right = rightOffset + 'px'; toasts.style.bottom = (bottomOffset + 38) + 'px'; }
        }

        // ─── Open / close ─────────────────────────────────────────────
        _toggle() {
            this._open ? this._close() : this._open_();
        }

        async _open_() {
            this._open = true;
            const panel = document.getElementById(PANEL_ID);
            const chev = document.querySelector(`#${PILL_ID} [data-role="chev"]`);
            if (panel) panel.classList.add('cor3-lp-open');
            if (chev) chev.textContent = '▼';
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
            const panel = document.getElementById(PANEL_ID);
            const chev = document.querySelector(`#${PILL_ID} [data-role="chev"]`);
            if (panel) panel.classList.remove('cor3-lp-open');
            if (chev) chev.textContent = '▲';
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
            // frame (concurrent refresh, native-UI change, the headless v2 flow
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

        // ─── Programmatic API for Auto-Jobs v2 (headless, no UI) ──────────
        // Exposed via COR3.game.loadout so the v2 file-decryption flow can ask
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
        _ownedDecryptSwFor(ext) {
            const e = String(ext || '').toLowerCase();
            const equipped = new Set(((this._snapshot && this._snapshot.equippedSoftware) || []).map((s) => s.id));
            return ((this._snapshot && this._snapshot.ownedSoftware) || [])
                .filter((sw) => !equipped.has(sw.id))
                .filter((sw) => (sw.specs || []).some((sp) => sp && sp.type === 'DECRYPT'
                    && Array.isArray(sp.fileTypes) && sp.fileTypes.some((t) => String(t).toLowerCase() === e)))
                .sort((a, b) => (Number(a.price) || 0) - (Number(b.price) || 0));
        }
        // Plan how to become able to decrypt `ext`:
        //   { status:'ready' }            already covered by equipped software
        //   { status:'install', sw }      an owned SW covers it and fits as-is
        //   { status:'swap',    sw }      owned SW covers it but needs resources freed first
        //   { status:'none' }             no owned SW covers this ext
        //   { status:'unknown' }          loadout snapshot not received yet
        apiPlanDecrypt(ext) {
            if (!this._snapshot) return { status: 'unknown' };
            if (this._equippedDecryptExts().has(String(ext || '').toLowerCase())) return { status: 'ready' };
            const candidates = this._ownedDecryptSwFor(ext);
            if (candidates.length === 0) return { status: 'none' };
            const feasible = candidates.find((sw) => this._checkInstallFeasibility(sw).length === 0);
            if (feasible) return { status: 'install', sw: feasible };
            return { status: 'swap', sw: candidates[0] };
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
        // 'no-loadout-snapshot'. So ensureDecrypt/ensureHack — and thus the v2
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
        // Make the loadout able to decrypt `ext`. Resolves to
        //   { ok:true,  status:'ready'|'installed'|'swapped' }
        //   { ok:false, status, reason }
        async apiEnsureDecrypt(ext, log) {
            const say = typeof log === 'function' ? log : () => {};
            await this._ensureSnapshot(8000, say);   // auto-fetch the snapshot if not warmed yet
            const plan = this.apiPlanDecrypt(ext);
            if (plan.status === 'ready')   { say('info', `loadout already decrypts ${ext}`); return { ok: true, status: 'ready' }; }
            if (plan.status === 'unknown') { say('warn', 'loadout snapshot still not loaded after request'); return { ok: false, status: 'unknown', reason: 'no-loadout-snapshot' }; }
            if (plan.status === 'none')    { say('warn', `no owned software can decrypt ${ext}`); return { ok: false, status: 'none', reason: `no-decrypt-software:${ext}` }; }
            if (typeof root.__cor3LoadoutEquipSoftware !== 'function') return { ok: false, status: 'no-helper', reason: 'equip-helper-missing' };

            if (plan.status === 'swap') {
                say('info', `freeing resources — unequipping all software to fit "${plan.sw.name}"`);
                if (typeof root.__cor3LoadoutUnequipSoftware === 'function') {
                    for (const sw of ((this._snapshot && this._snapshot.equippedSoftware) || []).slice()) {
                        root.__cor3LoadoutUnequipSoftware(sw.id);
                        await this._waitEquipped(sw.id, false, 6000);
                    }
                }
            }
            say('info', `installing "${plan.sw.name}" for ${ext}`);
            root.__cor3LoadoutEquipSoftware(plan.sw.id);
            const equipped = await this._waitEquipped(plan.sw.id, true, 8000);
            if (!equipped) { say('error', `install of "${plan.sw.name}" did not take effect`); return { ok: false, status: 'install-failed', reason: 'install-not-applied' }; }
            const ready = this._equippedDecryptExts().has(String(ext).toLowerCase());
            return ready
                ? { ok: true, status: plan.status === 'swap' ? 'swapped' : 'installed' }
                : { ok: false, status: 'install-failed', reason: 'installed-but-ext-not-covered' };
        }

        // ─── HACK capability API (parallel to DECRYPT above) ──────────────
        // Same shape, but the capability is HACK and the target is a server
        // TYPE (e.g. "CEDRT private", from the server's serverTypeName) matched
        // against spec.serverTypes. Used by the SAI Hack-Tool flow: equip a HACK
        // software so the server's get.login.status hackTools[] populates.
        // (hackPower-vs-serverDefenceRate is then resolved by the hack minigame's
        // difficulty; ensureHack only guarantees a covering tool is equipped.)
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
        _ownedHackSwFor(serverType) {
            const st = String(serverType || '').toLowerCase();
            const equipped = new Set(((this._snapshot && this._snapshot.equippedSoftware) || []).map((s) => s.id));
            return ((this._snapshot && this._snapshot.ownedSoftware) || [])
                .filter((sw) => !equipped.has(sw.id))
                .filter((sw) => (sw.specs || []).some((sp) => sp && sp.type === 'HACK'
                    && Array.isArray(sp.serverTypes) && sp.serverTypes.some((t) => String(t).toLowerCase() === st)))
                .sort((a, b) => (Number(a.price) || 0) - (Number(b.price) || 0));
        }
        // Plan how to become able to hack a server of type `serverType`:
        //   ready | install | swap | none | unknown  (same as apiPlanDecrypt).
        apiPlanHack(serverType) {
            if (!this._snapshot) return { status: 'unknown' };
            if (this._equippedHackTypes().has(String(serverType || '').toLowerCase())) return { status: 'ready' };
            const candidates = this._ownedHackSwFor(serverType);
            if (candidates.length === 0) return { status: 'none' };
            const feasible = candidates.find((sw) => this._checkInstallFeasibility(sw).length === 0);
            if (feasible) return { status: 'install', sw: feasible };
            return { status: 'swap', sw: candidates[0] };
        }
        // Make the loadout able to hack `serverType`. Resolves to
        //   { ok:true,  status:'ready'|'installed'|'swapped' }
        //   { ok:false, status, reason }
        async apiEnsureHack(serverType, log) {
            const say = typeof log === 'function' ? log : () => {};
            await this._ensureSnapshot(8000, say);   // auto-fetch the snapshot if not warmed yet
            const plan = this.apiPlanHack(serverType);
            if (plan.status === 'ready')   { say('info', `loadout already hacks "${serverType}"`); return { ok: true, status: 'ready' }; }
            if (plan.status === 'unknown') { say('warn', 'loadout snapshot still not loaded after request'); return { ok: false, status: 'unknown', reason: 'no-loadout-snapshot' }; }
            if (plan.status === 'none')    { say('warn', `no owned software can hack "${serverType}"`); return { ok: false, status: 'none', reason: `no-hack-software:${serverType}` }; }
            if (typeof root.__cor3LoadoutEquipSoftware !== 'function') return { ok: false, status: 'no-helper', reason: 'equip-helper-missing' };

            if (plan.status === 'swap') {
                say('info', `freeing resources — unequipping all software to fit "${plan.sw.name}"`);
                if (typeof root.__cor3LoadoutUnequipSoftware === 'function') {
                    for (const sw of ((this._snapshot && this._snapshot.equippedSoftware) || []).slice()) {
                        root.__cor3LoadoutUnequipSoftware(sw.id);
                        await this._waitEquipped(sw.id, false, 6000);
                    }
                }
            }
            say('info', `installing "${plan.sw.name}" to hack "${serverType}"`);
            root.__cor3LoadoutEquipSoftware(plan.sw.id);
            const equipped = await this._waitEquipped(plan.sw.id, true, 8000);
            if (!equipped) { say('error', `install of "${plan.sw.name}" did not take effect`); return { ok: false, status: 'install-failed', reason: 'install-not-applied' }; }
            const ready = this._equippedHackTypes().has(String(serverType).toLowerCase());
            return ready
                ? { ok: true, status: plan.status === 'swap' ? 'swapped' : 'installed' }
                : { ok: false, status: 'install-failed', reason: 'installed-but-type-not-covered' };
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

        // ─── Toasts ───────────────────────────────────────────────────
        _showToast(title, severity, text) {
            const wrap = document.querySelector(`#${HOST_ID} [data-role="toasts"]`);
            if (!wrap) return;
            const t = document.createElement('div');
            t.className = 'cor3-lp-toast ' + (severity || 'ok');
            const sev = severity || 'ok';
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
            function specTargets(sp) {
                if (!sp) return [];
                if (Array.isArray(sp.fileTypes))   return sp.fileTypes;
                if (Array.isArray(sp.serverTypes)) return sp.serverTypes;
                return [];
            }
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
                const items = [...det.owned].sort().map((t) => {
                    const cls = det.active.has(t) ? 'on' : 'off';
                    return `<span class="cor3-lp-cap-tgt ${cls}">${escapeHtml(t)}</span>`;
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
            const caps = specs.map((sp) => {
                if (!sp || !sp.type) return '';
                const max = Array.isArray(sp.power) ? sp.power[sp.power.length - 1] : '?';
                const eff = isEquipped && power && Array.isArray(power.abilities)
                    ? (power.abilities.find((a) => a.type === sp.type) || {}).computedPower
                    : null;
                return `<span style="color:#76C1D1;">${sp.type}${eff != null ? ` ${eff}/${max}` : ` /${max}`}</span>${sp.remote ? ' R' : ''}`;
            }).filter(Boolean).join(' &nbsp; ');
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

    // Headless loadout API for Auto-Jobs v2's flow-v2 modules (MAIN world).
    root.COR3.game = root.COR3.game || {};
    root.COR3.game.loadout = {
        getSnapshot: () => loadoutPanel._snapshot,
        decryptExtensions: () => [...loadoutPanel._equippedDecryptExts()],
        planDecrypt: (ext) => loadoutPanel.apiPlanDecrypt(ext),
        ensureDecrypt: (ext, log) => loadoutPanel.apiEnsureDecrypt(ext, log),
        hackServerTypes: () => [...loadoutPanel._equippedHackTypes()],
        planHack: (serverType) => loadoutPanel.apiPlanHack(serverType),
        ensureHack: (serverType, log) => loadoutPanel.apiEnsureHack(serverType, log),
    };
})();
