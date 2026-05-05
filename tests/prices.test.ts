import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pricesSet, pricesShow, pricesUnset } from "../src/commands/prices.js";
import { computeCost, listAllPrices } from "../src/runs/pricing.js";
import {
  priceKey,
  readOverlay,
  removeOverlayPrice,
  setOverlayPrice,
} from "../src/runs/prices-store.js";
import { captureStdout } from "./_util.js";

let dir: string;
const ORIG = process.env.THOMAS_HOME;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "thomas-prices-"));
  process.env.THOMAS_HOME = dir;
});

afterEach(async () => {
  if (ORIG !== undefined) process.env.THOMAS_HOME = ORIG;
  else delete process.env.THOMAS_HOME;
  await rm(dir, { recursive: true, force: true });
});

describe("prices store", () => {
  it("returns empty overlay when file missing", async () => {
    expect((await readOverlay()).prices).toEqual({});
  });

  it("set + read round-trips a price", async () => {
    const result = await setOverlayPrice("openrouter/x", { input: 1.23, output: 4.56 });
    expect(result.replacedExisting).toBe(false);
    expect((await readOverlay()).prices["openrouter/x"]).toEqual({ input: 1.23, output: 4.56 });
  });

  it("set returns replacedExisting=true on second set", async () => {
    await setOverlayPrice("openrouter/x", { input: 1, output: 2 });
    const r = await setOverlayPrice("openrouter/x", { input: 9, output: 9 });
    expect(r.replacedExisting).toBe(true);
  });

  it("remove returns true when present, false when absent", async () => {
    await setOverlayPrice("openrouter/x", { input: 1, output: 2 });
    expect(await removeOverlayPrice("openrouter/x")).toBe(true);
    expect(await removeOverlayPrice("openrouter/x")).toBe(false);
  });
});

describe("computeCost with overlay", () => {
  it("returns null for an unknown model when no overlay", async () => {
    expect(await computeCost("openrouter", "fake/model", 1000, 1000)).toBeNull();
  });

  it("reads overlay price for an unknown model", async () => {
    await setOverlayPrice("openrouter/fake/model", { input: 2.0, output: 8.0 });
    // 1M input × $2 + 1M output × $8 / 1M = $10
    expect(await computeCost("openrouter", "fake/model", 1_000_000, 1_000_000)).toBeCloseTo(
      10,
      4,
    );
  });

  it("overlay overrides builtin pricing", async () => {
    // builtin opus is $15 in / $75 out — 1M+1M = $90
    expect(
      await computeCost("anthropic", "claude-opus-4-7", 1_000_000, 1_000_000),
    ).toBeCloseTo(90, 4);
    // overlay: 1.0 / 2.0
    await setOverlayPrice(priceKey("anthropic", "claude-opus-4-7"), {
      input: 1.0,
      output: 2.0,
    });
    expect(
      await computeCost("anthropic", "claude-opus-4-7", 1_000_000, 1_000_000),
    ).toBeCloseTo(3, 4);
  });

  it("falls back to builtin after overlay is removed", async () => {
    await setOverlayPrice(priceKey("anthropic", "claude-opus-4-7"), { input: 1, output: 2 });
    await removeOverlayPrice(priceKey("anthropic", "claude-opus-4-7"));
    expect(
      await computeCost("anthropic", "claude-opus-4-7", 1_000_000, 1_000_000),
    ).toBeCloseTo(90, 4);
  });
});

describe("listAllPrices", () => {
  it("includes all builtins by default", async () => {
    const all = await listAllPrices();
    expect(all.length).toBeGreaterThan(5);
    const opus = all.find((e) => e.provider === "anthropic" && e.model === "claude-opus-4-7");
    expect(opus?.source).toBe("builtin");
    expect(opus?.tier).toBe("premium");
  });

  it("marks builtins as overlay when overridden, preserving the original tier", async () => {
    await setOverlayPrice(priceKey("anthropic", "claude-opus-4-7"), {
      input: 0.5,
      output: 1.0,
    });
    const all = await listAllPrices();
    const opus = all.find((e) => e.provider === "anthropic" && e.model === "claude-opus-4-7");
    expect(opus?.source).toBe("overlay");
    expect(opus?.tier).toBe("premium"); // builtin tier preserved
    expect(opus?.pricePerMillion).toEqual({ input: 0.5, output: 1.0 });
  });

  it("includes overlay-only entries with tier=null", async () => {
    await setOverlayPrice("openrouter/some/model", { input: 1, output: 2 });
    const all = await listAllPrices();
    const entry = all.find(
      (e) => e.provider === "openrouter" && e.model === "some/model",
    );
    expect(entry?.source).toBe("overlay");
    expect(entry?.tier).toBeNull();
  });
});

