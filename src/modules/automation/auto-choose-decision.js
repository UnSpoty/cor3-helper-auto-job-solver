// When the Expeditions master switch is ON and `autoChooseEnabled` is true,
// auto-pick the highest-scoring option for any pending (unresolved) expedition
// decision. Scoring lives in the SHARED src/shared/exp-decision-score.js
// (COR3.expDecision — also rendered per-option in the popup's Pending list):
//
// Score(opt) = lootModifier - riskModifier * (10 - riskThreshold)
//   threshold 0 → risk weight 10 (risk-averse: +10 risk needs +100 loot),
//   threshold 10 → weight 0 (pure loot-max). The OLD weight (10-t)/5 maxed
//   at 2 while the wire scales are loot ±20..50 vs risk ±5..10, so loot
//   always won and the slider did nothing — the "always picks the risky
//   option" bug. Ties break toward the lower riskModifier.
//
// NOTE: we do NOT gate on `decisionDeadline` — it comes through as `null` on
// the wire (verified live), and a decision pauses the raid at status=EVENT
// until answered (or the server auto-defaults to the safe option on timeout),
// so we respond promptly instead of waiting for a (non-existent) countdown.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Store, Registry, constants: C } = root.COR3;

    // messageId -> last auto-pick attempt ts. A Map (not a Set) so a dropped
    // RESPOND_DECISION can be retried after a cooldown, and so entries are
    // pruned once their decision is gone (the old Set blacklisted a messageId
    // forever and grew unbounded for the page lifetime).
    const chosen = new Map();
    const RETRY_AFTER_MS = 15_000;

    async function getSettings() {
        const [exp, enabled, threshold] = await Promise.all([
            Store.sync.getOne(C.STORAGE_SYNC.EXPEDITIONS_SETTINGS, null),
            Store.sync.getOne(C.STORAGE_SYNC.AUTO_CHOOSE_ENABLED, false),
            Store.sync.getOne(C.STORAGE_SYNC.RISK_THRESHOLD, 5),
        ]);
        // Master switch (#2) gates ALL expedition automation.
        const master = !!(exp && exp.masterEnabled);
        // Shared clamp (exp-decision-score.js): 0 is a valid position — the
        // old `Number(threshold) || 5` swallowed it into the default, so the
        // engine ran at 5 while the popup previewed 0 (mismatched picks).
        return { master, enabled: !!enabled, threshold: root.COR3.expDecision.clampThreshold(threshold) };
    }

    async function tick(mod) {
        const { master, enabled, threshold } = await getSettings();
        if (!master || !enabled) return;
        const decisions = (await Store.local.getOne(C.STORAGE_LOCAL.DECISIONS, [])) || [];
        if (decisions.length === 0) return;

        // Prune attempts for decisions that are gone (resolved/expired) so the
        // map can't grow unbounded for the page lifetime.
        const present = new Set(decisions.map((d) => d.messageId));
        for (const id of [...chosen.keys()]) if (!present.has(id)) chosen.delete(id);

        for (const d of decisions) {
            if (d.isResolved || !Array.isArray(d.decisionOptions) || d.decisionOptions.length === 0) continue;
            // Skip only if we attempted recently — a dropped/failed
            // RESPOND_DECISION is retried after RETRY_AFTER_MS rather than being
            // blacklisted forever. (No decisionDeadline gating: it's null on the
            // wire and the raid is paused at EVENT until we answer.)
            const last = chosen.get(d.messageId);
            if (last != null && (Date.now() - last) < RETRY_AFTER_MS) continue;

            const { best, scores } = root.COR3.expDecision.pick(d.decisionOptions, threshold);
            if (!best) continue;

            chosen.set(d.messageId, Date.now());
            const bestS = scores[d.decisionOptions.indexOf(best)];
            mod.info(`auto-choosing "${best.label}" (risk ${best.riskModifier > 0 ? '+' : ''}${best.riskModifier || 0}, `
                + `loot ${best.lootModifier > 0 ? '+' : ''}${best.lootModifier || 0}) score=${bestS} threshold=${threshold}`);
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
