// src/modules/automation/auto-send-merc.js
// Expeditions auto-send engine (reworked).
//
// Driven by STORAGE_SYNC.EXPEDITIONS_SETTINGS:
//   { masterEnabled, autoSend:{ enabled, moneyMin, moneyMax }, disabledReason }
//
//   • masterEnabled — the tab master switch; gates ALL expedition automation.
//   • autoSend.enabled + moneyMin/moneyMax — the min/max latch:
//       arm at  CR balance ≥ moneyMax,
//       keep sending the cheapest AVAILABLE merc (one expedition at a time —
//       the server allows max 1 active) until balance ≤ moneyMin, then disarm.
//
// The engine NEVER turns itself off: when no merc is free (all RESTING /
// CONTRACTED) it just waits and a periodic poll re-checks as mercs return.
//
// Completed-run handling is gated by the MASTER switch (not auto-send):
//   • a FULL_SUCCESS raid auto-OPENS its container (reveals the loot) even with
//     auto-send off — opening only, no auto-collect.
//   • when auto-send is on, the loop additionally opens any completed run and
//     COLLECTS it (pays the postpayment) to bank loot + free the single slot.
//
// Runtime status is published to STORAGE_LOCAL.EXP_AUTOSEND_STATE for the UI.
// A soft pause (disabledReason='stash_full') stops launching without killing
// the engine; it clears automatically when the stash frees up.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Store, Registry, constants: C } = root.COR3;
    const MSG = C.MSG;

    const HOME_MARKET_ID = '019d3ea4-85bd-7389-904d-8f7c85841134';
    const POLL_MS = 20000;            // re-check balance + merc availability
    const BUSY_MS = 25000;            // max time a launch/collect RPC holds the lock

    // A single in-flight WS action (launch or collect) at a time.
    let busyUntil = 0;
    const isBusy = () => Date.now() < busyUntil;
    const lock = () => { busyUntil = Date.now() + BUSY_MS; };
    const unlock = () => { busyUntil = 0; };

    // Per-expedition collect-phase guard so we don't re-open/re-collect the
    // same run while its WS round-trip is in flight. expId -> 'opening'|'collecting'.
    const collecting = new Map();

    // ── settings (with one-time migration from legacy AUTO_SEND_MERC) ──
    async function getSettings() {
        let s = await Store.sync.getOne(C.STORAGE_SYNC.EXPEDITIONS_SETTINGS, null);
        if (!s) {
            const legacy = await Store.sync.getOne(C.STORAGE_SYNC.AUTO_SEND_MERC, null);
            s = {
                masterEnabled: false,
                autoSend: { enabled: false, moneyMin: 0, moneyMax: 0 },
                disabledReason: (legacy && legacy.disabledReason) || null,
            };
        }
        if (!s.autoSend) s.autoSend = { enabled: false, moneyMin: 0, moneyMax: 0 };
        return s;
    }
    async function patchSettings(patch) {
        const s = await getSettings();
        await Store.sync.setOne(C.STORAGE_SYNC.EXPEDITIONS_SETTINGS, { ...s, ...patch });
    }
    async function getState() {
        return (await Store.local.getOne(C.STORAGE_LOCAL.EXP_AUTOSEND_STATE, {})) || {};
    }
    async function setState(patch) {
        const cur = await getState();
        await Store.local.setOne(C.STORAGE_LOCAL.EXP_AUTOSEND_STATE,
            { armed: !!cur.armed, ...cur, ...patch, updatedAt: Date.now() });
    }

    function mercList(raw) {
        return (raw && (Array.isArray(raw) ? raw : raw.mercenaries)) || [];
    }
    function cheapestAvailable(mercs, configs) {
        const avail = mercs.filter((m) => m.status === 'AVAILABLE' && configs[m.id]);
        avail.sort((a, b) => {
            const ca = configs[a.id], cb = configs[b.id];
            const costA = Number.isFinite(ca.totalCost) ? ca.totalCost : Infinity;
            const costB = Number.isFinite(cb.totalCost) ? cb.totalCost : Infinity;
            if (costA !== costB) return costA - costB;
            const ra = Number.isFinite(ca.riskScore) ? ca.riskScore : 0;
            const rb = Number.isFinite(cb.riskScore) ? cb.riskScore : 0;
            return ra - rb;
        });
        return avail[0] || null;
    }
    async function buildLaunchConfig(merc) {
        const cfg = await Store.local.getOne(C.STORAGE_LOCAL.EXPEDITION_CONFIG);
        if (!cfg || !Array.isArray(cfg.locations) || cfg.locations.length === 0) return null;
        const loc = cfg.locations[0];
        const zone = loc.zones && loc.zones[0];
        const obj = zone && zone.objectives && zone.objectives[0];
        if (!zone || !obj) return null;
        return {
            mercenaryId: merc.id, marketId: HOME_MARKET_ID,
            locationConfigId: loc.id, zoneConfigId: zone.id, objectiveId: obj.id,
            hasInsurance: false,
        };
    }

    // ── auto-collect: open container → collect, banking loot + freeing slot ──
    function openContainer(expId, mod) {
        if (isBusy() || collecting.get(expId) === 'opening') return;
        lock(); collecting.set(expId, 'opening');
        mod.info(`expedition ${expId} COMPLETED — opening container`);
        Bus.window.post(MSG.GAME.OPEN_CONTAINER, { expeditionId: expId });
    }
    function collectAll(expId, mod) {
        if (collecting.get(expId) === 'collecting') return;
        lock(); collecting.set(expId, 'collecting');
        mod.info(`collecting loot from ${expId}`);
        Bus.window.post(MSG.GAME.COLLECT_ALL, { expeditionId: expId });
    }

    // ── the engine ──
    async function evaluate(mod) {
        const s = await getSettings();
        if (!s.masterEnabled) { await setState({ armed: false, status: 'master off' }); return; }

        const exps = (await Store.local.getOne(C.STORAGE_LOCAL.EXPEDITIONS, [])) || [];

        // 1) Handle a COMPLETED run (master-gated). Auto-OPEN the container on a
        //    FULL_SUCCESS raid even when auto-send is off (just reveals the loot).
        //    The auto-send loop additionally opens any completed run and then
        //    collects to free the slot — collecting pays the postpayment, so it
        //    only runs while auto-send is driving the loop.
        const completed = exps.find((e) => e.status === 'COMPLETED');
        if (completed) {
            const opened = Array.isArray(completed.containerData);
            const hasUncollected = opened && completed.containerData.some((i) => !i.isCollected);
            if (!opened) {
                if (completed.outcome === 'FULL_SUCCESS' || s.autoSend.enabled) {
                    openContainer(completed.id, mod);
                    await setState({ status: `opening container (${completed.outcome || 'done'})` });
                } else {
                    await setState({ status: `raid ${completed.outcome || 'done'} — open manually` });
                }
                return;
            }
            if (hasUncollected && s.autoSend.enabled) {
                collectAll(completed.id, mod);
                await setState({ status: 'collecting loot' });
                return;
            }
            if (opened && !s.autoSend.enabled) {
                await setState({ status: 'container opened — collect manually' });
                return;
            }
        }

        // 2) auto-send launch logic (requires auto-send enabled + a valid band).
        if (!s.autoSend.enabled) { await setState({ armed: false, status: 'auto-send off' }); return; }
        if (s.disabledReason) { await setState({ status: `paused: ${s.disabledReason}` }); return; }

        const min = Number(s.autoSend.moneyMin) || 0;
        const max = Number(s.autoSend.moneyMax) || 0;
        const validBand = max > 0 && max > min && min >= 0;
        if (!validBand) { await setState({ armed: false, status: 'set Money Min/Max' }); return; }

        const profile = await Store.local.getOne(C.STORAGE_LOCAL.PROFILE, null);
        const balance = profile && typeof profile.balance === 'number' ? profile.balance : null;
        if (balance == null) {
            Bus.window.post(MSG.GAME.REQUEST_PROFILE, null);
            await setState({ status: 'reading balance…' });
            return;
        }

        // 2) hysteresis latch
        const st = await getState();
        let armed = !!st.armed;
        if (balance >= max) armed = true;
        if (balance <= min) armed = false;

        if (!armed) {
            await setState({ armed: false, balance, status: `idle — balance ${balance} CR (arms at ${max})` });
            return;
        }

        // 3) one expedition at a time — wait for any in-progress run.
        const active = exps.find((e) => e.status && e.status !== 'COMPLETED');
        if (active) {
            const who = active.mercenary && active.mercenary.callsign;
            await setState({ armed: true, balance, status: `running ${who || ''} (${active.status})` });
            return;
        }

        // 4) cheapest AVAILABLE merc
        const [mercsRaw, configs] = await Promise.all([
            Store.local.getOne(C.STORAGE_LOCAL.MERCENARIES),
            Store.local.getOne(C.STORAGE_LOCAL.MERC_CONFIG, {}),
        ]);
        const mercs = mercList(mercsRaw);
        const pick = cheapestAvailable(mercs, configs || {});
        if (!pick) {
            Bus.window.post('COR3_REQUEST_MERCENARIES', null);
            await setState({ armed: true, balance, status: 'waiting for a free merc (resting)…' });
            return;
        }

        // 5) launch (cheapest), then spend down toward Min
        const cfg = await buildLaunchConfig(pick);
        if (!cfg) {
            Bus.window.post('COR3_REQUEST_EXPEDITION_CONFIG', null);
            await setState({ armed: true, balance, status: 'loading expedition config…' });
            return;
        }
        if (isBusy()) return;
        lock();
        const cost = (configs && configs[pick.id] && configs[pick.id].totalCost) || '?';
        mod.info(`auto-send: launching ${pick.callsign} (cost ${cost}); balance ${balance} → spend toward ${min}`);
        await setState({ armed: true, balance, status: `sending ${pick.callsign}…` });
        Store.local.setOne(C.STORAGE_LOCAL.LAST_LAUNCH, cfg);
        Bus.window.post(MSG.GAME.LAUNCH_EXPEDITION, { config: cfg });
        // refresh shortly after; unlock so the next cycle can proceed.
        setTimeout(() => {
            unlock();
            Bus.window.post(MSG.GAME.REQUEST_EXPEDITIONS, null);
            Bus.window.post('COR3_REQUEST_MERCENARIES', null);
            Bus.window.post(MSG.GAME.REQUEST_PROFILE, null);
        }, 4000);
    }

    class AutoSendMercModule extends Module {
        constructor() {
            super({
                id: 'auto-send-merc',
                name: 'Auto-send mercenary',
                category: C.CATEGORY.AUTOMATION,
                dependsOn: ['expeditions', 'mercenaries', 'merc-config', 'expedition-config', 'stash', 'profile'],
                owns: { storageKeys: [C.STORAGE_SYNC.EXPEDITIONS_SETTINGS, C.STORAGE_LOCAL.EXP_AUTOSEND_STATE] },
            });
        }
        async start() {
            const ev = () => evaluate(this);

            // Re-evaluate on every relevant signal.
            this.track(Bus.window.on(C.MSG.WS.EXPEDITIONS, ev));
            this.track(Bus.window.on(C.MSG.WS.MERCENARIES, ev));
            this.track(Bus.window.on(C.MSG.WS.PROFILE, ev));

            // Container/collect chain. After an auto-open, only the auto-send loop
            // auto-collects (collecting pays the postpayment). A master-only
            // FULL_SUCCESS auto-open just reveals the loot — the user collects it.
            this.track(Bus.window.on(C.MSG.WS.CONTAINER_OPENED, async () => {
                unlock();
                const s = await getSettings();
                if (!s.masterEnabled || !s.autoSend.enabled) { collecting.clear(); return; }
                for (const [id, phase] of collecting) {
                    if (phase === 'opening') { collectAll(id, this); break; }
                }
            }));
            this.track(Bus.window.on(C.MSG.WS.COLLECTED_ALL, () => {
                unlock();
                collecting.clear();
                this.info('loot collected — refreshing + evaluating next send');
                Bus.window.post(MSG.GAME.REQUEST_EXPEDITIONS, null);
                Bus.window.post('COR3_REQUEST_STASH', null);
                Bus.window.post(MSG.GAME.REQUEST_PROFILE, null);
                setTimeout(ev, 1500);
            }));

            // Soft pause on blockers — DON'T hard-disable, just record a reason.
            this.track(Bus.window.on('COR3_WS_STASH_FULL', async () => {
                this.warn('stash full — pausing auto-send until space frees up');
                await patchSettings({ disabledReason: 'stash_full' });
                unlock(); collecting.clear();
            }));
            this.track(Bus.window.on(C.MSG.WS.INSUFFICIENT_CREDITS, async () => {
                this.warn('insufficient credits — pausing auto-send');
                await patchSettings({ disabledReason: 'insufficient_credits' });
                unlock();
            }));
            // Stash freed → clear a stash_full pause.
            this.track(Bus.window.on(C.MSG.WS.STASH, async (env) => {
                const s = await getSettings();
                if (s.disabledReason !== 'stash_full') return;
                const stash = env && env.stash;
                if (stash && stash.maxCapacity && stash.availableSpace >= 2) {
                    this.info('stash has space again — resuming auto-send');
                    await patchSettings({ disabledReason: null });
                    ev();
                }
            }));

            // Launch error (e.g. "Maximum 1 active expedition allowed"): just
            // back off — the active run will complete and free the slot.
            this.track(Bus.window.on(C.MSG.WS.EXPEDITION_LAUNCH_ERROR, () => { unlock(); }));

            // React to settings toggles immediately.
            this.track(Store.sync.onChanged((changes) => {
                if (changes[C.STORAGE_SYNC.EXPEDITIONS_SETTINGS]) ev();
            }));

            // Keep-alive poll: catches RESTING→AVAILABLE, balance drift, and any
            // missed push. Refreshes profile + mercs while armed/needed.
            const poll = setInterval(async () => {
                const s = await getSettings();
                if (!s.masterEnabled) return;
                // Always refresh expeditions while master is on so a completed run
                // is caught for auto-open even if auto-send is off / the in-game
                // Expeditions widget is closed (no game-driven get.active then).
                Bus.window.post(MSG.GAME.REQUEST_EXPEDITIONS, null);
                if (s.autoSend.enabled) {
                    Bus.window.post(MSG.GAME.REQUEST_PROFILE, null);
                    Bus.window.post('COR3_REQUEST_MERCENARIES', null);
                }
                setTimeout(ev, 1500);
            }, POLL_MS);
            this.track(() => clearInterval(poll));

            // Seed a profile snapshot once on start.
            Bus.window.post(MSG.GAME.REQUEST_PROFILE, null);
            await evaluate(this);
            this.info('auto-send engine ready (min/max latch)');
        }
    }

    Registry.register(new AutoSendMercModule());
})();
