import { agents as agentRegistry } from "../agents/registry.js";
import type { AgentId } from "../agents/types.js";
import { ThomasError, runJson } from "../cli/json.js";
import type {
  CostCascadeRule as OutputCostCascadeRule,
  PolicyClearData,
  PolicyData,
  PolicySetData,
  PolicySnapshot,
} from "../cli/output.js";
import { parseRouteSpec } from "../config/routes.js";
import { getMeter } from "../metering/registry.js";
import { decide } from "../policy/decide.js";
import { clearPolicy, readPolicies, setPolicy } from "../policy/store.js";
import type { CostCascadePolicy, CostCascadeRule } from "../policy/types.js";

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
    const usage = await getMeter(agentId).usageInWindow(agentId, "day");
    const decision = decide(policy, usage);
    snapshots.push({
      agent: agentId,
      id: policy.id,
      primary: policy.primary,
      cascade: policy.cascade.map(toOutputRule),
      failoverTo: policy.failoverTo ?? null,
      currentSpendDay: usage.spend,
      currentCallsDay: usage.calls,
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
      console.log(`  ${formatRule(rule)} → ${rule.fallback.provider}/${rule.fallback.model}`);
    }
    if (p.failoverTo) {
      console.log(`  on error  → ${p.failoverTo.provider}/${p.failoverTo.model}`);
    }
    const spend = p.currentSpendDay !== null ? `$${p.currentSpendDay.toFixed(4)}` : "?";
    console.log(
      `  today: ${p.currentCallsDay} calls, ${spend} spent; effective: ${p.currentEffective.provider}/${p.currentEffective.model}`,
    );
    console.log("");
  }
}

export type PolicySetOptions = {
  json: boolean;
  agentId: string;
  primary: string;
  cascade: string[]; // each entry: "<usd>=<provider>/<model>"
  cascadeCalls?: string[]; // each entry: "<int>=<provider>/<model>"
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
        console.log(`  ${formatRule(r)} → ${r.fallback.provider}/${r.fallback.model}`);
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

  const spendRules = opts.cascade.map((entry, i) => parseSpendCascadeEntry(entry, `--at[${i}]`));
  const callsRules = (opts.cascadeCalls ?? []).map((entry, i) =>
    parseCallsCascadeEntry(entry, `--at-calls[${i}]`),
  );

  // Stable order: spend rules ascending by trigger, then calls rules ascending.
  // Mixed cascades evaluate spend rules first (preserves existing behavior for
  // pure-spend policies); calls rules act as a backstop for sub2api windows.
  spendRules.sort((a, b) => (a.triggerSpendDay ?? 0) - (b.triggerSpendDay ?? 0));
  callsRules.sort((a, b) => (a.triggerCallsDay ?? 0) - (b.triggerCallsDay ?? 0));
  const cascade: CostCascadeRule[] = [...spendRules, ...callsRules];

  if (cascade.length === 0 && !opts.failoverTo) {
    // Allowed: a policy with primary only is legal (acts as a static pin).
  }

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
    policy: {
      id: policy.id,
      primary,
      cascade: cascade.map(toOutputRule),
      failoverTo: failoverTo ?? null,
    },
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

function parseSpendCascadeEntry(entry: string, argName: string): CostCascadeRule {
  const { triggerStr, targetStr } = splitTriggerEntry(entry, argName, "<usd>");
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

function parseCallsCascadeEntry(entry: string, argName: string): CostCascadeRule {
  const { triggerStr, targetStr } = splitTriggerEntry(entry, argName, "<int>");
  const trigger = Number.parseInt(triggerStr, 10);
  if (!Number.isInteger(trigger) || trigger < 1 || String(trigger) !== triggerStr.trim()) {
    throw new ThomasError({
      code: "E_INVALID_ARG",
      message: `${argName}: trigger must be a positive integer (got '${triggerStr}')`,
      details: { arg: argName, value: entry },
    });
  }
  return { triggerCallsDay: trigger, fallback: parseModelSpec(targetStr, argName) };
}

function splitTriggerEntry(
  entry: string,
  argName: string,
  triggerHint: string,
): { triggerStr: string; targetStr: string } {
  const eq = entry.indexOf("=");
  if (eq < 0) {
    throw new ThomasError({
      code: "E_INVALID_ARG",
      message: `${argName} must be in '${triggerHint}=<provider>/<model>' form (got '${entry}')`,
      details: { arg: argName, value: entry },
    });
  }
  return { triggerStr: entry.slice(0, eq).trim(), targetStr: entry.slice(eq + 1).trim() };
}

function toOutputRule(r: CostCascadeRule): OutputCostCascadeRule {
  return {
    triggerSpendDay: r.triggerSpendDay ?? null,
    triggerCallsDay: r.triggerCallsDay ?? null,
    fallback: r.fallback,
  };
}

function formatRule(rule: OutputCostCascadeRule): string {
  if (rule.triggerSpendDay !== null) {
    return `at ≥ $${rule.triggerSpendDay.toFixed(2)}/day`;
  }
  if (rule.triggerCallsDay !== null) {
    return `at ≥ ${rule.triggerCallsDay} call${rule.triggerCallsDay === 1 ? "" : "s"}/day`;
  }
  return "(invalid: no trigger)";
}
