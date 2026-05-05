import type { AgentId } from "../agents/types.js";
import { ThomasError, runJson } from "../cli/json.js";
import type { RunSummary, RunsData } from "../cli/output.js";
import { aggregateRecords, type AggregatedRun } from "../runs/aggregate.js";
import { readRuns } from "../runs/store.js";
import type { RunRecord } from "../runs/types.js";

const DEFAULT_LIMIT = 20;

export type RunsOptions = {
  json: boolean;
  agent?: string;
  since?: string;
  limit?: number;
  // when true, return one summary per HTTP request (raw RunRecord). When false (default),
  // group by runId so multi-call tasks (X-Thomas-Run-Id) collapse to one summary.
  perCall?: boolean;
};

export async function runs(opts: RunsOptions): Promise<number> {
  return runJson({
    command: "runs",
    json: opts.json,
    fetch: () => fetchRuns(opts),
    printHuman: printRuns,
  });
}

async function fetchRuns(opts: RunsOptions): Promise<RunsData> {
  let since: Date | undefined;
  if (opts.since) {
    const parsed = new Date(opts.since);
    if (Number.isNaN(parsed.getTime())) {
      throw new ThomasError({
        code: "E_INVALID_ARG",
        message: `--since must be an ISO-8601 timestamp (got '${opts.since}')`,
        details: { arg: "--since", value: opts.since },
      });
    }
    since = parsed;
  }
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const records = await readRuns({
    agent: opts.agent as AgentId | undefined,
    since,
    // for per-call mode, limit at the record level; for aggregated, we limit after grouping
    limit: opts.perCall ? limit : undefined,
  });
  if (opts.perCall) return { runs: records.map(toCallSummary) };
  const aggregated = aggregateRecords(records).slice(0, limit);
  return { runs: aggregated.map(toAggregatedSummary) };
}

function toCallSummary(r: RunRecord): RunSummary {
  return {
    runId: r.runId,
    agent: r.agent,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    durationMs: r.durationMs,
    status: r.status,
    modelCalls: 1,
    tokens: { input: r.inputTokens, output: r.outputTokens },
    spend: r.cost,
    failovers: r.failovers ?? 0,
    modelsUsed: [
      {
        ref: { provider: r.outboundProvider, model: r.outboundModel },
        calls: 1,
        spend: r.cost,
      },
    ],
  };
}

function toAggregatedSummary(a: AggregatedRun): RunSummary {
  return {
    runId: a.runId,
    agent: a.agent,
    startedAt: a.startedAt,
    endedAt: a.endedAt,
    durationMs: a.durationMs,
    status: a.status,
    modelCalls: a.modelCalls,
    tokens: { input: a.inputTokens, output: a.outputTokens },
    spend: a.cost,
    failovers: a.failovers,
    modelsUsed: a.modelsUsed.map((m) => ({
      ref: { provider: m.provider, model: m.model },
      calls: m.calls,
      spend: m.cost,
    })),
  };
}

function printRuns(data: RunsData): void {
  if (data.runs.length === 0) {
    console.log("(no runs recorded yet)");
    return;
  }
  console.log("RunId     Agent          Calls  Tokens(in/out)   Spend     Status   When");
  for (const r of data.runs) {
    const id = r.runId.slice(0, 8);
    const agent = r.agent.padEnd(13);
    const calls = String(r.modelCalls).padStart(5);
    const tokens = `${r.tokens.input}/${r.tokens.output}`.padEnd(15);
    const spend = r.spend === null ? "  ?    " : `$${r.spend.toFixed(4)}`.padEnd(8);
    const status = r.status.padEnd(7);
    const when = r.endedAt;
    console.log(`${id}  ${agent}  ${calls}  ${tokens}  ${spend} ${status}  ${when}`);
  }
}
