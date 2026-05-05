// Pure decision: given a policy + today's spend, compute the effective target.
// Tested against fixtures of (policy, spend) inputs in tests/policy.test.ts.

import { readRuns } from "../runs/store.js";
import type { AgentId } from "../agents/types.js";
import { getPolicy } from "./store.js";
import type { PolicyConfig, PolicyDecision } from "./types.js";

export async function decideForAgent(
  agentId: AgentId,
  fallbackTarget: { provider: string; model: string },
): Promise<PolicyDecision> {
  const policy = await getPolicy(agentId);
  if (!policy) {
    return { target: fallbackTarget, reason: "no policy configured", policyId: null };
  }
  const spendDay = await spendSinceStartOfDay(agentId);
  return decide(policy, spendDay);
}

export function decide(policy: PolicyConfig, spendDay: number): PolicyDecision {
  // cascade rules are evaluated in order; first matching trigger wins.
  // Caller is expected to have ordered them ascending by trigger.
  for (const rule of policy.cascade) {
    if (spendDay >= rule.triggerSpendDay) {
      return {
        target: rule.fallback,
        reason: `spend $${spendDay.toFixed(4)}/day ≥ trigger $${rule.triggerSpendDay.toFixed(2)}`,
        policyId: policy.id,
      };
    }
  }
  return {
    target: policy.primary,
    reason: `spend $${spendDay.toFixed(4)}/day below all cascade triggers`,
    policyId: policy.id,
  };
}

export async function spendSinceStartOfDay(agentId: AgentId): Promise<number> {
  const records = await readRuns({ agent: agentId, since: startOfTodayUTC() });
  let total = 0;
  for (const r of records) {
    if (r.cost !== null) total += r.cost;
  }
  return total;
}

export function startOfTodayUTC(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
