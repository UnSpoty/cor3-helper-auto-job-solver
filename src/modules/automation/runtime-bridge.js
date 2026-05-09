// src/modules/automation/runtime-bridge.js
// Bridge: chrome.runtime.sendMessage (popup/SW → isolated world) → window.postMessage (isolated → MAIN).
// Replaces the legacy chrome.runtime.onMessage block that was inside content.js.
// Most actions just forward a typed Bus.window envelope to the MAIN-world WS interceptor.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Registry, constants: C } = root.COR3;
    const MSG = C.MSG;

    class RuntimeBridgeModule extends Module {
        constructor() {
            super({
                id: 'runtime-bridge',
                name: 'Runtime ↔ MAIN bridge',
                category: C.CATEGORY.CORE,
            });
        }

        async start() {
            // Plain forwarders — popup or SW issues an action; we route to MAIN.
            const fwd = (action, type, mapPayload) => {
                this.track(Bus.runtime.on(action, (payload) => {
                    Bus.window.post(type, mapPayload ? mapPayload(payload) : null);
                    return { success: true };
                }));
            };

            fwd('requestExpeditions', MSG.GAME.REQUEST_EXPEDITIONS);
            fwd('requestStash',       'COR3_REQUEST_STASH');
            fwd('requestMarket',      'COR3_REQUEST_MARKET');
            fwd('refreshMarket',      MSG.GAME.REFRESH_MARKET);
            fwd('requestDarkMarket',  'COR3_REQUEST_DARK_MARKET');
            fwd('refreshDarkMarket',  MSG.GAME.REFRESH_DARK_MARKET);
            fwd('requestSrmMarket',   'COR3_REQUEST_SRM_MARKET');
            fwd('refreshSrmMarket',   MSG.GAME.REFRESH_SRM_MARKET);
            fwd('leaveStash',         'COR3_LEAVE_STASH');
            fwd('keepWorkerAlive',    'COR3_KEEP_ALIVE');
            fwd('requestArchivedExpeditions', 'COR3_REQUEST_ARCHIVED_EXPEDITIONS');
            fwd('requestMercenaries',         'COR3_REQUEST_MERCENARIES');
            fwd('requestExpeditionConfig',    'COR3_REQUEST_EXPEDITION_CONFIG');

            this.track(Bus.runtime.on('sellItem', (p) => {
                Bus.window.post('COR3_SELL_ITEM', { itemId: p && p.itemId, quantity: (p && p.quantity) || 1 });
                return { success: true };
            }));

            this.track(Bus.runtime.on('respondDecision', (p) => {
                if (!p) return { error: 'no payload' };
                Bus.window.post(MSG.GAME.RESPOND_DECISION, {
                    expeditionId: p.expeditionId, messageId: p.messageId, selectedOption: p.selectedOption,
                });
                return { success: true };
            }));

            this.track(Bus.runtime.on('launchExpedition', (p) => {
                if (!p || !p.config) return { error: 'no config' };
                root.COR3.Store.local.setOne(C.STORAGE_LOCAL.LAST_LAUNCH, p.config);
                Bus.window.post(MSG.GAME.LAUNCH_EXPEDITION, { config: p.config });
                return { success: true };
            }));

            this.track(Bus.runtime.on('openContainer', (p) => {
                Bus.window.post(MSG.GAME.OPEN_CONTAINER, { expeditionId: p && p.expeditionId });
                return { success: true };
            }));
            this.track(Bus.runtime.on('collectAll', (p) => {
                Bus.window.post(MSG.GAME.COLLECT_ALL, { expeditionId: p && p.expeditionId });
                return { success: true };
            }));

            this.info('runtime bridge ready');
        }
    }

    Registry.register(new RuntimeBridgeModule());
})();
