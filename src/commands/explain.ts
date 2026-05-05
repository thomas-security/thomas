import { agents as agentRegistry } from "../agents/registry.js";
import type { AgentId } from "../agents/types.js";
import { ThomasError, runJson } from "../cli/json.js";
import type { ExplainData } from "../cli/output.js";
import { readAgents } from "../config/agents.js";
import { getRoute } from "../config/routes.js";
import { decide, spendSinceStartOfDay, startOfTodayUTC } from "../policy/decide.js";
import { getPolicy } from "../policy/store.js";
import { findRecordsForRun, readRuns } from "../runs/store.js";
import type { RunRecord } from "../runs/types.js";

const KNOWN_AGENTS: AgentId[] = Object.keys(agentRegistry) as AgentId[];

export type ExplainOptions = {
  json: boolean;
  runId?: string;
  agentId?: string;
};

export async function explain(opts: ExplainOptions): Promise<number> {
  return runJson({
    command: "explain",
    json: opts.json,
    fetch: () => fetchExplain(opts),
    printHuman: printExplain,
  });
}

async function fetchExplain(opts: ExplainOptions): Promise<ExplainData> {
  if (opts.runId) return explainRun(opts.runId);
  if (opts.agentId) return explainAgent(opts.agentId);
  throw new ThomasError({
    code: "E_INVALID_ARG",
    message: "explain requires --run <runId> or --agent <agentId>",
    remediation: "Pass exactly one of --run or --agent",
  });
}

async function explainRun(runIdOrPrefix: string): Promise<ExplainData> {
  const records = await findRecordsForRun(runIdOrPrefix);
  if (records.length === 0) {
    throw new ThomasError({
      code: "E_INVALID_ARG",
      message: `no run found matching '${runIdOrPrefix}'`,
      remediation: "Run `thomas runs --json` to list recent run IDs",
      details: { requested: runIdOrPrefix },
    });
  }
  if (records.length === 1) return explainSingleCall(records[0]!);
  return explainMultiCall(records);
}

function explainSingleCall(run: RunRecord): ExplainData {
  const facts: ExplainData["facts"] = [
    { kind: "route", detail: `${run.agent} → ${run.outboundProvider}/${run.outboundModel}`, at: run.startedAt },
    {
      kind: "cost",
      detail:
        run.cost === null
          ? `tokens ${run.inputTokens} in / ${run.outputTokens} out; cost unknown (no price entry for ${run.outboundProvider}/${run.outboundModel})`
          : `tokens ${run.inputTokens} in / ${run.outputTokens} out; cost $${run.cost.toFixed(6)}`,
      at: null,
    },
  ];
  if (run.failovers && run.failoverNote) {
    facts.push({ kind: "fallback", detail: run.failoverNote, at: null });
  }
  if (run.status === "error") {
    facts.push({
      kind: "error",
      detail: run.errorMessage ?? `HTTP ${run.httpStatus}`,
      at: run.endedAt,
    });
  }
  return {
    subject: { type: "run", id: run.runId },
    narrative: runNarrative(run),
    facts,
  };
}