describe("thomas prices commands (--json)", () => {
  it("show returns all builtins for a fresh thomas-home", async () => {
    const { result, out } = await captureStdout(() => pricesShow({ json: true }));
    expect(result).toBe(0);
    const data = JSON.parse(out).data;
    expect(data.prices.length).toBeGreaterThan(5);
    expect(data.prices.every((e: { source: string }) => e.source === "builtin")).toBe(true);
  });

  it("set adds an overlay entry with overridesBuiltin=false for unknown model", async () => {
    const { result, out } = await captureStdout(() =>
      pricesSet({
        json: true,
        modelSpec: "openrouter/fake/foo",
        inputUsd: 1.5,
        outputUsd: 3.0,
      }),
    );
    expect(result).toBe(0);
    const data = JSON.parse(out).data;
    expect(data).toEqual({
      provider: "openrouter",
      model: "fake/foo",
      pricePerMillion: { input: 1.5, output: 3.0 },
      protocol: null,
      tier: null,
      replacedExisting: false,
      overridesBuiltin: false,
    });
  });

  it("set flags overridesBuiltin=true when key exists in builtins", async () => {
    const { out } = await captureStdout(() =>
      pricesSet({
        json: true,
        modelSpec: "anthropic/claude-opus-4-7",
        inputUsd: 1.0,
        outputUsd: 2.0,
      }),
    );
    expect(JSON.parse(out).data.overridesBuiltin).toBe(true);
  });

  it("set rejects bad provider/model", async () => {
    const { result, out } = await captureStdout(() =>
      pricesSet({ json: true, modelSpec: "noslash", inputUsd: 1, outputUsd: 1 }),
    );
    expect(result).toBe(1);
    expect(JSON.parse(out).error.code).toBe("E_INVALID_ARG");
  });

  it("set rejects negative price", async () => {
    const { result, out } = await captureStdout(() =>
      pricesSet({ json: true, modelSpec: "x/y", inputUsd: -1, outputUsd: 1 }),
    );
    expect(result).toBe(1);
    expect(JSON.parse(out).error.code).toBe("E_INVALID_ARG");
  });

  it("unset removes an overlay entry", async () => {
    await setOverlayPrice("openrouter/x", { input: 1, output: 2 });
    const { result, out } = await captureStdout(() =>
      pricesUnset("openrouter/x", { json: true }),
    );
    expect(result).toBe(0);
    expect(JSON.parse(out).data).toEqual({
      provider: "openrouter",
      model: "x",
      removed: true,
    });
  });

  it("set with --tier and --protocol records the metadata in overlay", async () => {
    const { result, out } = await captureStdout(() =>
      pricesSet({
        json: true,
        modelSpec: "openrouter/super-opus",
        inputUsd: 0.01,
        outputUsd: 0.01,
        protocol: "anthropic",
        tier: "premium",
      }),
    );
    expect(result).toBe(0);
    const data = JSON.parse(out).data;
    expect(data.protocol).toBe("anthropic");
    expect(data.tier).toBe("premium");
    const overlay = await readOverlay();
    expect(overlay.prices["openrouter/super-opus"]).toEqual({
      input: 0.01,
      output: 0.01,
      protocol: "anthropic",
      tier: "premium",
    });
  });

  it("set rejects bogus --protocol", async () => {
    const { result, out } = await captureStdout(() =>
      pricesSet({
        json: true,
        modelSpec: "x/y",
        inputUsd: 1,
        outputUsd: 1,
        protocol: "weird",
      }),
    );
    expect(result).toBe(1);
    expect(JSON.parse(out).error.code).toBe("E_INVALID_ARG");
  });

  it("set rejects bogus --tier", async () => {
    const { result, out } = await captureStdout(() =>
      pricesSet({
        json: true,
        modelSpec: "x/y",
        inputUsd: 1,
        outputUsd: 1,
        tier: "elite",
      }),
    );
    expect(result).toBe(1);
    expect(JSON.parse(out).error.code).toBe("E_INVALID_ARG");
  });

  it("unset returns removed=false (exit 0) for absent entry; builtins are not removable", async () => {
    const { result, out } = await captureStdout(() =>
      pricesUnset("anthropic/claude-opus-4-7", { json: true }),
    );
    expect(result).toBe(0);
    expect(JSON.parse(out).data.removed).toBe(false);
    // builtin still computes cost via fallback
    expect(
      await computeCost("anthropic", "claude-opus-4-7", 1_000_000, 1_000_000),
    ).toBeCloseTo(90, 4);
  });
});
