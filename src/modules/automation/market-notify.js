// src/modules/automation/market-notify.js
// Market reset notifications — the IN-PAGE TOAST half of the feature.
//
// Detection now lives entirely in the background service worker on
// chrome.alarms (see src/entry/background.js) so a market reset is caught even
// when the cor3.gg tab is CLOSED. The SW owns the desktop notification; when a
// tab IS open it forwards a toast request here (MSG.NOTIFY.MARKET_TOAST,
// payload { short }). The popup "Test" button reaches the same path via the SW.
//
// This module therefore just renders the toast. It localises the text itself
// (the content world has i18n), so the sender only passes the market short
// code. The toast class `cor3-market-reset` is deliberately NOT a substring
// appearance/system-messages.js hides ("notification"/"alert"/"system-message").

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Registry, constants: C } = root.COR3;
    const t = (k, vars) => (root.COR3.i18n ? root.COR3.i18n.t(k, vars) : k);
    const TOAST_MS = 8000;

    class MarketNotifyModule extends Module {
        constructor() {
            super({
                id: 'market-notify',
                name: 'Market reset notifications',
                category: C.CATEGORY.AUTOMATION,
            });
        }

        async start() {
            // Toast requests from the SW (real reset, tab open) or the popup
            // (Test button). Bus.runtime delivers both tabs.sendMessage shapes.
            this.track(Bus.runtime.on(C.MSG.NOTIFY.MARKET_TOAST, (payload) => {
                this._toast(payload && payload.short);
                return { ok: true };
            }));
            this.info('market reset toast renderer ready');
        }

        _toast(short) {
            try {
                const doc = root.document;
                if (!doc || !doc.body) return;
                const title = t('mn.title');
                const body = t('mn.body', { market: short || '' });
                let host = doc.getElementById('cor3-market-reset-host');
                if (!host) {
                    host = doc.createElement('div');
                    host.id = 'cor3-market-reset-host';
                    host.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483000;display:flex;flex-direction:column;gap:8px;pointer-events:none;font-family:system-ui,-apple-system,sans-serif';
                    doc.body.appendChild(host);
                }
                const card = doc.createElement('div');
                card.className = 'cor3-market-reset';
                card.style.cssText = 'pointer-events:auto;min-width:220px;max-width:320px;background:#0e1420;color:#e6edf3;border:1px solid #2a3a4d;border-left:3px solid #35c46a;border-radius:8px;padding:10px 12px;box-shadow:0 6px 20px rgba(0,0,0,.45);cursor:pointer;opacity:0;transform:translateX(12px);transition:opacity .2s,transform .2s';
                const h = doc.createElement('div');
                h.textContent = title;
                h.style.cssText = 'font-weight:700;font-size:13px;margin-bottom:2px';
                const b = doc.createElement('div');
                b.textContent = body;
                b.style.cssText = 'font-size:12px;color:#9fb0c3';
                card.appendChild(h); card.appendChild(b);
                host.appendChild(card);
                root.requestAnimationFrame(() => { card.style.opacity = '1'; card.style.transform = 'translateX(0)'; });
                const remove = () => { card.style.opacity = '0'; card.style.transform = 'translateX(12px)'; root.setTimeout(() => card.remove(), 220); };
                card.addEventListener('click', remove);
                root.setTimeout(remove, TOAST_MS);
            } catch (e) { this.warn('toast failed', { error: String(e) }); }
        }
    }

    Registry.register(new MarketNotifyModule());
})();
