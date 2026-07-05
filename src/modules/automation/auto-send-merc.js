// src/modules/automation/auto-send-merc.js
// Expeditions auto-send engine (reworked).
//
// Driven by STORAGE_SYNC.EXPEDITIONS_SETTINGS:
//   { masterEnabled,
//     autoSend:{ enabled, moneyMin, moneyMax, minCost, maxCost,
//                insurance, includeElite, marketsDisabled[] },
//     disabledReason }
//
//   • masterEnabled — the tab master switch; gates ALL expedition automation.
//   • autoSend.enabled + moneyMin/moneyMax — the min/max latch:
//       arm at  CR balance ≥ moneyMax,
//       keep sending the cheapest AVAILABLE merc (one expedition at a time —
//       the server allows max 1 active) until balance ≤ moneyMin, then disarm.
//   • The candidate pool spans ALL markets the player can launch from (a market
//     is launchable iff get.config returned ≥1 location). marketsDisabled[] is
//     the set of market ids turned OFF for auto-send (absent === enabled).
//     includeElite (default ON, absent === on) also pools each market's
//     UNLOCKED elite slots — an unlocked elite embeds a full standard
//     mercenary object and launches through the ordinary configure/launch
//     RPCs (verified live 2026-07-05, Vector/USOL).
//   • Cost band on the priced pool (each side 0 === off): minCost/maxCost
//     drop a merc whose totalCost is outside the band. The cheapest surviving
//     merc is launched FROM ITS market with that market's location/zone/goal
//     (risk only tie-breaks equal costs — raid-time risk appetite is the
//     auto-choose Risk-threshold slider's job, not a second send-side knob).
//   • insurance (default OFF) — order the in-game insurance on every launch:
//     the cost-preview cascade prices WITH hasInsurance:true (the premium is
//     included in totalCost, so the cost band filters the REAL spend) and the
//     launch payload carries hasInsurance:true. The engine only trusts prices
//     whose stored `_insured` flag matches the setting; flipping it re-prices
//     the pool (stale entries are treated as unpriced, never mixed).
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

    const POLL_MS = 20000;            // re-check balance + merc availability
    const BUSY_MS = 25000;            // max time a launch/collect RPC holds the lock

    // A single in-flight WS action (launch or collect) at a time.
    // Single in-flight RPC guard — TIME-BOUNDED so a dropped reply (e.g. WS not
    // ready right after a reload) self-heals: busy auto-expires and the next
    // evaluate retries from the live data state (no permanent per-exp guard,
    // which previously stuck "opening" forever when an open got dropped).
    let busyUntil = 0;
    const isBusy = () => Date.now() < busyUntil;
    const lock = () => { busyUntil = Date.now() + BUSY_MS; };
    const unlock = () => { busyUntil = 0; };

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

    const marketLabel = (id) => {
        const m = (C.MARKETS || []).find((x) => x.id === id);
        return m ? m.label : id;
    };

    // First launchable (location, zone, goal) triple of a market's config.
    // A market whose get.config returned 0 locations (live: DARK/SRM) yields
    // null → that market is NOT a launch target.
    function launchTriple(cfg) {
        const loc = cfg && Array.isArray(cfg.locations) && cfg.locations[0];
        const zone = loc && loc.zones && loc.zones[0];
        // Post-patch: zone.goals (was zone.objectives); launch DTO field is goalId.
        const goal = zone && zone.goals && zone.goals[0];
        if (!loc || !zone || !goal) return null;
        return { locationConfigId: loc.id, zoneConfigId: zone.id, goalId: goal.id };
    }

    // Build the auto-send candidate pool across ENABLED, launchable markets.
    // A candidate is an AVAILABLE merc (regular, or an UNLOCKED elite slot's
    // embedded merc when includeElite) whose totalCost is known from a
    // configure cost-preview PRICED WITH the current insurance setting
    // (entry `_insured` must match — a price from the other insurance mode is
    // treated as pending, never mixed in). Returns the priced pool plus
    // counts so the caller can explain an empty pool (no free merc / costs
    // still loading / all outside the cost/risk gates).
    function buildCandidates(mercMarkets, configs, expConfigs, disabledSet, opts) {
        const candidates = [];
        let availableCount = 0;
        const wantInsured = !!opts.insurance;
        const push = (merc, marketId, triple, elite) => {
            availableCount++;
            const mc = configs[merc.id];
            if (!mc || !Number.isFinite(mc.totalCost)) return;   // cost preview pending
            if (!!mc._insured !== wantInsured) return;           // priced in the other insurance mode
            candidates.push({
                merc, marketId, triple, elite,
                cost: mc.totalCost,
                risk: Number.isFinite(mc.riskScore) ? mc.riskScore : 0,
            });
        };
        for (const m of (C.MARKETS || [])) {
            if (disabledSet.has(m.id)) continue;
            const triple = launchTriple(expConfigs[m.id]);
            if (!triple) continue;  // market not launchable (or its config not fetched yet)
            const data = mercMarkets[m.id];
            const mercs = (data && Array.isArray(data.mercenaries)) ? data.mercenaries : [];
            for (const merc of mercs) {
                if (merc.status !== 'AVAILABLE') continue;
                push(merc, m.id, triple, false);
            }
            if (opts.includeElite) {
                const elites = (data && Array.isArray(data.eliteSlots)) ? data.eliteSlots : [];
                for (const slot of elites) {
                    // After a launch the slot stays UNLOCKED and only the embedded
                    // mercenary.status flips to CONTRACTED (verified live).
                    if (!slot || slot.state !== 'UNLOCKED' || !slot.mercenary) continue;
                    if (slot.mercenary.status !== 'AVAILABLE') continue;
                    push(slot.mercenary, m.id, triple, true);
                }
            }
        }
        return { candidates, availableCount, pricedCount: candidates.length };
    }

    // ── auto-collect: open container → collect, banking loot + freeing slot ──
    // Both are guarded only by the time-bounded `busy` lock and driven by the
    // live data state (containerData null → open; opened+uncollected → collect),
    // so a dropped RPC self-heals on the next evaluate.
    function openContainer(expId, mod) {
        if (isBusy()) return;
        lock();
        mod.info(`expedition ${expId} COMPLETED — opening container`);
        Bus.window.post(MSG.GAME.OPEN_CONTAINER, { expeditionId: expId });
    }
    function collectAll(expId, mod) {
        if (isBusy()) return;
        lock();
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

        // 4) cheapest AVAILABLE merc across ENABLED markets, within the cost band.
        const [mercMarkets, configs, expConfigs] = await Promise.all([
            Store.local.getOne(C.STORAGE_LOCAL.MERC_MARKETS, {}),
            Store.local.getOne(C.STORAGE_LOCAL.MERC_CONFIG, {}),
            Store.local.getOne(C.STORAGE_LOCAL.EXPEDITION_CONFIGS, {}),
        ]);
        const disabledSet = new Set(Array.isArray(s.autoSend.marketsDisabled) ? s.autoSend.marketsDisabled : []);
        const num = (v) => Math.max(0, Math.floor(Number(v) || 0));  // 0 = gate off
        const minCost = num(s.autoSend.minCost);
        const maxCost = num(s.autoSend.maxCost);
        const insurance = !!s.autoSend.insurance;
        const includeElite = s.autoSend.includeElite !== false;  // absent === on
        const { candidates, availableCount, pricedCount } =
            buildCandidates(mercMarkets || {}, configs || {}, expConfigs || {}, disabledSet,
                { insurance, includeElite });
        let pool = candidates;
        if (minCost > 0) pool = pool.filter((c) => c.cost >= minCost);
        if (maxCost > 0) pool = pool.filter((c) => c.cost <= maxCost);
        pool.sort((a, b) => (a.cost - b.cost) || (a.risk - b.risk));
        const pick = pool[0] || null;
        if (!pick) {
            // Refresh all rosters — delivering a market's mercs lazily fetches
            // that market's config (and re-cascades cost previews), so this one
            // request heals both a missing launch triple and missing costs.
            Bus.window.post('COR3_REQUEST_ALL_MERCENARIES', null);
            let status;
            if (availableCount === 0) status = 'waiting for a free merc (resting)…';
            else if (pricedCount === 0) status = insurance ? 'loading insured merc costs…' : 'loading merc costs…';
            else {
                status = (minCost > 0 || maxCost > 0)
                    ? `all ${pricedCount} free merc(s) outside cost ${minCost || 0}–${maxCost || '∞'} CR`
                    : 'no eligible merc';
            }
            await setState({ armed: true, balance, status });
            return;
        }

        // 5) launch the cheapest pick from ITS market, then spend down toward Min.
        if (isBusy()) return;
        lock();
        mod.info(`auto-send: launching ${pick.elite ? 'ELITE ' : ''}${pick.merc.callsign} from ${marketLabel(pick.marketId)} `
            + `(cost ${pick.cost}, risk ${pick.risk}${insurance ? ', insured' : ''}); balance ${balance} → spend toward ${min}`);
        await setState({ armed: true, balance, status: `sending ${pick.merc.callsign}…` });
        const cfg = {
            mercenaryId: pick.merc.id, marketId: pick.marketId,
            locationConfigId: pick.triple.locationConfigId,
            zoneConfigId: pick.triple.zoneConfigId,
            goalId: pick.triple.goalId,
            hasInsurance: insurance,
        };
        Store.local.setOne(C.STORAGE_LOCAL.LAST_LAUNCH, cfg);
        Bus.window.post(MSG.GAME.LAUNCH_EXPEDITION, { config: cfg });
        // refresh shortly after; unlock so the next cycle can proceed.
        setTimeout(() => {
            unlock();
            Bus.window.post(MSG.GAME.REQUEST_EXPEDITIONS, null);
            Bus.window.post('COR3_REQUEST_ALL_MERCENARIES', null);
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

            // Container/collect chain is data-driven: open.container now pushes the
            // opened expedition into storage, so re-evaluating after each step sees
            // the true state (opened+uncollected → collect if auto-send; master-only
            // FULL_SUCCESS auto-open just reveals the loot, no auto-collect).
            this.track(Bus.window.on(C.MSG.WS.CONTAINER_OPENED, () => { unlock(); ev(); }));
            this.track(Bus.window.on(C.MSG.WS.COLLECTED_ALL, () => {
                unlock();
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
                unlock();
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

            // Keep MAIN's cost-preview cascade in the same insurance mode as
            // the setting. On a flip, re-request all rosters so every merc is
            // re-priced in the new mode (old prices are `_insured`-mismatched
            // and already excluded from the pool).
            let lastInsurance = null;
            const syncPreviewPrefs = async () => {
                const s = await getSettings();
                const insurance = !!s.autoSend.insurance;
                Bus.window.post(MSG.GAME.EXP_PREVIEW_PREFS, { insurance });
                if (lastInsurance !== null && lastInsurance !== insurance) {
                    this.info(`insurance ${insurance ? 'ON' : 'OFF'} — re-pricing all mercs`);
                    Bus.window.post('COR3_REQUEST_ALL_MERCENARIES', null);
                }
                lastInsurance = insurance;
            };

            // React to settings toggles immediately.
            this.track(Store.sync.onChanged((changes) => {
                if (changes[C.STORAGE_SYNC.EXPEDITIONS_SETTINGS]) { syncPreviewPrefs(); ev(); }
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
                    Bus.window.post('COR3_REQUEST_ALL_MERCENARIES', null);
                }
                setTimeout(ev, 1500);
            }, POLL_MS);
            this.track(() => clearInterval(poll));

            // Seed a profile snapshot + all-market rosters once on start. Push
            // the insurance preview mode FIRST so the initial cascade prices in
            // the right mode. Each roster delivery lazily fetches its market's
            // config + prices its mercs, so the multi-market pool fills in
            // without a separate config sweep here.
            await syncPreviewPrefs();
            Bus.window.post(MSG.GAME.REQUEST_PROFILE, null);
            Bus.window.post('COR3_REQUEST_ALL_MERCENARIES', null);
            await evaluate(this);
            this.info('auto-send engine ready (min/max latch · multi-market · elite + insurance aware)');
        }
    }

    Registry.register(new AutoSendMercModule());
})();
