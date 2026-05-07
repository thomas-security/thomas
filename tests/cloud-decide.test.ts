// PR6: decide() consults cloud-cache before local store.
//
// Three angles covered:
//   1. cloud cache binding kind=static  → static target wins (no cascade)
//   2. cloud cache binding kind=policy  → cascade evaluated against today's spend
//   3. cloud cache binding kind=bundle  → highest-priority leg used (v1 stub)
// Plus the fallback paths:
//   4. cache present but no binding for this agent → falls through to local store
//   5. cache absent (no cloud login)               → falls through to local store
//   6. cache present + local store empty + no binding → fallbackTarget wins
// Plus referential-integrity oddities:
//   7. binding kind=policy with disabled policy   → falls through (not used)
//   8. binding kind=bundle with empty legs        → falls through

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeCache } from "../src/cloud/cache.js";
import type { CloudSnapshot } from "../src/cloud/types.js";
import { windowStart } from "../src/metering/types.js";
import { decideForAgent } from "../src/policy/decide.js";
import { setPolicy } from "../src/policy/store.js";
import type { PolicyConfig } from "../src/policy/types.js";
import { appendRun } from "../src/runs/store.js";

let dir: string;
const ORIG_THOMAS_HOME = process.env.THOMAS_HOME;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "thomas-cloud-decide-"));
  process.env.THOMAS_HOME = dir;
});

afterEach(async () => {
  if (ORIG_THOMAS_HOME !== undefined) process.env.THOMAS_HOME = ORIG_THOMAS_HOME;
  else delete process.env.THOMAS_HOME;
  await rm(dir, { recursive: true, force: true });
});

const FALLBACK = { provider: "anthropic", model: "claude-haiku-4-5" };

function snapshot(partial: Partial<CloudSnapshot>): CloudSnapshot {
  return {
    schemaVersion: 1,
    policies: [],
    bundles: [],
    bindings: [],
    providers: [],
    redactRulesVersion: null,
    syncedAt: new Date().toISOString(),
    ...partial,
  };
}

