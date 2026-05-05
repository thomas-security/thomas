import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { recommend as recommendCmd } from "../src/commands/recommend.js";
import { recommend, type Suggestion } from "../src/policy/recommender.js";
import type { AgentHistory } from "../src/runs/analytics.js";
import { setOverlayPrice } from "../src/runs/prices-store.js";
import { appendRun } from "../src/runs/store.js";
import type { RunRecord } from "../src/runs/types.js";
import { captureStdout } from "./_util.js";

let dir: string;
const ORIG = process.env.THOMAS_HOME;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "thomas-recommend-"));
  process.env.THOMAS_HOME = dir;
});

afterEach(async () => {
  if (ORIG !== undefined) process.env.THOMAS_HOME = ORIG;
  else delete process.env.THOMAS_HOME;
  await rm(dir, { recursive: true, force: true });
});

const HISTORY_HEAVY: AgentHistory = {
  agent: "claude-code",
  windowDays: 7,
  runCount: 100,
  totalInputTokens: 7_000_000, // 1M/day
  totalOutputTokens: 1_400_000, // 200K/day
  avgInputTokensPerDay: 1_000_000,
  avgOutputTokensPerDay: 200_000,
};

const HISTORY_NONE: AgentHistory = {
  agent: "claude-code",
  windowDays: 7,
  runCount: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  avgInputTokensPerDay: 0,
  avgOutputTokensPerDay: 0,
};

describe("recommend() — pure heuristic", () => {
  it("returns 3 suggestions for an anthropic agent with history (default balanced)", async () => {
    const s = await recommend({
      agent: "claude-code",
      protocol: "anthropic",
      history: HISTORY_HEAVY,
      budgetDay: 5,
      preference: "balanced",
    });
    expect(s).toHaveLength(3);
    // balanced: cascade first, then premium, then cheap
    expect(s[0]!.policy.cascade).not.toBeNull();
    expect(s[1]!.policy.cascade).toBeNull();
    expect(s[2]!.policy.cascade).toBeNull();
  });

  it("preference=quality puts pure-premium first", async () => {
    const s = await recommend({
      agent: "claude-code",
      protocol: "anthropic",
      history: HISTORY_HEAVY,
      budgetDay: 5,
      preference: "quality",
    });
    expect(s[0]!.policy.primary.model).toBe("claude-opus-4-7");
    expect(s[0]!.policy.cascade).toBeNull();
  });

  it("preference=cost puts pure-cheap first", async () => {
    const s = await recommend({
      agent: "claude-code",
      protocol: "anthropic",
      history: HISTORY_HEAVY,
      budgetDay: 5,
      preference: "cost",
    });
    expect(s[0]!.policy.primary.model).toBe("claude-haiku-4-5");
  });

  it("estimates cost from history; cascade caps spend at trigger", async () => {
    const s = await recommend({
      agent: "claude-code",
      protocol: "anthropic",
      history: HISTORY_HEAVY,
      budgetDay: 5,
      preference: "quality",
    });
    // Pure premium = 1M*15 + 200K*75 = 15 + 15 = $30/day
    const purePremium = s.find(
      (x: Suggestion) => x.policy.cascade === null && x.policy.primary.model === "claude-opus-4-7",
    );
    expect(purePremium!.estimatedSpendDay).toBeCloseTo(30, 4);
    // Cascade with $5 trigger; fallback to haiku
    const cascade = s.find((x: Suggestion) => x.policy.cascade !== null);
    // Pure haiku = 1M*1 + 200K*5 = 1 + 1 = $2/day
    // cascade ≈ 5 + 2 * (1 - 5/30) = 5 + 2*25/30 ≈ 6.67
    expect(cascade!.estimatedSpendDay).toBeCloseTo(6.6667, 1);
  });

  it("returns null estimates when no history, but still produces suggestions", async () => {
    const s = await recommend({
      agent: "claude-code",
      protocol: "anthropic",
      history: HISTORY_NONE,
      budgetDay: 5,
      preference: "balanced",
    });
    expect(s.length).toBeGreaterThan(0);
    for (const x of s) {
      expect(x.estimatedSpendDay).toBeNull();
    }
  });

  it("uses half of premium projection when no budgetDay given", async () => {
    const s = await recommend({
      agent: "claude-code",
      protocol: "anthropic",
      history: HISTORY_HEAVY,
      budgetDay: null,
      preference: "balanced",
    });
    // Pure premium would be $30/day → cascade trigger = 15
    const cascade = s.find((x: Suggestion) => x.policy.cascade !== null);
    expect(cascade!.policy.cascade!.triggerSpendDay).toBe(15);
  });

  it("emits an executable applyCommand for each suggestion", async () => {
    const s = await recommend({
      agent: "claude-code",
      protocol: "anthropic",
      history: HISTORY_HEAVY,
      budgetDay: 5,
      preference: "balanced",
    });
    for (const x of s) {
      expect(x.applyCommand.startsWith("thomas ")).toBe(true);
    }
    const cascade = s.find((x: Suggestion) => x.policy.cascade !== null);
    expect(cascade!.applyCommand).toContain("policy set claude-code");
    expect(cascade!.applyCommand).toContain("--at 5=");
  });

  it("works for openai protocol with the openai/deepseek/groq pool", async () => {
    const s = await recommend({
      agent: "codex",
      protocol: "openai",
      history: { ...HISTORY_HEAVY, agent: "codex" },
      budgetDay: 1,
      preference: "balanced",
    });
    expect(s.length).toBeGreaterThan(0);
    for (const x of s) {
      // primary or fallback should always be from openai-protocol providers
      const all = [x.policy.primary, x.policy.fallback].filter(Boolean) as { provider: string }[];
      for (const ref of all) {
        expect(["openai", "deepseek", "groq", "kimi"]).toContain(ref.provider);
      }
    }
  });

  it("includes overlay-with-tier-and-protocol entries in candidate selection", async () => {
    // Add an overlay model that's CHEAPER than every builtin anthropic-cheap model
    // and tagged premium. With preference=quality this overlay should win the premium slot.
    await setOverlayPrice("openrouter/super-opus", {
      input: 0.01,
      output: 0.01,
      protocol: "anthropic",
      tier: "premium",
    });
    const s = await recommend({
      agent: "claude-code",
      protocol: "anthropic",
      history: HISTORY_HEAVY,
      budgetDay: 5,
      preference: "quality",
    });
    expect(s[0]!.policy.primary).toEqual({
      provider: "openrouter",
      model: "super-opus",
    });
  });

  it("ignores overlay entries that lack tier or protocol", async () => {
    // Just price, no metadata — won't be a recommend candidate even if cheap.
    await setOverlayPrice("openrouter/no-meta", { input: 0.001, output: 0.001 });
    const s = await recommend({
      agent: "claude-code",
      protocol: "anthropic",
      history: HISTORY_HEAVY,
      budgetDay: 5,
      preference: "quality",
    });
    // builtin Opus still wins
    expect(s[0]!.policy.primary).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-7",
    });
  });
});

