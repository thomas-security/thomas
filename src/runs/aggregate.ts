// Group RunRecord[] by runId (set via X-Thomas-Run-Id header). Multiple HTTP
// requests sharing a runId aggregate into one logical "task" with summed
// tokens/cost and per-model breakdown. Records without the header have
// unique generated runIds and aggregate to themselves (modelCalls = 1).

import type { Protocol } from "../agents/types.js";
import type { RunRecord } from "./types.js";

export type AggregatedRun = {
  runId: string;
  agent: RunRecord["agent"];
  startedAt: string;
  endedAt: string;
  durationMs: number;
  // "error" if any call failed; otherwise "ok"
  status: "ok" | "error";
  inboundProtocol: Protocol;
  modelCalls: number;
  failovers: number;
  inputTokens: number;
  outputTokens: number;
  // sum of non-null costs; null only when EVERY call had unknown pricing
  cost: number | null;
  modelsUsed: Array<{
    provider: string;
    model: string;
    calls: number;
    cost: number | null;
  }>;
};

export function aggregateRecords(records: RunRecord[]): AggregatedRun[] {
  const groups = new Map<string, RunRecord[]>();
  for (const r of records) {
    const bucket = groups.get(r.runId);
    if (bucket) bucket.push(r);
    else groups.set(r.runId, [r]);
  }

  const result: AggregatedRun[] = [];
  for (const [runId, list] of groups.entries()) {
    list.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
    const first = list[0]!;
    const last = list[list.length - 1]!;

    let tokensIn = 0;
    let tokensOut = 0;
    let failovers = 0;
    let hasError = false;
    let knownCostSum = 0;
    let anyKnownCost = false;
    const modelMap = new Map<
      string,
      { provider: string; model: string; calls: number; cost: number | null }
    >();
    for (const r of list) {
      tokensIn += r.inputTokens;
      tokensOut += r.outputTokens;
      failovers += r.failovers ?? 0;
      if (r.status === "error") hasError = true;
      if (r.cost !== null) {
        knownCostSum += r.cost;
        anyKnownCost = true;
      }
      const key = `${r.outboundProvider}/${r.outboundModel}`;
      const existing = modelMap.get(key);
      if (existing) {
        existing.calls += 1;
        if (r.cost !== null) existing.cost = (existing.cost ?? 0) + r.cost;
      } else {
        modelMap.set(key, {
          provider: r.outboundProvider,
          model: r.outboundModel,
          calls: 1,
          cost: r.cost,
        });
      }
    }

    result.push({
      runId,
      agent: first.agent,
      startedAt: first.startedAt,
      endedAt: last.endedAt,
      durationMs: Date.parse(last.endedAt) - Date.parse(first.startedAt),
      status: hasError ? "error" : "ok",
      inboundProtocol: first.inboundProtocol,
      modelCalls: list.length,
      failovers,
      inputTokens: tokensIn,
      outputTokens: tokensOut,
      cost: anyKnownCost ? knownCostSum : null,
      modelsUsed: [...modelMap.values()],
    });
  }

  // newest first by endedAt
  result.sort((a, b) => (a.endedAt < b.endedAt ? 1 : -1));
  return result;
}
