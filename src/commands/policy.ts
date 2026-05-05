import { agents as agentRegistry } from "../agents/registry.js";
import type { AgentId } from "../agents/types.js";
import { ThomasError, runJson } from "../cli/json.js";
import type {
  CostCascadeRule,
  PolicyClearData,
  PolicyData,
  PolicySetData,
  PolicySnapshot,
} from "../cli/output.js";
import { decide, spendSinceStartOfDay } from "../policy/decide.js";
import { clearPolicy, readPolicies, setPolicy } from "../policy/store.js";
import type { CostCascadePolicy } from "../policy/types.js";
import { parseRouteSpec } from "../config/routes.js";

const KNOWN_AGENTS: AgentId[] = Object.keys(agentRegistry) as AgentId[];

export async function policyShow(opts: { json: boolean }): Promise<number> {
  return runJson({
    command: "policy",
    json: opts.json,
    fetch: fetchPolicies,
    printHuman: printPolicies,
  });
}

async function fetchPolicies(): Promise<PolicyData> {
  const store = await readPolicies();
  const snapshots: PolicySnapshot[] = [];
  for (const [agent, policy] of Object.entries(store.policies)) {
    if (!policy) continue;
    const agentId = agent as AgentId;
    const spend = await spendSinceStartOfDay(agentId);
    const decision = decide(policy, spend);
    snapshots.push({
      agent: agentId,
      id: policy.id,
      primary: policy.primary,
      cascade: policy.cascade,
      failoverTo: policy.failoverTo ?? null,
      currentSpendDay: spend,
      currentEffective: decision.target,
      currentReason: decision.reason,
    });
  }
  return { policies: snapshots };
}

function printPolicies(data: PolicyData): void {
  if (data.policies.length === 0) {
    console.log("(no policies configured)");
    return;
  }
  for (const p of data.policies) {
    console.log(`${p.agent}  (${p.id})`);
    console.log(`  primary:  ${p.primary.provider}/${p.primary.model}`);
    for (const rule of p.cascade) {
      console.log(
        `  at ≥ $${rule.triggerSpendDay.toFixed(2)}/day → ${rule.fallback.provider}/${rule.fallback.model}`,
      );
    }
    if (p.failoverTo) {
      console.log(`  on error  → ${p.failoverTo.provider}/${p.failoverTo.model}`);
    }
    const spend = p.currentSpendDay !== null ? `$${p.currentSpendDay.toFixed(4)}` : "?";
    console.log(`  today spent ${spend}; effective: ${p.currentEffective.provider}/${p.currentEffective.model}`);
    console.log("");
  }
}

export type PolicySetOptions = {
  json: boolean;
  agentId: string;
  primary: string;
  cascade: string[]; // each entry: "<usd>=<provider>/<model>"
  failoverTo?: string; // "<provider>/<model>"
};

export async function policySet(opts: PolicySetOptions): Promise<number> {
  return runJson({
    command: "policy.set",
    json: opts.json,
    fetch: () => doPolicySet(opts),
    printHuman: (d) => {
      console.log(`Set ${d.policy.id} policy for ${d.agent}:`);
      console.log(`  primary:  ${d.policy.primary.provider}/${d.policy.primary.model}`);
      for (const r of d.policy.cascade) {
        console.log(
          `  at ≥ $${r.triggerSpendDay.toFixed(2)}/day → ${r.fallback.provider}/${r.fallback.model}`,
        );
      }
      if (d.policy.failoverTo) {
        console.log(`  on error  → ${d.policy.failoverTo.provider}/${d.policy.failoverTo.model}`);
      }
    },
  });
}

async function doPolicySet(opts: PolicySetOptions): Promise<PolicySetData> {
  const agentId = validateAgent(opts.agentId);
  const primary = parseModelSpec(opts.primary, "--primary");
  const cascade: CostCascadeRule[] = opts.cascade.map((entry, i) =>
    parseCascadeEntry(entry, `--at[${i}]`),
  );
  // normalize: ascending trigger order
  cascade.sort((a, b) => a.triggerSpendDay - b.triggerSpendDay);
  const failoverTo = opts.failoverTo
    ? parseModelSpec(opts.failoverTo, "--failover-to")
    : undefined;
  const policy: CostCascadePolicy = {
    id: "cost-cascade",
    primary,
    cascade,
    ...(failoverTo ? { failoverTo } : {}),
  };
  await setPolicy(agentId, policy);
  return {
    agent: agentId,
    policy: { id: policy.id, primary, cascade, failoverTo: failoverTo ?? null },
  };
}

export async function policyClear(
  agentId: string,
  opts: { json: boolean },
): Promise<number> {
  return runJson({
    command: "policy.clear",
    json: opts.json,
    fetch: () => doPolicyClear(agentId),
    printHuman: (d) => {
      if (d.removed) console.log(`Cleared policy for ${d.agent}.`);
      else console.log(`No policy configured for ${d.agent}.`);
    },
  });
}

async function doPolicyClear(agentId: string): Promise<PolicyClearData> {
  const id = validateAgent(agentId);
  const removed = await clearPolicy(id);
  return { agent: id, removed };
}

function validateAgent(id: string): AgentId {
  if (!(KNOWN_AGENTS as string[]).includes(id)) {
    throw new ThomasError({
      code: "E_AGENT_NOT_FOUND",
      message: `unknown agent '${id}'`,
      remediation: "Run `thomas doctor` to see installed agents",
      details: { requested: id, known: KNOWN_AGENTS },
    });
  }
  return id as AgentId;
}

function parseModelSpec(s: string, argName: string): { provider: string; model: string } {
  const parsed = parseRouteSpec(s);
  if (!parsed) {
    throw new ThomasError({
      code: "E_INVALID_ARG",
      message: `${argName} must be in 'provider/model' form (got '${s}')`,
      details: { arg: argName, value: s },
    });
  }
  return { provider: parsed.provider, model: parsed.model };
}

function parseCascadeEntry(entry: string, argName: string): CostCascadeRule {
  const eq = entry.indexOf("=");
  if (eq < 0) {
    throw new ThomasError({
      code: "E_INVALID_ARG",
      message: `${argName} must be in '<usd>=<provider>/<model>' form (got '${entry}')`,
      details: { arg: argName, value: entry },
    });
  }
  const triggerStr = entry.slice(0, eq).trim();
  const targetStr = entry.slice(eq + 1).trim();
  const trigger = Number.parseFloat(triggerStr);
  if (!Number.isFinite(trigger) || trigger < 0) {
    throw new ThomasError({
      code: "E_INVALID_ARG",
      message: `${argName}: trigger must be a non-negative number (got '${triggerStr}')`,
      details: { arg: argName, value: entry },
    });
  }
  return { triggerSpendDay: trigger, fallback: parseModelSpec(targetStr, argName) };
}