describe("thomas recommend (--json command)", () => {
  function record(overrides: Partial<RunRecord>): RunRecord {
    return {
      runId: "r1",
      agent: "claude-code",
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      endedAt: new Date(Date.now() - 50_000).toISOString(),
      durationMs: 10_000,
      status: "ok",
      inboundProtocol: "anthropic",
      outboundProvider: "anthropic",
      outboundModel: "claude-opus-4-7",
      inputTokens: 1_000_000,
      outputTokens: 200_000,
      cost: 30,
      streamed: false,
      httpStatus: 200,
      errorMessage: null,
      ...overrides,
    };
  }

  it("returns suggestions and exit 0 for a valid agent (no history → null estimates)", async () => {
    const { result, out } = await captureStdout(() =>
      recommendCmd({ json: true, agent: "claude-code" }),
    );
    expect(result).toBe(0);
    const data = JSON.parse(out).data;
    expect(data.suggestions.length).toBeGreaterThan(0);
    for (const s of data.suggestions) {
      expect(s.estimatedSpendDay).toBeNull();
      expect(typeof s.applyCommand).toBe("string");
    }
  });

  it("populates estimatedSpendDay when runs exist", async () => {
    // Seed 7 days of runs at 1M+200K tokens/day = $30/day on opus
    for (let i = 0; i < 7; i++) {
      await appendRun(
        record({
          runId: `r${i}`,
          startedAt: new Date(Date.now() - (i + 1) * 60_000).toISOString(),
          endedAt: new Date(Date.now() - (i + 1) * 60_000 + 10_000).toISOString(),
        }),
      );
    }
    const { out } = await captureStdout(() =>
      recommendCmd({
        json: true,
        agent: "claude-code",
        budgetDay: 5,
        preference: "quality",
      }),
    );
    const data = JSON.parse(out).data;
    const purePremium = data.suggestions[0];
    expect(purePremium.estimatedSpendDay).toBeGreaterThan(0);
  });

  it("rejects unknown agent with E_AGENT_NOT_FOUND", async () => {
    const { result, out } = await captureStdout(() =>
      recommendCmd({ json: true, agent: "nope" }),
    );
    expect(result).toBe(1);
    expect(JSON.parse(out).error.code).toBe("E_AGENT_NOT_FOUND");
  });

  it("rejects bogus --preference with E_INVALID_ARG", async () => {
    const { result, out } = await captureStdout(() =>
      recommendCmd({ json: true, agent: "claude-code", preference: "weird" }),
    );
    expect(result).toBe(1);
    expect(JSON.parse(out).error.code).toBe("E_INVALID_ARG");
  });
});
