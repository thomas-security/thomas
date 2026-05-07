import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getMeter } from "../src/metering/registry.js";
import { TokenMeter } from "../src/metering/token-meter.js";
import { windowStart } from "../src/metering/types.js";
import { appendRun } from "../src/runs/store.js";
import type { RunRecord } from "../src/runs/types.js";

let dir: string;
const ORIG = process.env.THOMAS_HOME;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "thomas-meter-"));
  process.env.THOMAS_HOME = dir;
});

afterEach(async () => {
  if (ORIG !== undefined) process.env.THOMAS_HOME = ORIG;
  else delete process.env.THOMAS_HOME;
  await rm(dir, { recursive: true, force: true });
});

function record(overrides: Partial<RunRecord>): RunRecord {
  return {
    runId: "r",
    agent: "claude-code",
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: 0,
    status: "ok",
    inboundProtocol: "anthropic",
    outboundProvider: "anthropic",
    outboundModel: "claude-opus-4-7",
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    streamed: false,
    httpStatus: 200,
    errorMessage: null,
    failovers: 0,
    failoverNote: null,
    ...overrides,
  };
}

describe("windowStart", () => {
  it("'day' returns UTC midnight of the given moment", () => {
    const noon = new Date(Date.UTC(2026, 4, 7, 12, 34, 56));
    expect(windowStart("day", noon).toISOString()).toBe("2026-05-07T00:00:00.000Z");
  });
});

describe("TokenMeter.usageInWindow('day')", () => {
  const meter = new TokenMeter();
  const today = windowStart("day");
  const stamp = (offsetSec: number) => new Date(today.getTime() + offsetSec * 1000).toISOString();

  it("returns zeros when no runs exist for the agent", async () => {
    expect(await meter.usageInWindow("claude-code", "day")).toEqual({
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      spend: 0,
    });
  });

  it("sums today's runs across calls / tokens / spend", async () => {
    await appendRun(record({ runId: "a", endedAt: stamp(60), inputTokens: 100, outputTokens: 50, cost: 0.5 }));
    await appendRun(record({ runId: "b", endedAt: stamp(120), inputTokens: 200, outputTokens: 80, cost: 0.75 }));
    expect(await meter.usageInWindow("claude-code", "day")).toEqual({
      calls: 2,
      inputTokens: 300,
      outputTokens: 130,
      spend: 1.25,
    });
  });

  it("excludes runs from before the window start", async () => {
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000).toISOString();
    await appendRun(record({ runId: "yesterday", endedAt: yesterday, inputTokens: 1_000_000, cost: 100 }));
    await appendRun(record({ runId: "today", endedAt: stamp(60), inputTokens: 10, cost: 0.01 }));
    const u = await meter.usageInWindow("claude-code", "day");
    expect(u.calls).toBe(1);
    expect(u.inputTokens).toBe(10);
    expect(u.spend).toBeCloseTo(0.01, 6);
  });

  it("filters by agent — other agents' runs do not contaminate", async () => {
    await appendRun(record({ runId: "a", agent: "claude-code", endedAt: stamp(60), cost: 1 }));
    await appendRun(record({ runId: "b", agent: "openclaw", endedAt: stamp(60), cost: 2 }));
    expect((await meter.usageInWindow("claude-code", "day")).spend).toBe(1);
    expect((await meter.usageInWindow("openclaw", "day")).spend).toBe(2);
  });

  it("returns spend: null when any run in the window has cost: null", async () => {
    await appendRun(record({ runId: "priced", endedAt: stamp(60), cost: 0.5 }));
    await appendRun(record({ runId: "unpriced", endedAt: stamp(120), cost: null }));
    const u = await meter.usageInWindow("claude-code", "day");
    expect(u.calls).toBe(2);
    expect(u.spend).toBeNull();
  });
});

describe("getMeter", () => {
  it("returns a TokenMeter for any agent (v0.1.0 default)", () => {
    expect(getMeter("claude-code")).toBeInstanceOf(TokenMeter);
    expect(getMeter("openclaw")).toBeInstanceOf(TokenMeter);
  });
});