function explainMultiCall(records: RunRecord[]): ExplainData {
  const first = records[0]!;
  const last = records[records.length - 1]!;
  const totalIn = records.reduce((s, r) => s + r.inputTokens, 0);
  const totalOut = records.reduce((s, r) => s + r.outputTokens, 0);
  const knownCosts = records.map((r) => r.cost).filter((c): c is number => c !== null);
  const totalCost = knownCosts.length > 0 ? knownCosts.reduce((s, c) => s + c, 0) : null;
  const errorCount = records.filter((r) => r.status === "error").length;
  const failoverCount = records.reduce((s, r) => s + (r.failovers ?? 0), 0);
  const durMs = Date.parse(last.endedAt) - Date.parse(first.startedAt);

  const modelMap = new Map<string, number>();
  for (const r of records) {
    const key = `${r.outboundProvider}/${r.outboundModel}`;
    modelMap.set(key, (modelMap.get(key) ?? 0) + 1);
  }
  const modelBreakdown = [...modelMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} (${n} call${n > 1 ? "s" : ""})`)
    .join(", ");

  const facts: ExplainData["facts"] = [
    {
      kind: "route",
      detail: `${records.length} model calls across ${modelMap.size} model(s): ${modelBreakdown}`,
      at: null,
    },
    {
      kind: "cost",
      detail:
        totalCost === null
          ? `total tokens ${totalIn} in / ${totalOut} out; cost unknown (no priced calls)`
          : `total tokens ${totalIn} in / ${totalOut} out; cost $${totalCost.toFixed(6)}`,
      at: null,
    },
  ];
  for (let i = 0; i < records.length; i++) {
    const r = records[i]!;
    const cost =
      r.cost === null ? "cost ?" : `$${r.cost.toFixed(6)}`;
    const flag = r.status === "error" ? " [error]" : r.failovers ? " [failover]" : "";
    facts.push({
      kind: r.status === "error" ? "error" : "route",
      detail: `call ${i + 1}/${records.length}: ${r.outboundProvider}/${r.outboundModel} — ${r.inputTokens}/${r.outputTokens} tok, ${cost}${flag}`,
      at: r.startedAt,
    });
    if (r.failovers && r.failoverNote) {
      facts.push({ kind: "fallback", detail: r.failoverNote, at: r.endedAt });
    }
  }

  const dur = (durMs / 1000).toFixed(2);
  const costStr = totalCost === null ? "cost unknown" : `cost $${totalCost.toFixed(6)}`;
  const errPart = errorCount ? `, ${errorCount} error${errorCount > 1 ? "s" : ""}` : "";
  const foPart = failoverCount ? `, ${failoverCount} failover${failoverCount > 1 ? "s" : ""}` : "";
  const narrative = `Run ${first.runId.slice(0, 8)} for ${first.agent}: ${records.length} model calls over ${dur}s${errPart}${foPart}. Tokens ${totalIn} in / ${totalOut} out, ${costStr}. Models: ${modelBreakdown}.`;

  return {
    subject: { type: "run", id: first.runId },
    narrative,
    facts,
  };
}

function runNarrative(r: RunRecord): string {
  const when = r.endedAt;
  const dur = (r.durationMs / 1000).toFixed(2);
  const target = `${r.outboundProvider}/${r.outboundModel}`;
  const tokens = `${r.inputTokens} in / ${r.outputTokens} out`;
  const cost = r.cost === null ? "cost unknown (no price entry)" : `cost $${r.cost.toFixed(6)}`;
  const stream = r.streamed ? "streaming" : "non-streaming";
  const failoverSuffix = r.failovers && r.failoverNote ? ` (failed over: ${r.failoverNote})` : "";
  if (r.status === "error") {
    const why = r.errorMessage ?? `HTTP ${r.httpStatus}`;
    return `Run ${r.runId.slice(0, 8)} for ${r.agent} at ${when} (${stream}, ${dur}s): targeted ${target}, FAILED. ${why}${failoverSuffix}`;
  }
  return `Run ${r.runId.slice(0, 8)} for ${r.agent} at ${when} (${stream}, ${dur}s): used ${target}, ${tokens}, ${cost}.${failoverSuffix}`;
}

async function explainAgent(agentId: string): Promise<ExplainData> {
  const id = validateAgent(agentId);
  const [agentsState, route, policy, todayRuns, spendDay] = await Promise.all([
    readAgents(),
    getRoute(id),
    getPolicy(id),
    readRuns({ agent: id, since: startOfTodayUTC() }),
    spendSinceStartOfDay(id),
  ]);

  const conn = agentsState.connected[id];
  const facts: ExplainData["facts"] = [];

  if (!conn) {
    return {
      subject: { type: "agent", id },
      narrative: `${id} is not currently routed through thomas. Run \`thomas connect ${id}\` to wire it up.`,
      facts: [{ kind: "route", detail: "not connected", at: null }],
    };
  }

  if (route) {
    facts.push({
      kind: "route",
      detail: `static route: ${route.provider}/${route.model}`,
      at: null,
    });
  } else {
    facts.push({ kind: "route", detail: "no route configured", at: null });
  }

  let effective = route ? { provider: route.provider, model: route.model } : null;
  let policyReason: string | null = null;
  if (policy) {
    facts.push({
      kind: "policy-applied",
      detail: `cost-cascade policy active: primary ${policy.primary.provider}/${policy.primary.model}, ${policy.cascade.length} cascade rule(s)`,
      at: null,
    });
    const d = decide(policy, spendDay);
    effective = d.target;
    policyReason = d.reason;
    facts.push({ kind: "cascade", detail: `${d.reason} → effective ${d.target.provider}/${d.target.model}`, at: null });
  }

  const okCount = todayRuns.filter((r) => r.status === "ok").length;
  const errCount = todayRuns.filter((r) => r.status === "error").length;
  facts.push({
    kind: "cost",
    detail: `today: ${todayRuns.length} run(s) (${okCount} ok, ${errCount} error), spent $${spendDay.toFixed(4)} on priced runs`,
    at: null,
  });

  const lastErr = todayRuns.find((r) => r.status === "error");
  if (lastErr) {
    facts.push({
      kind: "error",
      detail: `last error: ${lastErr.errorMessage ?? `HTTP ${lastErr.httpStatus}`}`,
      at: lastErr.endedAt,
    });
  }

  return {
    subject: { type: "agent", id },
    narrative: agentNarrative({ id, route, policy, effective, policyReason, todayRuns, spendDay }),
    facts,
  };
}

function agentNarrative(p: {
  id: AgentId;
  route: { provider: string; model: string } | undefined;
  policy: { primary: { provider: string; model: string }; cascade: { triggerSpendDay: number }[] } | undefined;
  effective: { provider: string; model: string } | null;
  policyReason: string | null;
  todayRuns: RunRecord[];
  spendDay: number;
}): string {
  const parts: string[] = [];
  parts.push(`${p.id} is connected through thomas.`);
  if (!p.route) {
    parts.push(`No route configured — run \`thomas route ${p.id} <provider/model>\`.`);
    return parts.join(" ");
  }
  if (p.policy) {
    parts.push(
      `It has a cost-cascade policy with ${p.policy.cascade.length} fallback rule(s) on top of primary ${p.policy.primary.provider}/${p.policy.primary.model}.`,
    );
    if (p.effective) {
      parts.push(`Right now it routes to ${p.effective.provider}/${p.effective.model} (${p.policyReason ?? "primary"}).`);
    }
  } else if (p.effective) {
    parts.push(`Static route: ${p.effective.provider}/${p.effective.model} (no policy).`);
  }
  const okN = p.todayRuns.filter((r) => r.status === "ok").length;
  const errN = p.todayRuns.length - okN;
  if (p.todayRuns.length === 0) {
    parts.push("No runs recorded today.");
  } else {
    parts.push(`Today: ${p.todayRuns.length} run(s), ${okN} ok, ${errN} error, spent $${p.spendDay.toFixed(4)}.`);
  }
  return parts.join(" ");
}

function printExplain(data: ExplainData): void {
  console.log(data.narrative);
  console.log("");
  for (const f of data.facts) {
    const at = f.at ? `  (${f.at})` : "";
    console.log(`  · [${f.kind}] ${f.detail}${at}`);
  }
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
