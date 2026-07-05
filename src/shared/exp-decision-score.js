// src/shared/exp-decision-score.js
// ONE shared scoring formula for expedition decision options — used by the
// auto-choose-decision module (to answer) AND the popup's Pending-decisions
// list (to display per-option scores + the would-be pick), so what the user
// sees is EXACTLY what the engine does.
//
// Wire scales are asymmetric (verified live): lootModifier runs ±20..50 while
// riskModifier runs only ±5..10. The old score `loot − risk·((10−t)/5)` gave
// risk a max weight of 2, so a big-loot option beat every risk-reducing one
// at ANY threshold — the slider was effectively decorative and auto-choose
// "always picked the risky option". The weight now spans 0..10:
//
//   riskWeight = 10 − threshold          // threshold 0..10
//   score(opt) = lootModifier − riskModifier · riskWeight
//
//   threshold 10 → weight 0  — pure loot-max, risk ignored;
//   threshold 5  → weight 5  — risk ±10 competes with loot ±50;
//   threshold 0  → weight 10 — risk dominates: a +10-risk option needs
//                              +100 loot to break even (never happens live).
//
// Ties break toward the LOWER riskModifier, then the earlier option.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    root.COR3 = root.COR3 || {};

    function score(opt, threshold) {
        const loot = Number(opt.lootModifier) || 0;
        const risk = Number(opt.riskModifier) || 0;
        const riskWeight = 10 - Math.max(0, Math.min(10, Number(threshold) || 0));
        return loot - (risk * riskWeight);
    }

    // Returns { best, scores } — `scores[i]` matches options[i]; `best` is the
    // option auto-choose would answer with (null for an empty list).
    function pick(options, threshold) {
        const scores = (options || []).map((o) => score(o, threshold));
        let best = null, bestS = -Infinity, bestRisk = Infinity;
        (options || []).forEach((opt, i) => {
            const s = scores[i];
            const risk = Number(opt.riskModifier) || 0;
            if (s > bestS || (s === bestS && risk < bestRisk)) {
                bestS = s; bestRisk = risk; best = opt;
            }
        });
        return { best, scores };
    }

    root.COR3.expDecision = { score, pick };
})();
