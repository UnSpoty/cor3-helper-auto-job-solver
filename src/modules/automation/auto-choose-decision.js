// When `autoChooseEnabled` is true and there's a pending expedition decision
// with < 60s remaining, auto-pick the option whose score is highest.
// Score formula uses a single user-tunable `riskThreshold` (0..10).
//
// Score(opt) = lootModifier - (riskModifier * riskWeight)
//   where riskWeight = (10 - riskThreshold) / 5  (so threshold=0 → strong
//   penalty for risk, threshold=10 → ignore risk).
// Ties broken by lower riskModifier.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Store, Registry, constants: C } = root.COR3;

    const chosen = new Set();

    async function getSettings() {
        const enabled = await Store.sync.getOne(C.STORAGE_SYNC.AUTO_CHOOSE_ENABLED, false);
        const threshold = await Store.sync.getOne(C.STORAGE_SYNC.RISK_THRESHOLD, 5);
        return { enabled: !!enabled, threshold: Math.max(0, Math.min(10, Number(threshold) || 5)) };
    }

    function score(opt, threshold) {
        const loot = Number(opt.lootModifier) || 0;
        const risk = Number(opt.riskModifier) || 0;
        const riskWeight = (10 - threshold) / 5;
        return loot - (risk * riskWeight);
    }

    async function tick(mod) {
        const { enabled, threshold } = await getSettings();
        if (!enabled) return;
        const decisions = (await Store.local.getOne(C.STORAGE_LOCAL.DECISIONS, [])) || [];
        if (decisions.length === 0) return;

        for (const d of decisions) {
            if (d.isResolved || !d.decisionDeadline || !Array.isArray(d.decisionOptions)) continue;
            if (chosen.has(d.messageId)) continue;
            const remaining = new Date(d.decisionDeadline).getTime() - Date.now();
            if (remaining <= 0) continue;
            if (remaining > 60_000) continue;

            let best = null, bestS = -Infinity;
            for (const opt of d.decisionOptions) {
                const s = score(opt, threshold);
                if (s > bestS) { bestS = s; best = opt; }
            }
            if (!best) continue;

            chosen.add(d.messageId);
            mod.info(`auto-choosing "${best.label}" score=${bestS.toFixed(2)} threshold=${threshold}`);
            Bus.window.post(C.MSG.GAME.RESPOND_DECISION, {
                expeditionId: d.expeditionId,
                messageId: d.messageId,
                selectedOption: best.id,
            });
            // Refresh expedition data shortly after to pick up resolution
            setTimeout(() => Bus.window.post(C.MSG.GAME.REQUEST_EXPEDITIONS, null), 3000);
        }
    }

    class AutoChooseDecisionModule extends Module {
        constructor() {
            super({
                id: 'auto-choose-decision',
                name: 'Auto-choose decision',
                category: C.CATEGORY.AUTOMATION,
                dependsOn: ['decisions', 'expeditions'],
                owns: { storageKeys: [C.STORAGE_SYNC.AUTO_CHOOSE_ENABLED, C.STORAGE_SYNC.RISK_THRESHOLD] },
            });
        }
        async start() {
            const id = setInterval(() => tick(this), 10_000);
            this.track(() => clearInterval(id));
            this.info('auto-choose-decision ready');
        }
    }

    Registry.register(new AutoChooseDecisionModule());
})();
