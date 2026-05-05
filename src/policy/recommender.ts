// Heuristic policy recommender. Given an agent's recent token volume + the
// user's budget + a quality/cost preference, produce 1–3 ranked suggestions
// with an estimated daily cost and an executable apply command.
//
// Deliberately simple — no ML, no historical regression. The math is: given
// historical avg tokens/day, what would each candidate model cost? For
// cascade we approximate "premium until $T, then cheap fallback".

import type { Protocol } from "../agents/types.js";
import { listCandidateModels, type ModelMeta } from "../runs/pricing.js";
import type { AgentHistory } from "../runs/analytics.js";

export type Preference = "quality" | "balanced" | "cost";

export type Suggestion = {
  rationale: string;
  policy: {
    primary: { provider: string; model: string };
    fallback: { provider: string; model: string } | null;
    cascade: { triggerSpendDay: number; cheaper: { provider: string; model: string } } | null;
  };
  estimatedSpendDay: number | null;
  applyCommand: string;
};

export type RecommendInput = {
  agent: string;
  protocol: Protocol;
  history: AgentHistory;
  budgetDay: number | null;
  preference: Preference;
};

const DEFAULT_BUDGET_DAY = 5; // USD; used when no history + no budget given

type Tagged = { kind: "pure-premium" | "cascade" | "pure-cheap"; suggestion: Suggestion };

export async function recommend(input: RecommendInput): Promise<Suggestion[]> {
  const candidates = await listCandidateModels(input.protocol);
  const premium = pickByTier(candidates, "premium");
  const balanced = pickByTier(candidates, "balanced") ?? premium ?? null;
  const cheap = pickByTier(candidates, "cheap") ?? balanced;

  const history = input.history;
  const hasHistory = history.runCount > 0;

  const estimateOf = (m: ModelMeta | null): number | null => {
    if (!m) return null;
    if (!hasHistory) return null;
    return estimateDaily(history, m);
  };

  // Pick a cascade trigger: explicit budget if given, else half the premium projection, else default.
  const premiumDaily = estimateOf(premium);
  const trigger =
    input.budgetDay ??
    (premiumDaily !== null ? roundTo2(premiumDaily / 2) : DEFAULT_BUDGET_DAY);

  const tagged: Tagged[] = [];

  if (premium) {
    tagged.push({
      kind: "pure-premium",
      suggestion: {
        rationale: hasHistory
          ? `Use ${premium.tier} model ${premium.provider}/${premium.model} for everything. Highest quality; estimated $${(premiumDaily ?? 0).toFixed(2)}/day at recent volume.`
          : `Use ${premium.tier} model ${premium.provider}/${premium.model} for everything. No history yet — cost estimate not available.`,
        policy: { primary: refOf(premium), fallback: null, cascade: null },
        estimatedSpendDay: estimateOf(premium),
        applyCommand: `thomas route ${input.agent} ${premium.provider}/${premium.model}`,
      },
    });
  }

  if (premium && cheap && premium !== cheap) {
    const fallbackDaily = estimateOf(cheap);
    const cascadeDaily =
      premiumDaily !== null && fallbackDaily !== null
        ? estimateCascadeDaily(premiumDaily, fallbackDaily, trigger)
        : null;
    tagged.push({
      kind: "cascade",
      suggestion: {
        rationale:
          `Use ${premium.provider}/${premium.model} until $${trigger.toFixed(2)}/day spent, then fall back to ${cheap.provider}/${cheap.model}. ` +
          (cascadeDaily !== null
            ? `Estimated $${cascadeDaily.toFixed(2)}/day at recent volume; capped at $${trigger.toFixed(2)} on premium.`
            : `No history yet — cost estimate not available.`),
        policy: {
          primary: refOf(premium),
          fallback: refOf(cheap),
          cascade: { triggerSpendDay: trigger, cheaper: refOf(cheap) },
        },
        estimatedSpendDay: cascadeDaily,
        applyCommand: `thomas policy set ${input.agent} --primary ${premium.provider}/${premium.model} --at ${trigger}=${cheap.provider}/${cheap.model}`,
      },
    });
  }

  if (cheap) {
    const cheapDaily = estimateOf(cheap);
    tagged.push({
      kind: "pure-cheap",
      suggestion: {
        rationale: hasHistory
          ? `Use cheap model ${cheap.provider}/${cheap.model} for everything. Lowest cost; estimated $${(cheapDaily ?? 0).toFixed(2)}/day at recent volume. Quality may suffer on hard tasks.`
          : `Use cheap model ${cheap.provider}/${cheap.model} for everything. No history yet — cost estimate not available.`,
        policy: { primary: refOf(cheap), fallback: null, cascade: null },
        estimatedSpendDay: cheapDaily,
        applyCommand: `thomas route ${input.agent} ${cheap.provider}/${cheap.model}`,
      },
    });
  }

  return reorderByPreference(tagged, input.preference).map((t) => t.suggestion);
}

function pickByTier(candidates: ModelMeta[], tier: ModelMeta["tier"]): ModelMeta | null {
  // Within a tier, prefer the cheapest blended price (input + output average).
  const inTier = candidates.filter((m) => m.tier === tier);
  if (inTier.length === 0) return null;
  return inTier
    .map((m) => ({ m, score: m.pricePerMillion.input + m.pricePerMillion.output }))
    .sort((a, b) => a.score - b.score)[0]!.m;
}

function estimateDaily(h: AgentHistory, m: ModelMeta): number {
  return (
    (h.avgInputTokensPerDay * m.pricePerMillion.input +
      h.avgOutputTokensPerDay * m.pricePerMillion.output) /
    1_000_000
  );
}

// Approximate: spend caps at trigger on primary, remainder of "would-have" volume runs on fallback.
// Ratio of work done before trigger fires = trigger / primaryDaily (if > trigger, else stays on primary).
function estimateCascadeDaily(primaryDaily: number, fallbackDaily: number, trigger: number): number {
  if (primaryDaily <= trigger) return primaryDaily;
  const fractionOnPrimary = trigger / primaryDaily;
  return trigger + fallbackDaily * (1 - fractionOnPrimary);
}

function reorderByPreference(tagged: Tagged[], pref: Preference): Tagged[] {
  // Tagged kinds are stable identifiers — no ad-hoc tier lookup.
  const purePremium = tagged.find((t) => t.kind === "pure-premium");
  const cascade = tagged.find((t) => t.kind === "cascade");
  const pureCheap = tagged.find((t) => t.kind === "pure-cheap");
  const items = [purePremium, cascade, pureCheap].filter(Boolean) as Tagged[];
  if (pref === "quality") return items;
  if (pref === "cost") return [...items].reverse();
  // balanced: cascade first (compromise), then premium, then cheap
  return [cascade, purePremium, pureCheap].filter(Boolean) as Tagged[];
}

function refOf(m: ModelMeta): { provider: string; model: string } {
  return { provider: m.provider, model: m.model };
}

function roundTo2(n: number): number {
  return Math.round(n * 100) / 100;
}
