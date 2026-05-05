import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runs } from "../src/commands/runs.js";
import { computeCost } from "../src/runs/pricing.js";
import { appendRun, readRuns } from "../src/runs/store.js";
import type { RunRecord } from "../src/runs/types.js";
import { StreamUsageWatcher, extractUsageFromBody } from "../src/runs/usage.js";
import { captureStdout } from "./_util.js";

let dir: string;
const ORIG = process.env.THOMAS_HOME;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "thomas-runs-"));
  process.env.THOMAS_HOME = dir;
});

afterEach(async () => {
  if (ORIG !== undefined) process.env.THOMAS_HOME = ORIG;
  else delete process.env.THOMAS_HOME;
  await rm(dir, { recursive: true, force: true });
});

describe("pricing", () => {
  it("computes cost correctly for a known model", async () => {
    // 1M input × $15 + 1M output × $75 / 1M tokens = $90
    expect(
      await computeCost("anthropic", "claude-opus-4-7", 1_000_000, 1_000_000),
    ).toBeCloseTo(90, 4);
  });

  it("computes cost for fractional usage", async () => {
    // 100 input × $0.15 + 200 output × $0.6 / 1M = (15 + 120) / 1M = 0.000135
    expect(await computeCost("openai", "gpt-4o-mini", 100, 200)).toBeCloseTo(0.000135, 7);
  });

  it("returns null for unknown model", async () => {
    expect(await computeCost("openrouter", "fake-model", 1000, 1000)).toBeNull();
  });
});

describe("extractUsageFromBody (non-streaming)", () => {
  it("extracts Anthropic usage", () => {
    const body = JSON.stringify({ usage: { input_tokens: 123, output_tokens: 456 } });
    expect(extractUsageFromBody(body, "anthropic")).toEqual({ input: 123, output: 456 });
  });

  it("extracts OpenAI usage", () => {
    const body = JSON.stringify({ usage: { prompt_tokens: 50, completion_tokens: 60 } });
    expect(extractUsageFromBody(body, "openai")).toEqual({ input: 50, output: 60 });
  });

  it("returns zeros for missing usage field", () => {
    expect(extractUsageFromBody(JSON.stringify({ id: "x" }), "anthropic")).toEqual({
      input: 0,
      output: 0,
    });
  });

  it("returns zeros for malformed JSON", () => {
    expect(extractUsageFromBody("{not json", "openai")).toEqual({ input: 0, output: 0 });
  });
});

describe("StreamUsageWatcher (Anthropic SSE)", () => {
  it("captures input from message_start and output from message_delta", () => {
    const w = new StreamUsageWatcher("anthropic");
    const events = [
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 200, output_tokens: 0 } } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta" })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 75 } })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    ];
    for (const evt of events) w.feed(new TextEncoder().encode(evt));
    expect(w.finalize()).toEqual({ input: 200, output: 75 });
  });

  it("handles chunks split across feed boundaries", () => {
    const w = new StreamUsageWatcher("anthropic");
    const full = `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 100 } } })}\n\nevent: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 30 } })}\n\n`;
    const bytes = new TextEncoder().encode(full);
    // split into 16-byte chunks
    for (let i = 0; i < bytes.length; i += 16) {
      w.feed(bytes.slice(i, i + 16));
    }
    expect(w.finalize()).toEqual({ input: 100, output: 30 });
  });
});

describe("StreamUsageWatcher (OpenAI SSE)", () => {
  it("captures usage from final chunk with stream_options.include_usage", () => {
    const w = new StreamUsageWatcher("openai");
    const events = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 34 } })}\n\n`,
      `data: [DONE]\n\n`,
    ];
    for (const evt of events) w.feed(new TextEncoder().encode(evt));
    expect(w.finalize()).toEqual({ input: 12, output: 34 });
  });

  it("returns zeros when no usage is sent", () => {
    const w = new StreamUsageWatcher("openai");
    w.feed(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\ndata: [DONE]\n\n`));
    expect(w.finalize()).toEqual({ input: 0, output: 0 });
  });
});