describe("decideForAgent — cloud cache integration", () => {
  it("uses cloud static binding ahead of local policy and route fallback", async () => {
    // Local also has a policy for this agent — cloud must override.
    const localPolicy: PolicyConfig = {
      id: "cost-cascade",
      primary: { provider: "openai", model: "gpt-4o" },
      cascade: [],
    };
    await setPolicy("claude-code", localPolicy);

    await writeCache(
      snapshot({
        bindings: [
          {
            agentId: "claude-code",
            bindingKind: "static",
            staticTarget: { providerId: "anthropic", model: "claude-opus-4-7" },
          },
        ],
      }) as unknown as CloudSnapshot,
    );

    const decision = await decideForAgent("claude-code", FALLBACK);
    expect(decision.target).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-7",
    });
    expect(decision.source).toBe("cloud");
    expect(decision.policy?.cascade).toEqual([]);
  });

  it("applies cloud policy cascade based on today's spend", async () => {
    await writeCache(
      snapshot({
        policies: [
          {
            id: "01POLICY_ULID00000000000000",
            name: "Opus then Haiku",
            enabled: true,
            spec: {
              schemaVersion: 1,
              primary: { providerId: "anthropic", model: "claude-opus-4-7" },
              cascade: [
                {
                  triggerSpendDayUsd: 5.0,
                  fallback: {
                    providerId: "anthropic",
                    model: "claude-haiku-4-5",
                  },
                },
              ],
            },
          },
        ],
        bindings: [
          {
            agentId: "claude-code",
            bindingKind: "policy",
            targetId: "01POLICY_ULID00000000000000",
          },
        ],
      }) as unknown as CloudSnapshot,
    );

    // No spend → primary
    const cold = await decideForAgent("claude-code", FALLBACK);
    expect(cold.target.model).toBe("claude-opus-4-7");
    expect(cold.source).toBe("cloud");
  });

  it("applies cloud policy count-cascade based on today's call count", async () => {
    await writeCache(
      snapshot({
        policies: [
          {
            id: "01POLICY_CALLS_ULID000000000",
            name: "GPT then xiangxin after 2 calls",
            enabled: true,
            spec: {
              schemaVersion: 1,
              primary: { providerId: "openai", model: "gpt-5.5" },
              cascade: [
                {
                  triggerCallsDay: 2,
                  fallback: { providerId: "vllm", model: "xiangxin-2xl-chat" },
                },
              ],
            },
          },
        ],
        bindings: [
          {
            agentId: "openclaw",
            bindingKind: "policy",
            targetId: "01POLICY_CALLS_ULID000000000",
          },
        ],
      }) as unknown as CloudSnapshot,
    );

    const today = windowStart("day");
    const stamp = (offsetSec: number) =>
      new Date(today.getTime() + offsetSec * 1000).toISOString();

    // 0 calls → primary
    const cold = await decideForAgent("openclaw", FALLBACK);
    expect(cold.target.model).toBe("gpt-5.5");
    expect(cold.source).toBe("cloud");

    // After 2 calls (no cost recorded — sub-style), cascade fires
    for (const id of ["a", "b"]) {
      await appendRun({
        runId: id,
        agent: "openclaw",
        startedAt: stamp(60),
        endedAt: stamp(60),
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
        failovers: 0,
        failoverNote: null,
      });
    }
    const hot = await decideForAgent("openclaw", FALLBACK);
    expect(hot.target).toEqual({ provider: "vllm", model: "xiangxin-2xl-chat" });
    expect(hot.reason).toContain("calls 2/day");
  });

  it("falls back to local policy when cloud cache has no binding for this agent", async () => {
    await writeCache(
      snapshot({
        bindings: [
          {
            agentId: "codex",
            bindingKind: "static",
            staticTarget: { providerId: "openai", model: "gpt-4o" },
          },
        ],
      }) as unknown as CloudSnapshot,
    );
    const localPolicy: PolicyConfig = {
      id: "cost-cascade",
      primary: { provider: "kimi", model: "kimi-k2" },
      cascade: [],
    };
    await setPolicy("claude-code", localPolicy);

    const decision = await decideForAgent("claude-code", FALLBACK);
    expect(decision.target).toEqual({ provider: "kimi", model: "kimi-k2" });
    expect(decision.source).toBe("local");
  });

  it("falls back to fallbackTarget when neither cloud nor local has anything", async () => {
    // No cache, no local policy — pure fallback path (existing behavior).
    const decision = await decideForAgent("claude-code", FALLBACK);
    expect(decision.target).toEqual(FALLBACK);
    expect(decision.source).toBe("none");
    expect(decision.policy).toBeNull();
  });

  it("ignores disabled cloud policies + falls through to local", async () => {
    const localPolicy: PolicyConfig = {
      id: "cost-cascade",
      primary: { provider: "kimi", model: "kimi-k2" },
      cascade: [],
    };
    await setPolicy("claude-code", localPolicy);

    await writeCache(
      snapshot({
        policies: [
          {
            id: "01POLICY",
            name: "disabled",
            enabled: false,  // <-- key bit
            spec: {
              schemaVersion: 1,
              primary: { providerId: "anthropic", model: "claude-opus-4-7" },
              cascade: [],
            },
          },
        ],
        bindings: [
          {
            agentId: "claude-code",
            bindingKind: "policy",
            targetId: "01POLICY",
          },
        ],
      }) as unknown as CloudSnapshot,
    );

    const decision = await decideForAgent("claude-code", FALLBACK);
    expect(decision.source).toBe("local");
    expect(decision.target.provider).toBe("kimi");
  });

  it("uses highest-priority leg for bundle bindings (v1 stub)", async () => {
    await writeCache(
      snapshot({
        bundles: [
          {
            id: "01BUNDLE",
            name: "openai then deepseek",
            enabled: true,
            spec: {
              schemaVersion: 1,
              legs: [
                // priority 0 (head) — used by the v1 stub
                { providerId: "openai", model: "gpt-4o", priority: 0, capUsdPerDay: 5 },
                { providerId: "deepseek", model: "deepseek-chat", priority: 1, capUsdPerDay: 5 },
              ],
            },
          },
        ],
        bindings: [
          {
            agentId: "claude-code",
            bindingKind: "bundle",
            targetId: "01BUNDLE",
          },
        ],
      }) as unknown as CloudSnapshot,
    );

    const decision = await decideForAgent("claude-code", FALLBACK);
    expect(decision.target).toEqual({ provider: "openai", model: "gpt-4o" });
    expect(decision.source).toBe("cloud");
  });

  it("ignores bundle bindings whose target bundle is missing", async () => {
    await setPolicy("claude-code", {
      id: "cost-cascade",
      primary: { provider: "kimi", model: "kimi-k2" },
      cascade: [],
    });
    await writeCache(
      snapshot({
        bundles: [],  // empty — binding refers to nonexistent bundle
        bindings: [
          {
            agentId: "claude-code",
            bindingKind: "bundle",
            targetId: "01MISSING",
          },
        ],
      }) as unknown as CloudSnapshot,
    );
    const decision = await decideForAgent("claude-code", FALLBACK);
    expect(decision.source).toBe("local");
  });
});
