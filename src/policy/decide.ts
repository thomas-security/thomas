// Pure decision: given a policy + today's spend, compute the effective target.
// Tested against fixtures of (policy, spend) inputs in tests/policy.test.ts.
//
// `decideForAgent` resolves the policy in this order:
//   1. cloud cache (~/.thomas/cloud-cache.json)        — written by `thomas cloud sync`
//   2. local store (~/.thomas/policies.json)            — set by `thomas policy set`
//   3. fallback target                                  — the route from routes.json
// The first hit wins. Cloud takes precedence so a centrally-managed policy
// supersedes a leftover local one once the user logs in. Offline (or pre-login)
// users keep getting their local policies — no behavior change.

import type { AgentId } from "../agents/types.js";
import { loadCloudPolicyForAgent } from "../cloud/policy-bridge.js";
import { readRuns } from "../runs/store.js";
import { getPolicy } from "./store.js";
import type { PolicyConfig, PolicyDecision } from "./types.js";

export async function decideForAgent(
  agentId: AgentId,
  fallbackTarget: { provider: string; model: string },
): Promise<PolicyDecision> {
  const cloudPolicy = await loadCloudPolicyForAgent(agentId);
  if (cloudPolicy) {
    const spendDay = await spendSinceStartOfDay(agentId);
    return { ...decide(cloudPolicy, spendDay), policy: cloudPolicy, source: "cloud" };
  }
  const localPolicy = await getPolicy(agentId);
  if (localPolicy) {
    const spendDay = await spendSinceStartOfDay(agentId);
    return { ...decide(localPolicy, spendDay), policy: localPolicy, source: "local" };
  }
  return {
    target: fallbackTarget,
    reason: "no policy configured",
    policyId: null,
    policy: null,
    source: "none",
  };
}

/**
 * Pure cascade evaluation. Returns target + reason + policyId. Caller is
 * responsible for stamping `policy` and `source` (decideForAgent does this).
 */
export function decide(
  policy: PolicyConfig,
  spendDay: number,
): Omit<PolicyDecision, "policy" | "source"> {
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
