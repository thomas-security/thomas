import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { policySet, policyShow } from "../src/commands/policy.js";
import { isRetryableStatus, shouldFailover } from "../src/policy/failover.js";
import { getPolicy, setPolicy } from "../src/policy/store.js";
import type { CostCascadePolicy } from "../src/policy/types.js";
import { captureStdout } from "./_util.js";

describe("isRetryableStatus", () => {
  it("returns true for network failures (status 0)", () => {
    expect(isRetryableStatus(0)).toBe(true);
  });

  it("returns true for 408, 429, and 5xx", () => {
    expect(isRetryableStatus(408)).toBe(true);
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(502)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(504)).toBe(true);
  });

  it("returns false for 2xx, 3xx, and non-retryable 4xx", () => {
    expect(isRetryableStatus(200)).toBe(false);
    expect(isRetryableStatus(201)).toBe(false);
    expect(isRetryableStatus(301)).toBe(false);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
    expect(isRetryableStatus(403)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
  });
});

describe("shouldFailover", () => {
  const POLICY_WITH: CostCascadePolicy = {
    id: "cost-cascade",
    primary: { provider: "anthropic", model: "claude-opus-4-7" },
    cascade: [],
    failoverTo: { provider: "openrouter", model: "anthropic/claude-opus-4" },
  };
  const POLICY_WITHOUT: CostCascadePolicy = {
    id: "cost-cascade",
    primary: { provider: "anthropic", model: "claude-opus-4-7" },
    cascade: [],
  };

  it("returns yes:false when no policy configured", () => {
    expect(shouldFailover(503, undefined)).toEqual({ yes: false });
  });

  it("returns yes:false when policy has no failoverTo", () => {
    expect(shouldFailover(503, POLICY_WITHOUT)).toEqual({ yes: false });
  });

  it("returns yes:false on non-retryable status even when failoverTo is set", () => {
    expect(shouldFailover(401, POLICY_WITH)).toEqual({ yes: false });
    expect(shouldFailover(200, POLICY_WITH)).toEqual({ yes: false });
  });

  it("returns yes:true with the configured target on retryable status", () => {
    const result = shouldFailover(503, POLICY_WITH);
    expect(result.yes).toBe(true);
    if (result.yes) {
      expect(result.target).toEqual({ provider: "openrouter", model: "anthropic/claude-opus-4" });
    }
  });
});

describe("policy set --failover-to (--json)", () => {
  let dir: string;
  const ORIG = process.env.THOMAS_HOME;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "thomas-failover-"));
    process.env.THOMAS_HOME = dir;
  });

  afterEach(async () => {
    if (ORIG !== undefined) process.env.THOMAS_HOME = ORIG;
    else delete process.env.THOMAS_HOME;
    await rm(dir, { recursive: true, force: true });
  });

  it("stores failoverTo and round-trips it through readPolicies", async () => {
    const { result, out } = await captureStdout(() =>
      policySet({
        json: true,
        agentId: "claude-code",
        primary: "anthropic/claude-opus-4-7",
        cascade: [],
        failoverTo: "openrouter/anthropic/claude-opus-4",
      }),
    );
    expect(result).toBe(0);
    const data = JSON.parse(out).data;
    expect(data.policy.failoverTo).toEqual({
      provider: "openrouter",
      model: "anthropic/claude-opus-4",
    });
    const stored = await getPolicy("claude-code");
    expect(stored?.failoverTo).toEqual({
      provider: "openrouter",
      model: "anthropic/claude-opus-4",
    });
  });

  it("omits failoverTo when not given", async () => {
    const { out } = await captureStdout(() =>
      policySet({
        json: true,
        agentId: "claude-code",
        primary: "anthropic/claude-opus-4-7",
        cascade: [],
      }),
    );
    const data = JSON.parse(out).data;
    expect(data.policy.failoverTo).toBeNull();
    const stored = await getPolicy("claude-code");
    expect(stored?.failoverTo).toBeUndefined();
  });

  it("rejects bad failover-to spec with E_INVALID_ARG", async () => {
    const { result, out } = await captureStdout(() =>
      policySet({
        json: true,
        agentId: "claude-code",
        primary: "anthropic/claude-opus-4-7",
        cascade: [],
        failoverTo: "missingslash",
      }),
    );
    expect(result).toBe(1);
    expect(JSON.parse(out).error.code).toBe("E_INVALID_ARG");
  });

  it("policy show surfaces failoverTo in the snapshot", async () => {
    await setPolicy("claude-code", {
      id: "cost-cascade",
      primary: { provider: "anthropic", model: "claude-opus-4-7" },
      cascade: [],
      failoverTo: { provider: "openrouter", model: "anthropic/claude-opus-4" },
    });
    const { out } = await captureStdout(() => policyShow({ json: true }));
    const snap = JSON.parse(out).data.policies[0];
    expect(snap.failoverTo).toEqual({
      provider: "openrouter",
      model: "anthropic/claude-opus-4",
    });
  });
});
