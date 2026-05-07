// Translate the cloud snapshot's per-agent binding into a local PolicyConfig
// the proxy's existing decide() pipeline understands.
//
// Wire types come from src/cloud/openapi-types.ts (regenerated via
// `bun run gen:types` against the running cloud's /openapi.json). This
// replaces the hand-written Wire* aliases that lived here in earlier PRs.
//
//   binding kind=static  → synthetic policy: primary=staticTarget, no cascade.
//                          The cascade decision becomes a no-op; primary wins.
//   binding kind=policy  → look up the policy in the snapshot, translate the
//                          field names (providerId/triggerSpendDayUsd →
//                          provider/triggerSpendDay) and feed it through.
//   binding kind=bundle  → v1 stub: use the highest-priority leg as primary,
//                          no cascade. The real bundle balancer (per-leg cap
//                          accounting + drain order) lands in a follow-up PR.
//
// "No binding for this agent" returns undefined; callers fall back to the
// local ~/.thomas/policies.json store. Same for "no cloud login" / "stale
// cache".

import type { AgentId } from "../agents/types.js";
import type { PolicyConfig } from "../policy/types.js";
import { readCache } from "./cache.js";
import type {
  SchemaAgentBindingResponse,
  SchemaBundleResponse,
  SchemaCascadeStep,
  SchemaModelRef,
  SchemaPolicyResponse,
  SchemaPolicySpec,
} from "./openapi-types.js";

export async function loadCloudPolicyForAgent(
  agentId: AgentId,
): Promise<PolicyConfig | undefined> {
  const snapshot = await readCache();
  // Empty defaults — when the user hasn't logged in to cloud, the cache file
  // returns the EMPTY constant from cache.ts and these are all empty arrays.
  const bindings = snapshot.bindings as SchemaAgentBindingResponse[];
  const binding = bindings.find((b) => b.agentId === agentId);
  if (!binding) return undefined;

  if (binding.bindingKind === "static") {
    if (!binding.staticTarget) return undefined;
    return staticAsPolicy(binding.staticTarget);
  }
  if (binding.bindingKind === "policy") {
    const policies = snapshot.policies as SchemaPolicyResponse[];
    const policy = policies.find((p) => p.id === binding.targetId && p.enabled);
    if (!policy) return undefined;
    return wireToPolicyConfig(policy.spec);
  }
  if (binding.bindingKind === "bundle") {
    const bundles = snapshot.bundles as SchemaBundleResponse[];
    const bundle = bundles.find((b) => b.id === binding.targetId && b.enabled);
    if (!bundle || bundle.spec.legs.length === 0) return undefined;
    const head = bundle.spec.legs[0]!;
    return {
      id: "cost-cascade",
      primary: { provider: head.providerId, model: head.model },
      cascade: [],
    };
  }
  return undefined;
}

function staticAsPolicy(target: SchemaModelRef): PolicyConfig {
  return {
    id: "cost-cascade",
    primary: { provider: target.providerId, model: target.model },
    cascade: [],
  };
}

/** Convert a cloud PolicySpec (camelCase wire) to local PolicyConfig (legacy
 *  field names). Cascade is already sorted on the cloud side: spend rules
 *  ascending by USD, then calls rules ascending by count. */
function wireToPolicyConfig(spec: SchemaPolicySpec): PolicyConfig {
  return {
    id: "cost-cascade",
    primary: { provider: spec.primary.providerId, model: spec.primary.model },
    cascade: (spec.cascade ?? []).map(toLocalCascadeRule),
    ...(spec.failoverTo
      ? {
          failoverTo: {
            provider: spec.failoverTo.providerId,
            model: spec.failoverTo.model,
          },
        }
      : {}),
  };
}

function toLocalCascadeRule(step: SchemaCascadeStep): PolicyConfig["cascade"][number] {
  // Server schema makes both triggers `number | null`; we treat null and
  // undefined identically (absent). Internally only the present trigger
  // is set on the rule.
  const spend = step.triggerSpendDayUsd ?? undefined;
  const calls = step.triggerCallsDay ?? undefined;
  return {
    ...(spend !== undefined ? { triggerSpendDay: spend } : {}),
    ...(calls !== undefined ? { triggerCallsDay: calls } : {}),
    fallback: { provider: step.fallback.providerId, model: step.fallback.model },
  };
}
