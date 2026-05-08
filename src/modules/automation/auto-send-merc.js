// src/modules/automation/auto-send-merc.js
// On expedition data: detect a COMPLETED expedition, open container, collect
// rewards, request mercenaries, pick the cheapest AVAILABLE one (or the user's
// pinned mercenary), and launch the next expedition.
// Owned: chrome.storage.sync.autoSendMerc, chrome.storage.local.lastExpeditionLaunchData.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Store, Registry, constants: C } = root.COR3;
    const MSG = C.MSG;

    let inProgress = false;
    let expeditionId = null;
    let awaitingMercenaries = false;
    let startedAt = 0;

    async function getSettings() {
        return (await Store.sync.getOne(C.STORAGE_SYNC.AUTO_SEND_MERC, null)) || null;
    }

    async function checkOnExpeditionData(expeditions, mod) {
        if (!Array.isArray(expeditions) || inProgress) return;
        const settings = await getSettings();
        if (!settings || !settings.enabled) return;
        if (!settings.mercenaryId && !settings.autoChooseMerc) return;

        if (expeditions.length === 0) {
            mod.info('no active expeditions — proceeding directly to mercenary launch');
            inProgress = true;
            startedAt = Date.now();
            expeditionId = null;
            awaitingMercenaries = true;
            setTimeout(() => Bus.window.post('COR3_REQUEST_MERCENARIES', null), 1000 + Math.floor(Math.random() * 500));
            return;
        }

        for (const exp of expeditions) {
            if (exp.status === 'COMPLETED' && !exp.completedAt) {
                inProgress = true;
                startedAt = Date.now();
                expeditionId = exp.id;
                if (!exp.containerOpenedAt) {
                    mod.info(`expedition ${exp.id} COMPLETED — opening container`);
                    setTimeout(() => Bus.window.post(MSG.GAME.OPEN_CONTAINER, { expeditionId: exp.id }), 1000 + Math.floor(Math.random() * 500));
                } else {
                    mod.info(`expedition ${exp.id} container already open — collecting`);
                    setTimeout(() => Bus.window.post(MSG.GAME.COLLECT_ALL, { expeditionId: exp.id }), 1000 + Math.floor(Math.random() * 500));
                }
                return;
            }
        }
    }

    async function onContainerOpened(data, mod) {
        if (!inProgress || !expeditionId) return;
        let spaceNeeded = 2;
        if (data && Array.isArray(data.items)) spaceNeeded = data.items.length;
        else if (data && Array.isArray(data.containerItems)) spaceNeeded = data.containerItems.length;

        const stash = await Store.local.getOne(C.STORAGE_LOCAL.STASH);
        let hasSpace = true;
        if (stash && stash.maxCapacity && stash.currentUsage !== undefined) {
            hasSpace = (stash.maxCapacity - stash.currentUsage) >= spaceNeeded;
        }
        if (hasSpace) {
            mod.info(`container opened, sufficient space (need ${spaceNeeded}) — collecting`);
            setTimeout(() => Bus.window.post(MSG.GAME.COLLECT_ALL, { expeditionId }), 1000 + Math.floor(Math.random() * 500));
        } else {
            mod.warn('stash full — disabling auto-send');
            const settings = await getSettings();
            if (settings) {
                await Store.sync.setOne(C.STORAGE_SYNC.AUTO_SEND_MERC, {
                    ...settings, enabled: false, disabledReason: 'stash_full',
                });
            }
            inProgress = false;
        }
    }

    async function onCollectedAll(_data, mod) {
        if (!inProgress || !expeditionId) return;
        mod.info('all collected — requesting fresh stash + mercenaries');
        expeditionId = null;
        setTimeout(() => Bus.window.post('COR3_REQUEST_STASH', null), 500);
        setTimeout(() => Bus.window.post('COR3_REQUEST_MERCENARIES', null), 2500 + Math.floor(Math.random() * 1000));
        awaitingMercenaries = true;
    }

    async function onMercenaries(data, mod) {
        if (!awaitingMercenaries) return;
        awaitingMercenaries = false;

        const settings = await getSettings();
        if (!settings || !settings.enabled) {
            inProgress = false;
            return;
        }
        let mercs = data;
        if (mercs && !Array.isArray(mercs) && mercs.mercenaries) mercs = mercs.mercenaries;
        if (!Array.isArray(mercs)) {
            mod.warn('cannot parse mercenary list — aborting');
            inProgress = false;
            return;
        }

        let mercId = settings.mercenaryId;
        if (settings.autoChooseMerc) {
            const configs = (await Store.local.getOne(C.STORAGE_LOCAL.MERC_CONFIG, {})) || {};
            const available = mercs.filter((m) => m.status === 'AVAILABLE' && configs[m.id]);
            if (available.length > 0) {
                available.sort((a, b) => {
                    const costA = (configs[a.id] && configs[a.id].totalCost) || Infinity;
                    const costB = (configs[b.id] && configs[b.id].totalCost) || Infinity;
                    if (costA !== costB) return costA - costB;
                    const riskA = (configs[a.id] && configs[a.id].riskScore) || 0;
                    const riskB = (configs[b.id] && configs[b.id].riskScore) || 0;
                    return riskA - riskB;
                });
                mercId = available[0].id;
                mod.info(`auto-chose merc ${available[0].callsign} cost=${configs[available[0].id].totalCost}`);
            }
        }

        await proceedWithMerc(mercId, mercs, mod);
    }

    async function proceedWithMerc(mercId, mercs, mod) {
        if (!mercId) { mod.warn('no mercenary selected'); inProgress = false; return; }
        const sel = mercs.find((m) => m.id === mercId);
        if (!sel || sel.status !== 'AVAILABLE') {
            mod.warn(`selected mercenary not AVAILABLE: ${sel ? sel.status : 'not found'}`);
            inProgress = false;
            return;
        }

        const cfg = await Store.local.getOne(C.STORAGE_LOCAL.EXPEDITION_CONFIG);
        if (!cfg || !cfg.locations || cfg.locations.length === 0) {
            mod.warn('no expedition config — aborting');
            inProgress = false;
            return;
        }
        const loc = cfg.locations[0];
        const zone = loc.zones && loc.zones[0];
        const obj = zone && zone.objectives && zone.objectives[0];
        if (!zone || !obj) { mod.warn('missing zone/objective config'); inProgress = false; return; }

        const launchConfig = {
            mercenaryId: mercId,
            marketId: '019d3ea4-85bd-7389-904d-8f7c85841134',
            locationConfigId: loc.id,
            zoneConfigId: zone.id,
            objectiveId: obj.id,
            hasInsurance: false,
        };
        mod.info(`launching expedition with merc ${sel.callsign}`);
        setTimeout(() => {
            Store.local.setOne(C.STORAGE_LOCAL.LAST_LAUNCH, launchConfig);
            Bus.window.post(MSG.GAME.LAUNCH_EXPEDITION, { config: launchConfig });
            setTimeout(() => Bus.window.post(MSG.GAME.REQUEST_EXPEDITIONS, null), 1000);
            setTimeout(() => { Bus.window.post('COR3_REQUEST_MERCENARIES', null); inProgress = false; }, 2000);
        }, 1500 + Math.floor(Math.random() * 500));
    }

    async function reEnableIfStashFreed(stash, mod) {
        const settings = await getSettings();
        if (!settings || settings.disabledReason !== 'stash_full' || settings.enabled) return;
        let hasSpace = false;
        if (stash && stash.maxCapacity && stash.currentUsage !== undefined) {
            hasSpace = (stash.maxCapacity - stash.currentUsage) >= 2;
        }
        if (hasSpace) {
            mod.info('stash has space again — re-enabling auto-send');
            await Store.sync.setOne(C.STORAGE_SYNC.AUTO_SEND_MERC, {
                ...settings, enabled: true, disabledReason: null,
            });
        }
    }

    class AutoSendMercModule extends Module {
        constructor() {
            super({
                id: 'auto-send-merc',
                name: 'Auto-send mercenary',
                category: C.CATEGORY.AUTOMATION,
                dependsOn: ['expeditions', 'mercenaries', 'merc-config', 'expedition-config', 'stash'],
                owns: { storageKeys: [C.STORAGE_SYNC.AUTO_SEND_MERC] },
            });
        }
        async start() {
            this.track(Bus.window.on(C.MSG.WS.EXPEDITIONS, (env) => checkOnExpeditionData(env.expeditions, this)));
            this.track(Bus.window.on(C.MSG.WS.CONTAINER_OPENED, (env) => onContainerOpened(env.data, this)));
            this.track(Bus.window.on(C.MSG.WS.COLLECTED_ALL, (env) => onCollectedAll(env.data, this)));
            this.track(Bus.window.on(C.MSG.WS.MERCENARIES, (env) => onMercenaries(env.data, this)));

            this.track(Bus.window.on(C.MSG.WS.STASH, (env) => reEnableIfStashFreed(env.stash, this)));

            this.track(Bus.window.on('COR3_WS_STASH_FULL', async () => {
                this.warn('stash full from collect.all — disabling auto-send');
                const s = await getSettings();
                if (s) await Store.sync.setOne(C.STORAGE_SYNC.AUTO_SEND_MERC, { ...s, enabled: false, disabledReason: 'stash_full' });
                inProgress = false; expeditionId = null;
            }));
            this.track(Bus.window.on(C.MSG.WS.INSUFFICIENT_CREDITS, async () => {
                this.warn('insufficient credits — disabling auto-send');
                const s = await getSettings();
                if (s) await Store.sync.setOne(C.STORAGE_SYNC.AUTO_SEND_MERC, { ...s, enabled: false, disabledReason: 'insufficient_credits' });
                inProgress = false; expeditionId = null;
            }));
            this.track(Bus.window.on(C.MSG.WS.EXPEDITION_LAUNCH_ERROR, (env) => {
                Store.local.setOne(C.STORAGE_LOCAL.LAUNCH_ERROR, {
                    error: env.error, retryAfter: env.retryAfter, timestamp: Date.now(),
                });
            }));
            this.track(Bus.window.on(C.MSG.WS.EXPEDITION_RETRY_LAUNCH, async () => {
                const last = await Store.local.getOne(C.STORAGE_LOCAL.LAST_LAUNCH);
                if (last) Bus.window.post('COR3_RELAUNCH_EXPEDITION', { data: last });
            }));

            // Watchdog: if stuck >120s, reset
            const wd = setInterval(() => {
                if (inProgress && startedAt > 0 && Date.now() - startedAt > 120000) {
                    this.warn('auto-send stuck >120s — resetting');
                    inProgress = false; expeditionId = null; awaitingMercenaries = false; startedAt = 0;
                }
            }, 5000);
            this.track(() => clearInterval(wd));
            this.info('auto-send-merc ready');
        }
    }

    Registry.register(new AutoSendMercModule());
})();
