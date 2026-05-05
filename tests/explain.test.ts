import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { explain } from "../src/commands/explain.js";
import { recordConnect } from "../src/config/agents.js";
import { setRoute } from "../src/config/routes.js";
import { startOfTodayUTC } from "../src/policy/decide.js";
import { setPolicy } from "../src/policy/store.js";
import { appendRun } from "../src/runs/store.js";
import type { RunRecord } from "../src/runs/types.js";
import { captureStdout } from "./_util.js";

let dir: string;
const ORIG = process.env.THOMAS_HOME;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "thomas-explain-"));
  process.env.THOMAS_HOME = dir;
});

afterEach(async () => {
  if (ORIG !== undefined) process.env.THOMAS_HOME = ORIG;
  else delete process.env.THOMAS_HOME;
  await rm(dir, { recursive: true, force: true });
});

function record(overrides: Partial<RunRecord>): RunRecord {
  // spread defaults then overrides — preserves explicit `null`/`0` values that ?? would clobber
  return {
    runId: "abcdef01-2345-6789-abcd-ef0123456789",
    agent: "claude-code",
    startedAt: "2026-05-04T10:00:00.000Z",
    endedAt: "2026-05-04T10:00:01.500Z",
    durationMs: 1500,
    status: "ok",
    inboundProtocol: "anthropic",
    outboundProvider: "anthropic",
    outboundModel: "claude-opus-4-7",
    inputTokens: 1000,
    outputTokens: 500,
    cost: 0.0525,
    streamed: false,
    httpStatus: 200,
    errorMessage: null,
    ...overrides,
  };
}

describe("explain --run", () => {
  it("narrates an OK run with cost + tokens + duration", async () => {
    await appendRun(record({}));
    const { result, out } = await captureStdout(() =>
      explain({ json: true, runId: "abcdef01" }),
    );
    expect(result).toBe(0);
    const data = JSON.parse(out).data;
    expect(data.subject).toEqual({ type: "run", id: "abcdef01-2345-6789-abcd-ef0123456789" });
    expect(data.narrative).toContain("anthropic/claude-opus-4-7");
    expect(data.narrative).toContain("1000 in / 500 out");
    expect(data.narrative).toContain("$0.052500");
    expect(data.facts.find((f: { kind: string }) => f.kind === "route")).toBeTruthy();
    expect(data.facts.find((f: { kind: string }) => f.kind === "cost")).toBeTruthy();
  });

  it("flags an error run with httpStatus + errorMessage", async () => {
    await appendRun(
      record({
        runId: "11111111-2222-3333-4444-555555555555",
        status: "error",
        httpStatus: 401,
        errorMessage: "upstream 401",
      }),
    );
    const { out } = await captureStdout(() => explain({ json: true, runId: "11111111" }));
    const data = JSON.parse(out).data;
    expect(data.narrative).toContain("FAILED");
    expect(data.narrative).toContain("upstream 401");
    expect(data.facts.some((f: { kind: string }) => f.kind === "error")).toBe(true);
  });

  it("notes 'cost unknown' when no price was available", async () => {
    await appendRun(
      record({
        runId: "77777777-8888-9999-aaaa-bbbbbbbbbbbb",
        outboundProvider: "openrouter",
        outboundModel: "fake/model",
        cost: null,
      }),
    );
    const { out } = await captureStdout(() => explain({ json: true, runId: "77777777" }));
    const data = JSON.parse(out).data;
    expect(data.narrative).toContain("cost unknown");
    const cost = data.facts.find((f: { kind: string }) => f.kind === "cost");
    expect(cost.detail).toContain("cost unknown");
  });

  it("matches by short prefix", async () => {
    await appendRun(record({ runId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }));
    const { result } = await captureStdout(() => explain({ json: true, runId: "aaaaaaaa" }));
    expect(result).toBe(0);
  });

  it("returns E_INVALID_ARG when runId not found", async () => {
    const { result, out } = await captureStdout(() =>
      explain({ json: true, runId: "nonexistent" }),
    );
    expect(result).toBe(1);
    expect(JSON.parse(out).error.code).toBe("E_INVALID_ARG");
  });
});

describe("explain --agent", () => {
  it("explains an unconnected agent and suggests connect", async () => {
    const { result, out } = await captureStdout(() =>
      explain({ json: true, agentId: "claude-code" }),
    );
    expect(result).toBe(0);
    const data = JSON.parse(out).data;
    expect(data.narrative).toContain("not currently routed through thomas");
    expect(data.facts[0]).toEqual({ kind: "route", detail: "not connected", at: null });
  });

  it("explains a connected agent with route and policy", async () => {
    await recordConnect("claude-code", {
      shimPath: join(dir, "bin", "claude"),
      originalBinary: "/usr/bin/claude",
      connectedAt: new Date().toISOString(),
      token: "fake",
    });
    await setRoute("claude-code", { provider: "anthropic", model: "claude-opus-4-7" });
    await setPolicy("claude-code", {
      id: "cost-cascade",
      primary: { provider: "anthropic", model: "claude-opus-4-7" },
      cascade: [
        { triggerSpendDay: 5, fallback: { provider: "anthropic", model: "claude-haiku-4-5" } },
      ],
    });
    // simulate $7 spent today → cascade fires
    await appendRun(
      record({
        runId: "today-1",
        startedAt: new Date(startOfTodayUTC().getTime() + 60_000).toISOString(),
        endedAt: new Date(startOfTodayUTC().getTime() + 70_000).toISOString(),
        cost: 7.0,
      }),
    );

    const { out } = await captureStdout(() =>
      explain({ json: true, agentId: "claude-code" }),
    );
    const data = JSON.parse(out).data;
    expect(data.subject).toEqual({ type: "agent", id: "claude-code" });
    expect(data.narrative).toContain("cost-cascade policy");
    expect(data.narrative).toContain("anthropic/claude-haiku-4-5"); // post-cascade
    expect(data.narrative).toContain("$7.0000");
    const kinds = data.facts.map((f: { kind: string }) => f.kind);
    expect(kinds).toContain("route");
    expect(kinds).toContain("policy-applied");
    expect(kinds).toContain("cascade");
    expect(kinds).toContain("cost");
  });

  it("rejects unknown agent with E_AGENT_NOT_FOUND", async () => {
    const { result, out } = await captureStdout(() =>
      explain({ json: true, agentId: "nope" }),
    );
    expect(result).toBe(1);
    expect(JSON.parse(out).error.code).toBe("E_AGENT_NOT_FOUND");
  });
});

describe("explain (no argument)", () => {
  it("returns E_INVALID_ARG when neither --run nor --agent is given", async () => {
    const { result, out } = await captureStdout(() => explain({ json: true }));
    expect(result).toBe(1);
    expect(JSON.parse(out).error.code).toBe("E_INVALID_ARG");
  });
});
