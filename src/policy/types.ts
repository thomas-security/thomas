// Internal policy shapes. Persisted in ~/.thomas/policies.json.
// Public output uses src/cli/output.ts PolicyData / PolicySnapshot.

import type { AgentId } from "../agents/types.js";

export type CostCascadeRule = {
  triggerSpendDay: number;
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
};