describe("store: appendRun + readRuns", () => {
  function makeRecord(overrides: Partial<RunRecord> = {}): RunRecord {
    return {
      runId: "11111111-2222-3333-4444-555555555555",
      agent: "claude-code",
      startedAt: "2026-05-03T10:00:00.000Z",
      endedAt: "2026-05-03T10:00:01.000Z",
      durationMs: 1000,
      status: "ok",
      inboundProtocol: "anthropic",
      outboundProvider: "anthropic",
      outboundModel: "claude-opus-4-7",
      inputTokens: 100,
      outputTokens: 200,
      cost: 0.0165,
      streamed: false,
      httpStatus: 200,
      errorMessage: null,
      ...overrides,
    };
  }

  it("round-trips a single record", async () => {
    const rec = makeRecord();
    await appendRun(rec);
    const got = await readRuns();
    expect(got).toEqual([rec]);
  });

  it("returns newest-first", async () => {
    await appendRun(makeRecord({ runId: "a", endedAt: "2026-05-03T10:00:00.000Z" }));
    await appendRun(makeRecord({ runId: "b", endedAt: "2026-05-03T11:00:00.000Z" }));
    await appendRun(makeRecord({ runId: "c", endedAt: "2026-05-03T09:00:00.000Z" }));
    const got = await readRuns();
    expect(got.map((r) => r.runId)).toEqual(["b", "a", "c"]);
  });

  it("filters by agent", async () => {
    await appendRun(makeRecord({ runId: "1", agent: "claude-code" }));
    await appendRun(makeRecord({ runId: "2", agent: "openclaw" }));
    const got = await readRuns({ agent: "openclaw" });
    expect(got.map((r) => r.runId)).toEqual(["2"]);
  });

  it("filters by since", async () => {
    await appendRun(makeRecord({ runId: "old", endedAt: "2026-05-01T00:00:00.000Z" }));
    await appendRun(makeRecord({ runId: "new", endedAt: "2026-05-04T00:00:00.000Z" }));
    const got = await readRuns({ since: new Date("2026-05-03T00:00:00.000Z") });
    expect(got.map((r) => r.runId)).toEqual(["new"]);
  });

  it("respects limit", async () => {
    for (let i = 0; i < 5; i++) {
      await appendRun(makeRecord({ runId: `r${i}`, endedAt: `2026-05-0${i + 1}T00:00:00.000Z` }));
    }
    const got = await readRuns({ limit: 2 });
    expect(got).toHaveLength(2);
    expect(got.map((r) => r.runId)).toEqual(["r4", "r3"]);
  });

  it("returns empty list when file does not exist", async () => {
    expect(await readRuns()).toEqual([]);
  });

  it("skips malformed lines", async () => {
    await appendRun(makeRecord({ runId: "good" }));
    // append a corrupt line
    const { appendFile } = await import("node:fs/promises");
    const { paths } = await import("../src/config/paths.js");
    await appendFile(paths.runs, "{not valid json\n");
    await appendRun(makeRecord({ runId: "alsogood" }));
    const got = await readRuns();
    expect(got.map((r) => r.runId).sort()).toEqual(["alsogood", "good"]);
  });
});

describe("thomas runs (--json)", () => {
  it("returns empty list when no runs exist", async () => {
    const { result, out } = await captureStdout(() => runs({ json: true }));
    expect(result).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.command).toBe("runs");
    expect(parsed.data.runs).toEqual([]);
  });

  it("translates RunRecord to RunSummary shape", async () => {
    await appendRun({
      runId: "abcdef01-2345-6789-abcd-ef0123456789",
      agent: "claude-code",
      startedAt: "2026-05-03T10:00:00.000Z",
      endedAt: "2026-05-03T10:00:02.500Z",
      durationMs: 2500,
      status: "ok",
      inboundProtocol: "anthropic",
      outboundProvider: "anthropic",
      outboundModel: "claude-opus-4-7",
      inputTokens: 1000,
      outputTokens: 500,
      cost: 0.0525,
      streamed: true,
      httpStatus: 200,
      errorMessage: null,
    });
    const { out } = await captureStdout(() => runs({ json: true }));
    const summary = JSON.parse(out).data.runs[0];
    expect(summary.runId).toBe("abcdef01-2345-6789-abcd-ef0123456789");
    expect(summary.agent).toBe("claude-code");
    expect(summary.tokens).toEqual({ input: 1000, output: 500 });
    expect(summary.spend).toBe(0.0525);
    expect(summary.modelCalls).toBe(1);
    expect(summary.failovers).toBe(0);
    expect(summary.modelsUsed).toEqual([
      { ref: { provider: "anthropic", model: "claude-opus-4-7" }, calls: 1, spend: 0.0525 },
    ]);
  });

  it("preserves spend=null for unknown-priced models", async () => {
    await appendRun({
      runId: "1",
      agent: "claude-code",
      startedAt: "2026-05-03T10:00:00.000Z",
      endedAt: "2026-05-03T10:00:01.000Z",
      durationMs: 1000,
      status: "ok",
      inboundProtocol: "openai",
      outboundProvider: "openrouter",
      outboundModel: "fake/model",
      inputTokens: 10,
      outputTokens: 10,
      cost: null,
      streamed: false,
      httpStatus: 200,
      errorMessage: null,
    });
    const { out } = await captureStdout(() => runs({ json: true }));
    const summary = JSON.parse(out).data.runs[0];
    expect(summary.spend).toBeNull();
    expect(summary.modelsUsed[0].spend).toBeNull();
  });

  it("rejects malformed --since with E_INVALID_ARG", async () => {
    const { result, out } = await captureStdout(() =>
      runs({ json: true, since: "not-a-date" }),
    );
    expect(result).toBe(1);
    expect(JSON.parse(out).error.code).toBe("E_INVALID_ARG");
  });
});
