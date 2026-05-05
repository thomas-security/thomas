import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { explain } from "../src/commands/explain.js";
import { runs } from "../src/commands/runs.js";
import { aggregateRecords } from "../src/runs/aggregate.js";
import { appendRun, findRecordsForRun } from "../src/runs/store.js";
import type { RunRecord } from "../src/runs/types.js";
import { captureStdout } from "./_util.js";

let dir: string;
const ORIG = process.env.THOMAS_HOME;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "thomas-agg-"));
  process.env.THOMAS_HOME = dir;
});

afterEach(async () => {
  if (ORIG !== undefined) process.env.THOMAS_HOME = ORIG;
  else delete process.env.THOMAS_HOME;
  await rm(dir, { recursive: true, force: true });
});

function rec(overrides: Partial<RunRecord>): RunRecord {
  return {
    runId: "r1",
    agent: "claude-code",
    startedAt: "2026-05-04T10:00:00.000Z",
    endedAt: "2026-05-04T10:00:01.000Z",
    durationMs: 1000,
    status: "ok",
    inboundProtocol: "anthropic",
    outboundProvider: "anthropic",
    outboundModel: "claude-opus-4-7",
    inputTokens: 100,
    outputTokens: 50,
    cost: 0.005,
    streamed: false,
    httpStatus: 200,
    errorMessage: null,
    failovers: 0,
    failoverNote: null,
    ...overrides,
  };
}

describe("aggregateRecords", () => {
  it("collapses records sharing a runId into a single AggregatedRun", () => {
    const records = [
      rec({ runId: "task-1", startedAt: "2026-05-04T10:00:00.000Z", endedAt: "2026-05-04T10:00:01.000Z", inputTokens: 100, outputTokens: 50, cost: 0.005 }),
      rec({ runId: "task-1", startedAt: "2026-05-04T10:00:02.000Z", endedAt: "2026-05-04T10:00:03.000Z", inputTokens: 200, outputTokens: 75, cost: 0.01 }),
      rec({ runId: "task-1", startedAt: "2026-05-04T10:00:05.000Z", endedAt: "2026-05-04T10:00:06.500Z", inputTokens: 50, outputTokens: 25, cost: 0.0025 }),
    ];
    const agg = aggregateRecords(records);
    expect(agg).toHaveLength(1);
    const a = agg[0]!;
    expect(a.runId).toBe("task-1");
    expect(a.modelCalls).toBe(3);
    expect(a.inputTokens).toBe(350);
    expect(a.outputTokens).toBe(150);
    expect(a.cost).toBeCloseTo(0.0175, 6);
    expect(a.startedAt).toBe("2026-05-04T10:00:00.000Z");
    expect(a.endedAt).toBe("2026-05-04T10:00:06.500Z");
    expect(a.durationMs).toBe(6500);
  });

  it("keeps distinct runIds as separate aggregated runs, newest endedAt first", () => {
    const records = [
      rec({ runId: "a", endedAt: "2026-05-04T10:00:00.000Z" }),
      rec({ runId: "b", endedAt: "2026-05-04T11:00:00.000Z" }),
    ];
    const agg = aggregateRecords(records);
    expect(agg.map((r) => r.runId)).toEqual(["b", "a"]);
  });

  it("status is 'error' if any call errored, else 'ok'", () => {
    const ok = aggregateRecords([rec({ runId: "x" }), rec({ runId: "x" })])[0]!;
    expect(ok.status).toBe("ok");
    const mixed = aggregateRecords([
      rec({ runId: "y", status: "ok" }),
      rec({ runId: "y", status: "error", httpStatus: 500, errorMessage: "boom" }),
    ])[0]!;
    expect(mixed.status).toBe("error");
  });

  it("cost is null only when EVERY call had unknown pricing", () => {
    const allNull = aggregateRecords([rec({ runId: "n", cost: null }), rec({ runId: "n", cost: null })])[0]!;
    expect(allNull.cost).toBeNull();
    const partial = aggregateRecords([rec({ runId: "p", cost: null }), rec({ runId: "p", cost: 0.5 })])[0]!;
    expect(partial.cost).toBeCloseTo(0.5, 6);
  });

  it("modelsUsed groups per provider+model with calls and cost subtotals", () => {
    const records = [
      rec({ runId: "z", outboundProvider: "anthropic", outboundModel: "opus", cost: 0.1 }),
      rec({ runId: "z", outboundProvider: "anthropic", outboundModel: "opus", cost: 0.2 }),
      rec({ runId: "z", outboundProvider: "anthropic", outboundModel: "haiku", cost: 0.05 }),
    ];
    const a = aggregateRecords(records)[0]!;
    expect(a.modelsUsed).toHaveLength(2);
    const opus = a.modelsUsed.find((m) => m.model === "opus")!;
    expect(opus.calls).toBe(2);
    expect(opus.cost).toBeCloseTo(0.3, 6);
    const haiku = a.modelsUsed.find((m) => m.model === "haiku")!;
    expect(haiku.calls).toBe(1);
    expect(haiku.cost).toBeCloseTo(0.05, 6);
  });

  it("sums failovers across calls", () => {
    const records = [
      rec({ runId: "f", failovers: 0 }),
      rec({ runId: "f", failovers: 1 }),
      rec({ runId: "f", failovers: 1 }),
    ];
    expect(aggregateRecords(records)[0]!.failovers).toBe(2);
  });

  it("treats single-record runs identically to before (modelCalls=1)", () => {
    const a = aggregateRecords([rec({ runId: "solo" })])[0]!;
    expect(a.modelCalls).toBe(1);
    expect(a.inputTokens).toBe(100);
  });
});

