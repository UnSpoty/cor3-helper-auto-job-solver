// Bridge: chrome.runtime.sendMessage (popup/SW → isolated world)
// → window.postMessage (isolated → MAIN).
// Most actions forward a typed Bus.window envelope to the MAIN-world WS
// interceptor.

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
            fwd('requestUsolMarket',  'COR3_REQUEST_USOL_MARKET');
            fwd('refreshUsolMarket',  MSG.GAME.REFRESH_USOL_MARKET);
            fwd('leaveStash',         'COR3_LEAVE_STASH');
            fwd('keepWorkerAlive',    'COR3_KEEP_ALIVE');
            fwd('requestArchivedExpeditions', MSG.GAME.REQUEST_ARCHIVED_EXPEDITIONS);
            fwd('requestMercenaries',         'COR3_REQUEST_MERCENARIES');
            fwd('requestExpeditionConfig',    'COR3_REQUEST_EXPEDITION_CONFIG');
            fwd('requestProfile',             MSG.GAME.REQUEST_PROFILE);

            this.track(Bus.runtime.on('sellItem', (p) => {
                Bus.window.post('COR3_SELL_ITEM', { itemId: p && p.itemId, quantity: (p && p.quantity) || 1 });
                return { success: true };
            }));
            this.track(Bus.runtime.on('deleteItem', (p) => {
                Bus.window.post(MSG.GAME.DELETE_ITEM, { itemId: p && p.itemId, quantity: (p && p.quantity) || 1 });
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

            // Manual "Send now" from the Mercenary roster: build the launch
            // config from the cached expedition config (default location/zone/
            // objective — the same one the auto-send engine uses) and launch.
            this.track(Bus.runtime.on('sendMercNow', async (p) => {
                if (!p || !p.mercenaryId) return { error: 'no mercenaryId' };
                const cfg = await root.COR3.Store.local.getOne(C.STORAGE_LOCAL.EXPEDITION_CONFIG);
                if (!cfg || !Array.isArray(cfg.locations) || cfg.locations.length === 0) {
                    Bus.window.post('COR3_REQUEST_EXPEDITION_CONFIG', null);
                    return { error: 'no expedition config' };
                }
                const loc = cfg.locations[0];
                const zone = loc.zones && loc.zones[0];
                const obj = zone && zone.objectives && zone.objectives[0];
                if (!zone || !obj) return { error: 'incomplete expedition config' };
                const launch = {
                    mercenaryId: p.mercenaryId,
                    marketId: '019d3ea4-85bd-7389-904d-8f7c85841134',
                    locationConfigId: loc.id, zoneConfigId: zone.id, objectiveId: obj.id,
                    hasInsurance: false,
                };
                root.COR3.Store.local.setOne(C.STORAGE_LOCAL.LAST_LAUNCH, launch);
                Bus.window.post(MSG.GAME.LAUNCH_EXPEDITION, { config: launch });
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
