// Translate the cloud snapshot's per-agent binding into a local PolicyConfig
// the proxy's existing decide() pipeline understands.
//
// The wire shape from /v1/sync mirrors apps/api/app/schemas/{policy,bundle,binding}.py
// — same fields, same camelCase. We do runtime parsing here (no codegen) and
// synthesize a "cost-cascade" PolicyConfig regardless of the cloud binding's
// kind, so the rest of thomas keeps a single decision pipeline:
//
//   binding kind=static  → synthetic policy: primary=staticTarget, no cascade.
//                          The cascade decision becomes a no-op; primary wins.
//   binding kind=policy  → look up the policy in the snapshot, translate the
//                          field names (providerId/triggerSpendDayUsd → provider/
//                          triggerSpendDay) and feed it through unchanged.
//   binding kind=bundle  → v1 stub: use the highest-priority leg as primary,
//                          no cascade. The real bundle balancer (per-leg cap
//                          accounting + drain order) lands in a follow-up PR.
//
// "No binding for this agent" returns null; callers fall back to the local
// ~/.thomas/policies.json store. Same for "no cloud login" / "stale cache".

import type { AgentId } from "../agents/types.js";
import type { PolicyConfig } from "../policy/types.js";
import { readCache } from "./cache.js";

type WireModelRef = { providerId: string; model: string };

type WireCascadeStep = {
  triggerSpendDayUsd: number;
  fallback: WireModelRef;
};

type WirePolicySpec = {
  schemaVersion: number;
  primary: WireModelRef;
  cascade?: WireCascadeStep[];
  failoverTo?: WireModelRef | null;
};

type WirePolicy = {
  id: string;
  name: string;
  spec: WirePolicySpec;
  enabled: boolean;
};

type WireBundleLeg = {
  providerId: string;
  model: string;
  capUsdPerDay?: number | null;
  capCallsPerDay?: number | null;
  priority: number;
};

type WireBundle = {
  id: string;
  name: string;
  spec: { schemaVersion: number; legs: WireBundleLeg[] };
  enabled: boolean;
};

type WireBinding = {
  agentId: string;
  bindingKind: "policy" | "bundle" | "static";
  targetId?: string | null;
  staticTarget?: WireModelRef | null;
};

/**
 * Look up a policy config for `agentId` in the cloud cache. Returns undefined
 * when there's no cache, no binding for this agent, or the binding refers to
 * a disabled / missing policy. Caller should fall through to the local
 * `~/.thomas/policies.json` store on undefined.
 */
export async function loadCloudPolicyForAgent(
  agentId: AgentId,
): Promise<PolicyConfig | undefined> {
  const snapshot = await readCache();
  // Empty defaults — when the user hasn't logged in to cloud, the cache file
  // returns the EMPTY constant from cache.ts and these are all empty arrays.
  const bindings = snapshot.bindings as WireBinding[];
  const binding = bindings.find((b) => b.agentId === agentId);
  if (!binding) return undefined;

  if (binding.bindingKind === "static") {
    if (!binding.staticTarget) return undefined;
    return staticAsPolicy(binding.staticTarget);
  }
  if (binding.bindingKind === "policy") {
    const policies = snapshot.policies as WirePolicy[];
    const policy = policies.find((p) => p.id === binding.targetId && p.enabled);
    if (!policy) return undefined;
    return wireToPolicyConfig(policy.spec);
  }
  if (binding.bindingKind === "bundle") {
    const bundles = snapshot.bundles as WireBundle[];
    const bundle = bundles.find((b) => b.id === binding.targetId && b.enabled);
    if (!bundle || bundle.spec.legs.length === 0) return undefined;
    return bundleAsPolicy(bundle);
  }
  return undefined;
}

/** Convert a static binding to a no-cascade PolicyConfig. */
function staticAsPolicy(target: WireModelRef): PolicyConfig {
  return {
    id: "cost-cascade",
    primary: { provider: target.providerId, model: target.model },
    cascade: [],
  };
}

/** Convert a cloud PolicySpec (camelCase wire) to local PolicyConfig (legacy
 *  field names). Cascade is already sorted ascending on the cloud side. */
function wireToPolicyConfig(spec: WirePolicySpec): PolicyConfig {
  return {
    id: "cost-cascade",
    primary: { provider: spec.primary.providerId, model: spec.primary.model },
    cascade: (spec.cascade ?? []).map((step) => ({
      triggerSpendDay: step.triggerSpendDayUsd,
      fallback: { provider: step.fallback.providerId, model: step.fallback.model },
    })),
    ...(spec.failoverTo
      ? { failoverTo: { provider: spec.failoverTo.providerId, model: spec.failoverTo.model } }
      : {}),
  };
}

/** v1 bundle stub: use the highest-priority leg as the primary target. The
 *  real per-leg cap balancer lands later — when it does, this function gets
 *  replaced by something that consumes today's spend per leg. */
function bundleAsPolicy(bundle: WireBundle): PolicyConfig {
  // Schema validates legs are sorted ascending by priority on write. Take [0].
  const head = bundle.spec.legs[0]!;
  return {
    id: "cost-cascade",
    primary: { provider: head.providerId, model: head.model },
    cascade: [],
  };
}
