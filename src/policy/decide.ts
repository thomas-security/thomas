// Pure decision: given a policy + today's usage, compute the effective target.
// Tested against fixtures of (policy, usage) inputs in tests/policy.test.ts.
//
// `decideForAgent` resolves the policy in this order:
//   1. cloud cache (~/.thomas/cloud-cache.json)        — written by `thomas cloud sync`
//   2. local store (~/.thomas/policies.json)            — set by `thomas policy set`
//   3. fallback target                                  — the route from routes.json
// The first hit wins. Cloud takes precedence so a centrally-managed policy
// supersedes a leftover local one once the user logs in. Offline (or pre-login)
// users keep getting their local policies — no behavior change.
//
// Usage is provided by src/metering/ — TokenMeter for v0.1.0; future
// CallMeter/WindowMeter for subscription2api providers.

import type { AgentId } from "../agents/types.js";
import { loadCloudPolicyForAgent } from "../cloud/policy-bridge.js";
import { getMeter } from "../metering/registry.js";
import type { Usage } from "../metering/types.js";
import { getPolicy } from "./store.js";
import type { CostCascadeRule, PolicyConfig, PolicyDecision } from "./types.js";

export async function decideForAgent(
  agentId: AgentId,
  fallbackTarget: { provider: string; model: string },
): Promise<PolicyDecision> {
  const cloudPolicy = await loadCloudPolicyForAgent(agentId);
  if (cloudPolicy) {
    const usage = await getMeter(agentId).usageInWindow(agentId, "day");
    return { ...decide(cloudPolicy, usage), policy: cloudPolicy, source: "cloud" };
  }
  const localPolicy = await getPolicy(agentId);
  if (localPolicy) {
    const usage = await getMeter(agentId).usageInWindow(agentId, "day");
    return { ...decide(localPolicy, usage), policy: localPolicy, source: "local" };
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
 *
 * Rules are evaluated in order; first matching rule wins. A spend-trigger
 * rule is inert when usage.spend is null (subscription / unpriced runs);
 * count-trigger rules still fire in that case.
 */
export function decide(
  policy: PolicyConfig,
  usage: Usage,
): Omit<PolicyDecision, "policy" | "source"> {
  for (const rule of policy.cascade) {
    const hit = evaluateRule(rule, usage);
    if (hit) {
      return { target: rule.fallback, reason: hit, policyId: policy.id };
    }
  }
  return {
    target: policy.primary,
    reason: describeBelowAll(usage),
    policyId: policy.id,
  };
}

function evaluateRule(rule: CostCascadeRule, usage: Usage): string | null {
  if (rule.triggerSpendDay !== undefined && usage.spend !== null) {
    if (usage.spend >= rule.triggerSpendDay) {
      return `spend $${usage.spend.toFixed(4)}/day ≥ trigger $${rule.triggerSpendDay.toFixed(2)}`;
    }
  }
  if (rule.triggerCallsDay !== undefined) {
    if (usage.calls >= rule.triggerCallsDay) {
      return `calls ${usage.calls}/day ≥ trigger ${rule.triggerCallsDay}`;
    }
  }
  return null;
}

function describeBelowAll(usage: Usage): string {
  const parts: string[] = [];
  if (usage.spend !== null) parts.push(`spend $${usage.spend.toFixed(4)}/day`);
  parts.push(`calls ${usage.calls}/day`);
  return `${parts.join(", ")} below all cascade triggers`;
}
