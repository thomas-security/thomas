import type { AgentId } from "../agents/types.js";
import { readRuns } from "./store.js";

export type AgentHistory = {
  agent: AgentId;
  windowDays: number;
  runCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  // averaged across the full window — `0 in the numerator` days still count
  avgInputTokensPerDay: number;
  avgOutputTokensPerDay: number;
};

export async function agentHistory(agentId: AgentId, windowDays = 7): Promise<AgentHistory> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const runs = await readRuns({ agent: agentId, since });
  let inTokens = 0;
  let outTokens = 0;
  for (const r of runs) {
    inTokens += r.inputTokens;
    outTokens += r.outputTokens;
  }
  return {
    agent: agentId,
    windowDays,
    runCount: runs.length,
    totalInputTokens: inTokens,
    totalOutputTokens: outTokens,
    avgInputTokensPerDay: inTokens / windowDays,
    avgOutputTokensPerDay: outTokens / windowDays,
  };
}
