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
            fwd('requestAllMercenaries',      'COR3_REQUEST_ALL_MERCENARIES');
            fwd('requestExpeditionConfig',    'COR3_REQUEST_EXPEDITION_CONFIG');
            fwd('requestAllExpeditionConfigs', 'COR3_REQUEST_ALL_EXPEDITION_CONFIGS');
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

            // Manual "Send now" from the Mercenary roster: launch the merc FROM
            // ITS market. The merc card carries the marketId (the roster spans
            // several markets now). Use that market's expedition config — the
            // home "Skylift" set differs from USOL's "Koute" set, so launching a
            // non-home merc with the home config would target the wrong location.
            this.track(Bus.runtime.on('sendMercNow', async (p) => {
                if (!p || !p.mercenaryId) return { error: 'no mercenaryId' };
                const marketId = p.marketId || C.HOME_MARKET_ID;
                const configs = (await root.COR3.Store.local.getOne(C.STORAGE_LOCAL.EXPEDITION_CONFIGS, {})) || {};
                // Fall back to the legacy single config only for HOME.
                const cfg = configs[marketId]
                    || (marketId === C.HOME_MARKET_ID
                        ? await root.COR3.Store.local.getOne(C.STORAGE_LOCAL.EXPEDITION_CONFIG)
                        : null);
                if (!cfg || !Array.isArray(cfg.locations) || cfg.locations.length === 0) {
                    Bus.window.post('COR3_REQUEST_ALL_EXPEDITION_CONFIGS', null);
                    return { error: 'no expedition config for market' };
                }
                const loc = cfg.locations[0];
                const zone = loc.zones && loc.zones[0];
                // Post-patch: zone.goals (was zone.objectives); launch DTO field is goalId.
                const goal = zone && zone.goals && zone.goals[0];
                if (!zone || !goal) return { error: 'incomplete expedition config' };
                // Manual sends follow the same insurance preference as auto-send
                // (autoSend.insurance) — one switch governs every plugin launch.
                const settings = (await root.COR3.Store.sync.getOne(C.STORAGE_SYNC.EXPEDITIONS_SETTINGS, null)) || {};
                const launch = {
                    mercenaryId: p.mercenaryId,
                    marketId,
                    locationConfigId: loc.id, zoneConfigId: zone.id, goalId: goal.id,
                    hasInsurance: !!(settings.autoSend && settings.autoSend.insurance),
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
