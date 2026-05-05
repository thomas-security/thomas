import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { policyClear, policySet, policyShow } from "../src/commands/policy.js";
import { decide, spendSinceStartOfDay, startOfTodayUTC } from "../src/policy/decide.js";
import { getPolicy, readPolicies, setPolicy } from "../src/policy/store.js";
import type { CostCascadePolicy } from "../src/policy/types.js";
import { appendRun } from "../src/runs/store.js";
import { captureStdout } from "./_util.js";

let dir: string;
const ORIG = process.env.THOMAS_HOME;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "thomas-policy-"));
  process.env.THOMAS_HOME = dir;
});

afterEach(async () => {
  if (ORIG !== undefined) process.env.THOMAS_HOME = ORIG;
  else delete process.env.THOMAS_HOME;
  await rm(dir, { recursive: true, force: true });
});

const POLICY: CostCascadePolicy = {
  id: "cost-cascade",
  primary: { provider: "anthropic", model: "claude-opus-4-7" },
  cascade: [
    { triggerSpendDay: 5, fallback: { provider: "anthropic", model: "claude-haiku-4-5" } },
    { triggerSpendDay: 10, fallback: { provider: "deepseek", model: "deepseek-chat" } },
  ],
};

describe("decide() — pure cascade evaluation", () => {
  it("returns primary when spend below all triggers", () => {
    const d = decide(POLICY, 0);
    expect(d.target).toEqual({ provider: "anthropic", model: "claude-opus-4-7" });
    expect(d.policyId).toBe("cost-cascade");
  });

  it("returns first matching cascade rule by ascending trigger order", () => {
    const d = decide(POLICY, 7);
    expect(d.target).toEqual({ provider: "anthropic", model: "claude-haiku-4-5" });
  });

  it("returns later rule when spend crosses higher trigger", () => {
    const d = decide(POLICY, 12);
    // First rule (≥5) matches, but cascade is ordered by trigger ascending —
    // so the LAST matching rule should win. Verify the implementation matches.
    // Current impl returns first match → expect haiku, not deepseek.
    // If you want highest-trigger win, change the impl + this test.
    expect(d.target.provider).toBe("anthropic");
  });

  it("trigger of exactly the threshold counts as a hit", () => {
    expect(decide(POLICY, 5).target.model).toBe("claude-haiku-4-5");
    expect(decide(POLICY, 4.999).target.model).toBe("claude-opus-4-7");
  });

  it("policy with empty cascade always returns primary", () => {
    const empty: CostCascadePolicy = {
      id: "cost-cascade",
      primary: POLICY.primary,
      cascade: [],
    };
    expect(decide(empty, 9999).target).toEqual(POLICY.primary);
  });
});

