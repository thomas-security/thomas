import { agents as agentRegistry, getAgent } from "../agents/registry.js";
import type { AgentId } from "../agents/types.js";
import { ThomasError, runJson } from "../cli/json.js";
import type { RecommendData } from "../cli/output.js";
import { recommend as runRecommender, type Preference } from "../policy/recommender.js";
import { agentHistory } from "../runs/analytics.js";

const KNOWN_AGENTS: AgentId[] = Object.keys(agentRegistry) as AgentId[];

export type RecommendOptions = {
  json: boolean;
  agent: string;
  budgetDay?: number;
  preference?: string;
};

export async function recommend(opts: RecommendOptions): Promise<number> {
  return runJson({
    command: "recommend",
    json: opts.json,
    fetch: () => fetchRecommend(opts),
    printHuman: printRecommend,
  });
}

async function fetchRecommend(opts: RecommendOptions): Promise<RecommendData> {
  const id = validateAgent(opts.agent);
  const spec = getAgent(id);
  if (!spec) {
    // can't reach: validateAgent guards. Defensive throw to satisfy types.
    throw unknownAgent(id);
  }
  const preference = parsePreference(opts.preference);
  const history = await agentHistory(id);
  const suggestions = await runRecommender({
    agent: id,
    protocol: spec.protocol,
    history,
    budgetDay: opts.budgetDay ?? null,
    preference,
  });
  return {
    suggestions: suggestions.map((s) => ({
      rationale: s.rationale,
      policy: {
        primary: s.policy.primary,
        fallback: s.policy.fallback,
        cascade: s.policy.cascade,
      },
      estimatedSpendDay: s.estimatedSpendDay,
      applyCommand: s.applyCommand,
    })),
  };
}

function printRecommend(data: RecommendData): void {
  if (data.suggestions.length === 0) {
    console.log("(no model candidates available for this agent's protocol)");
    return;
  }
  for (let i = 0; i < data.suggestions.length; i++) {
    const s = data.suggestions[i]!;
    const head = `${i + 1}. ${s.rationale}`;
    console.log(head);
    if (s.estimatedSpendDay !== null) {
      console.log(`   estimated:  $${s.estimatedSpendDay.toFixed(4)}/day`);
    } else {
      console.log("   estimated:  (no history — cannot project)");
    }
    console.log(`   apply:      ${s.applyCommand}`);
    console.log("");
  }
}

function parsePreference(raw: string | undefined): Preference {
  if (!raw) return "balanced";
  if (raw === "quality" || raw === "balanced" || raw === "cost") return raw;
  throw new ThomasError({
    code: "E_INVALID_ARG",
    message: `--preference must be 'quality', 'balanced', or 'cost' (got '${raw}')`,
    details: { arg: "--preference", value: raw },
  });
}

function validateAgent(id: string): AgentId {
  if (!(KNOWN_AGENTS as string[]).includes(id)) throw unknownAgent(id);
  return id as AgentId;
}

function unknownAgent(id: string): ThomasError {
  return new ThomasError({
    code: "E_AGENT_NOT_FOUND",
    message: `unknown agent '${id}'`,
    remediation: "Run `thomas doctor` to see installed agents",
    details: { requested: id, known: KNOWN_AGENTS },
  });
}