describe("findRecordsForRun", () => {
  it("returns all records sharing a runId, oldest first", async () => {
    await appendRun(rec({ runId: "task-x", startedAt: "2026-05-04T10:00:02.000Z", endedAt: "2026-05-04T10:00:03.000Z" }));
    await appendRun(rec({ runId: "task-x", startedAt: "2026-05-04T10:00:00.000Z", endedAt: "2026-05-04T10:00:01.000Z" }));
    await appendRun(rec({ runId: "other-task" }));
    const records = await findRecordsForRun("task-x");
    expect(records).toHaveLength(2);
    expect(records[0]!.startedAt).toBe("2026-05-04T10:00:00.000Z");
    expect(records[1]!.startedAt).toBe("2026-05-04T10:00:02.000Z");
  });

  it("matches by short prefix and returns the correct group", async () => {
    await appendRun(rec({ runId: "abcdef01-2345-6789-aaaa-bbbbbbbbbbbb" }));
    await appendRun(rec({ runId: "abcdef01-2345-6789-aaaa-bbbbbbbbbbbb" }));
    await appendRun(rec({ runId: "11111111-2222-3333-4444-555555555555" }));
    const records = await findRecordsForRun("abcdef01");
    expect(records).toHaveLength(2);
  });

  it("returns empty when no match", async () => {
    expect(await findRecordsForRun("nope")).toEqual([]);
  });
});

describe("thomas runs (default vs --per-call)", () => {
  beforeEach(async () => {
    await appendRun(rec({ runId: "task-1", startedAt: "2026-05-04T10:00:00.000Z", endedAt: "2026-05-04T10:00:01.000Z" }));
    await appendRun(rec({ runId: "task-1", startedAt: "2026-05-04T10:00:02.000Z", endedAt: "2026-05-04T10:00:03.000Z" }));
    await appendRun(rec({ runId: "task-2", startedAt: "2026-05-04T10:01:00.000Z", endedAt: "2026-05-04T10:01:01.000Z" }));
  });

  it("default groups by runId — 3 records collapse to 2 rows", async () => {
    const { out } = await captureStdout(() => runs({ json: true }));
    const data = JSON.parse(out).data;
    expect(data.runs).toHaveLength(2);
    const t1 = data.runs.find((r: { runId: string }) => r.runId === "task-1");
    expect(t1.modelCalls).toBe(2);
    expect(t1.tokens.input).toBe(200);
  });

  it("--per-call returns one row per HTTP request", async () => {
    const { out } = await captureStdout(() => runs({ json: true, perCall: true }));
    const data = JSON.parse(out).data;
    expect(data.runs).toHaveLength(3);
    for (const r of data.runs) expect(r.modelCalls).toBe(1);
  });
});

describe("thomas explain --run on a multi-call task", () => {
  it("narrates total + per-call breakdown when records share a runId", async () => {
    await appendRun(rec({ runId: "task-X", startedAt: "2026-05-04T10:00:00.000Z", endedAt: "2026-05-04T10:00:01.000Z", inputTokens: 100, outputTokens: 50, cost: 0.01 }));
    await appendRun(rec({ runId: "task-X", startedAt: "2026-05-04T10:00:02.000Z", endedAt: "2026-05-04T10:00:03.000Z", inputTokens: 200, outputTokens: 75, cost: 0.02, outboundModel: "claude-haiku-4-5" }));
    await appendRun(rec({ runId: "task-X", startedAt: "2026-05-04T10:00:05.000Z", endedAt: "2026-05-04T10:00:06.000Z", inputTokens: 50, outputTokens: 25, cost: 0.005, status: "error", httpStatus: 503, errorMessage: "upstream 503" }));
    const { result, out } = await captureStdout(() => explain({ json: true, runId: "task-X" }));
    expect(result).toBe(0);
    const data = JSON.parse(out).data;
    expect(data.subject).toEqual({ type: "run", id: "task-X" });
    expect(data.narrative).toContain("3 model calls");
    expect(data.narrative).toContain("$0.035000"); // 0.01 + 0.02 + 0.005
    expect(data.narrative).toContain("1 error");
    // facts include per-call entries
    const callFacts = data.facts.filter((f: { detail: string }) => /^call \d+\/3:/.test(f.detail));
    expect(callFacts).toHaveLength(3);
  });

  it("falls back to single-call narrative for solo runIds", async () => {
    await appendRun(rec({ runId: "single-1", inputTokens: 1, outputTokens: 1 }));
    const { out } = await captureStdout(() => explain({ json: true, runId: "single-1" }));
    const data = JSON.parse(out).data;
    expect(data.narrative).toContain("Run single-1");
    expect(data.narrative).not.toContain("model calls"); // single-call narrative
  });
});