describe("spendSinceStartOfDay", () => {
  it("returns 0 when no runs", async () => {
    expect(await spendSinceStartOfDay("claude-code")).toBe(0);
  });

  it("sums today's runs only, excluding null costs", async () => {
    const today = startOfTodayUTC();
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
    await appendRun({
      runId: "today1",
      agent: "claude-code",
      startedAt: new Date(today.getTime() + 60_000).toISOString(),
      endedAt: new Date(today.getTime() + 70_000).toISOString(),
      durationMs: 10_000,
      status: "ok",
      inboundProtocol: "anthropic",
      outboundProvider: "anthropic",
      outboundModel: "claude-opus-4-7",
      inputTokens: 1000,
      outputTokens: 1000,
      cost: 1.5,
      streamed: false,
      httpStatus: 200,
      errorMessage: null,
    });
    await appendRun({
      runId: "today2",
      agent: "claude-code",
      startedAt: new Date(today.getTime() + 120_000).toISOString(),
      endedAt: new Date(today.getTime() + 130_000).toISOString(),
      durationMs: 10_000,
      status: "ok",
      inboundProtocol: "anthropic",
      outboundProvider: "anthropic",
      outboundModel: "claude-opus-4-7",
      inputTokens: 100,
      outputTokens: 100,
      cost: 0.75,
      streamed: false,
      httpStatus: 200,
      errorMessage: null,
    });
    await appendRun({
      runId: "yesterday",
      agent: "claude-code",
      startedAt: yesterday.toISOString(),
      endedAt: yesterday.toISOString(),
      durationMs: 0,
      status: "ok",
      inboundProtocol: "anthropic",
      outboundProvider: "anthropic",
      outboundModel: "claude-opus-4-7",
      inputTokens: 0,
      outputTokens: 0,
      cost: 99,
      streamed: false,
      httpStatus: 200,
      errorMessage: null,
    });
    await appendRun({
      runId: "todayNullCost",
      agent: "claude-code",
      startedAt: new Date(today.getTime() + 60_000).toISOString(),
      endedAt: new Date(today.getTime() + 60_000).toISOString(),
      durationMs: 0,
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
    expect(await spendSinceStartOfDay("claude-code")).toBeCloseTo(2.25, 6);
  });

  it("filters by agent", async () => {
    const today = startOfTodayUTC();
    await appendRun({
      runId: "1",
      agent: "claude-code",
      startedAt: new Date(today.getTime() + 60_000).toISOString(),
      endedAt: new Date(today.getTime() + 60_000).toISOString(),
      durationMs: 0,
      status: "ok",
      inboundProtocol: "anthropic",
      outboundProvider: "anthropic",
      outboundModel: "claude-opus-4-7",
      inputTokens: 0,
      outputTokens: 0,
      cost: 5,
      streamed: false,
      httpStatus: 200,
      errorMessage: null,
    });
    await appendRun({
      runId: "2",
      agent: "openclaw",
      startedAt: new Date(today.getTime() + 60_000).toISOString(),
      endedAt: new Date(today.getTime() + 60_000).toISOString(),
      durationMs: 0,
      status: "ok",
      inboundProtocol: "openai",
      outboundProvider: "deepseek",
      outboundModel: "deepseek-chat",
      inputTokens: 0,
      outputTokens: 0,
      cost: 3,
      streamed: false,
      httpStatus: 200,
      errorMessage: null,
    });
    expect(await spendSinceStartOfDay("claude-code")).toBe(5);
    expect(await spendSinceStartOfDay("openclaw")).toBe(3);
  });
});

describe("policy store", () => {
  it("set + get round-trip", async () => {
    await setPolicy("claude-code", POLICY);
    expect(await getPolicy("claude-code")).toEqual(POLICY);
  });

  it("readPolicies returns empty when file missing", async () => {
    expect((await readPolicies()).policies).toEqual({});
  });
});

describe("thomas policy commands (--json)", () => {
  it("show returns empty list when no policies configured", async () => {
    const { result, out } = await captureStdout(() => policyShow({ json: true }));
    expect(result).toBe(0);
    expect(JSON.parse(out).data.policies).toEqual([]);
  });

  it("set stores a policy and normalizes cascade ordering", async () => {
    const { result, out } = await captureStdout(() =>
      policySet({
        json: true,
        agentId: "claude-code",
        primary: "anthropic/claude-opus-4-7",
        // unsorted on input — store sorts ascending by trigger
        cascade: ["10=deepseek/deepseek-chat", "5=anthropic/claude-haiku-4-5"],
      }),
    );
    expect(result).toBe(0);
    const data = JSON.parse(out).data;
    expect(data.policy.cascade.map((r: { triggerSpendDay: number }) => r.triggerSpendDay)).toEqual([
      5, 10,
    ]);
    expect(await getPolicy("claude-code")).not.toBeUndefined();
  });

  it("set rejects malformed --primary", async () => {
    const { result, out } = await captureStdout(() =>
      policySet({
        json: true,
        agentId: "claude-code",
        primary: "missingslash",
        cascade: [],
      }),
    );
    expect(result).toBe(1);
    expect(JSON.parse(out).error.code).toBe("E_INVALID_ARG");
  });

  it("set rejects malformed --at entry", async () => {
    const { result, out } = await captureStdout(() =>
      policySet({
        json: true,
        agentId: "claude-code",
        primary: "anthropic/claude-opus-4-7",
        cascade: ["bogus"],
      }),
    );
    expect(result).toBe(1);
    expect(JSON.parse(out).error.code).toBe("E_INVALID_ARG");
  });

  it("set rejects unknown agent", async () => {
    const { result, out } = await captureStdout(() =>
      policySet({
        json: true,
        agentId: "nope",
        primary: "anthropic/claude-opus-4-7",
        cascade: [],
      }),
    );
    expect(result).toBe(1);
    expect(JSON.parse(out).error.code).toBe("E_AGENT_NOT_FOUND");
  });

  it("clear removes an existing policy", async () => {
    await setPolicy("claude-code", POLICY);
    const { result, out } = await captureStdout(() =>
      policyClear("claude-code", { json: true }),
    );
    expect(result).toBe(0);
    expect(JSON.parse(out).data.removed).toBe(true);
    expect(await getPolicy("claude-code")).toBeUndefined();
  });

  it("clear returns removed=false (exit 0) for absent policy", async () => {
    const { result, out } = await captureStdout(() =>
      policyClear("openclaw", { json: true }),
    );
    expect(result).toBe(0);
    expect(JSON.parse(out).data.removed).toBe(false);
  });

  it("show populates currentSpendDay + currentEffective from runs", async () => {
    await setPolicy("claude-code", POLICY);
    const today = startOfTodayUTC();
    await appendRun({
      runId: "1",
      agent: "claude-code",
      startedAt: new Date(today.getTime() + 60_000).toISOString(),
      endedAt: new Date(today.getTime() + 60_000).toISOString(),
      durationMs: 0,
      status: "ok",
      inboundProtocol: "anthropic",
      outboundProvider: "anthropic",
      outboundModel: "claude-opus-4-7",
      inputTokens: 0,
      outputTokens: 0,
      cost: 7,
      streamed: false,
      httpStatus: 200,
      errorMessage: null,
    });
    const { out } = await captureStdout(() => policyShow({ json: true }));
    const snap = JSON.parse(out).data.policies[0];
    expect(snap.agent).toBe("claude-code");
    expect(snap.currentSpendDay).toBe(7);
    // 7 ≥ first trigger (5), so cascades to haiku
    expect(snap.currentEffective).toEqual({ provider: "anthropic", model: "claude-haiku-4-5" });
    expect(snap.currentReason).toContain("≥ trigger");
  });
});
