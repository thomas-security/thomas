import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { policyClear, policySet, policyShow } from "../src/commands/policy.js";
import type { Usage } from "../src/metering/types.js";
import { windowStart } from "../src/metering/types.js";
import { decide } from "../src/policy/decide.js";
import { getPolicy, readPolicies, setPolicy } from "../src/policy/store.js";
import type { CostCascadePolicy } from "../src/policy/types.js";
import { appendRun } from "../src/runs/store.js";
import { captureStdout } from "./_util.js";

function usage(overrides: Partial<Usage> = {}): Usage {
  return { calls: 0, inputTokens: 0, outputTokens: 0, spend: 0, ...overrides };
}

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
  it("returns primary when usage below all triggers", () => {
    const d = decide(POLICY, usage({ spend: 0 }));
    expect(d.target).toEqual({ provider: "anthropic", model: "claude-opus-4-7" });
    expect(d.policyId).toBe("cost-cascade");
  });

  it("returns first matching cascade rule by ascending trigger order", () => {
    const d = decide(POLICY, usage({ spend: 7 }));
    expect(d.target).toEqual({ provider: "anthropic", model: "claude-haiku-4-5" });
  });

  it("first matching rule wins even when later rules also match", () => {
    const d = decide(POLICY, usage({ spend: 12 }));
    // Cascade is sorted ascending by trigger; first hit (≥5) wins → haiku, not deepseek.
    expect(d.target.provider).toBe("anthropic");
    expect(d.target.model).toBe("claude-haiku-4-5");
  });

  it("trigger of exactly the threshold counts as a hit", () => {
    expect(decide(POLICY, usage({ spend: 5 })).target.model).toBe("claude-haiku-4-5");
    expect(decide(POLICY, usage({ spend: 4.999 })).target.model).toBe("claude-opus-4-7");
  });

  it("policy with empty cascade always returns primary", () => {
    const empty: CostCascadePolicy = {
      id: "cost-cascade",
      primary: POLICY.primary,
      cascade: [],
    };
    expect(decide(empty, usage({ spend: 9999 })).target).toEqual(POLICY.primary);
  });

  it("triggerCallsDay rule fires when calls reaches threshold", () => {
    const policy: CostCascadePolicy = {
      id: "cost-cascade",
      primary: { provider: "openai", model: "gpt-5.5" },
      cascade: [
        {
          triggerCallsDay: 2,
          fallback: { provider: "vllm", model: "xiangxin-2xl-chat" },
        },
      ],
    };
    expect(decide(policy, usage({ calls: 1 })).target.model).toBe("gpt-5.5");
    expect(decide(policy, usage({ calls: 2 })).target.model).toBe("xiangxin-2xl-chat");
    expect(decide(policy, usage({ calls: 99 })).target.model).toBe("xiangxin-2xl-chat");
  });

  it("spend rule is inert when usage.spend is null; calls rule still fires", () => {
    const policy: CostCascadePolicy = {
      id: "cost-cascade",
      primary: { provider: "openai", model: "gpt-5.5" },
      cascade: [
        // spend rule comes first; with spend null it must skip, not throw
        { triggerSpendDay: 5, fallback: { provider: "deepseek", model: "deepseek-chat" } },
        { triggerCallsDay: 3, fallback: { provider: "vllm", model: "xiangxin-2xl-chat" } },
      ],
    };
    const d = decide(policy, { calls: 4, inputTokens: 0, outputTokens: 0, spend: null });
    expect(d.target.model).toBe("xiangxin-2xl-chat");
    expect(d.reason).toContain("calls 4/day");
  });

  it("primary-reason mentions both spend and calls when present", () => {
    const d = decide(POLICY, usage({ spend: 1.23, calls: 4 }));
    expect(d.reason).toContain("$1.2300/day");
    expect(d.reason).toContain("calls 4/day");
  });
});

// (Spend / call aggregation behavior covered in tests/metering.test.ts.)

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

  it("show populates currentSpendDay + currentCallsDay + currentEffective from runs", async () => {
    await setPolicy("claude-code", POLICY);
    const today = windowStart("day");
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
    expect(snap.currentCallsDay).toBe(1);
    // 7 ≥ first trigger (5), so cascades to haiku
    expect(snap.currentEffective).toEqual({ provider: "anthropic", model: "claude-haiku-4-5" });
    expect(snap.currentReason).toContain("≥ trigger");
  });

  it("set --at-calls stores a count-trigger rule and decide() switches at threshold", async () => {
    const { result, out } = await captureStdout(() =>
      policySet({
        json: true,
        agentId: "openclaw",
        primary: "openai/gpt-5.5",
        cascade: [],
        cascadeCalls: ["2=vllm/xiangxin-2xl-chat"],
      }),
    );
    expect(result).toBe(0);
    const data = JSON.parse(out).data;
    expect(data.policy.cascade).toEqual([
      {
        triggerSpendDay: null,
        triggerCallsDay: 2,
        fallback: { provider: "vllm", model: "xiangxin-2xl-chat" },
      },
    ]);

    // Add 2 runs → cascade fires
    const today = windowStart("day");
    for (const id of ["a", "b"]) {
      await appendRun({
        runId: id,
        agent: "openclaw",
        startedAt: new Date(today.getTime() + 60_000).toISOString(),
        endedAt: new Date(today.getTime() + 60_000).toISOString(),
        durationMs: 0,
        status: "ok",
        inboundProtocol: "openai",
        outboundProvider: "openai",
        outboundModel: "gpt-5.5",
        inputTokens: 0,
        outputTokens: 0,
        cost: null,
        streamed: false,
        httpStatus: 200,
        errorMessage: null,
      });
    }
    const { out: showOut } = await captureStdout(() => policyShow({ json: true }));
    const snap = JSON.parse(showOut).data.policies[0];
    expect(snap.currentCallsDay).toBe(2);
    expect(snap.currentEffective).toEqual({ provider: "vllm", model: "xiangxin-2xl-chat" });
    expect(snap.currentReason).toContain("calls 2/day");
  });

  it("set --at-calls rejects non-positive integer triggers", async () => {
    const { result, out } = await captureStdout(() =>
      policySet({
        json: true,
        agentId: "openclaw",
        primary: "openai/gpt-5.5",
        cascade: [],
        cascadeCalls: ["0=vllm/xiangxin-2xl-chat"],
      }),
    );
    expect(result).toBe(1);
    expect(JSON.parse(out).error.code).toBe("E_INVALID_ARG");
  });
});
