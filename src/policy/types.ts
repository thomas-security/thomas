// Internal policy shapes. Persisted in ~/.thomas/policies.json.
// Public output uses src/cli/output.ts PolicyData / PolicySnapshot.

import type { AgentId } from "../agents/types.js";

// Exactly ONE of triggerSpendDay / triggerCallsDay must be set on each rule.
// Validated at policy-set time. Spend triggers compare against today's
// accumulated cost; calls triggers compare against today's call count. Calls
// triggers exist for usage-based providers (subscription2api) where spend is
// null and dollar gating is moot.
export type CostCascadeRule = {
  triggerSpendDay?: number;
  triggerCallsDay?: number;
  fallback: { provider: string; model: string };
};

export type CostCascadePolicy = {
  id: "cost-cascade";
  primary: { provider: string; model: string };
  cascade: CostCascadeRule[];
  // optional in-run failover target. The proxy retries once on this target
  // when the primary returns a retryable error (network / 408 / 429 / 5xx).
  // Independent of cascade — cascade is for cost, failover is for reliability.
  failoverTo?: { provider: string; model: string };
};

// Discriminated union — extend with `| { id: "..."; ... }` when more policies land.
export type PolicyConfig = CostCascadePolicy;

export type PoliciesStore = {
  policies: Partial<Record<AgentId, PolicyConfig>>;
};

export type PolicyDecision = {
  target: { provider: string; model: string };
  reason: string;
  policyId: PolicyConfig["id"] | null;
  /**
   * The full policy that produced this decision, if any. Lets callers reach
   * for `failoverTo` (or future fields) without re-reading the store. Null
   * when the decision was just "use the fallback target" (no policy bound).
   */
  policy: PolicyConfig | null;
  /**
   * Where the policy came from. "cloud" = pulled from ~/.thomas/cloud-cache.json.
   * "local" = ~/.thomas/policies.json. "none" = no policy was bound.
   * Surfaced for telemetry / debugging — not part of the decision logic.
   */
  source: "cloud" | "local" | "none";
};
