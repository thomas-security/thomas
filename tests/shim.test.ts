import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { renderEnvBlock, verifyShimWins } from "../src/shim/install.js";

describe("renderEnvBlock", () => {
  const ctx = { thomasUrl: "http://127.0.0.1:51168", thomasToken: "thomas-tok-abc" };

  it("expands ${THOMAS_URL} and ${THOMAS_TOKEN} for sh", () => {
    const block = renderEnvBlock(
      {
        ANTHROPIC_BASE_URL: "${THOMAS_URL}",
        ANTHROPIC_API_KEY: "${THOMAS_TOKEN}",
      },
      ctx,
      "sh",
    );
    expect(block).toBe(
      "export ANTHROPIC_BASE_URL='http://127.0.0.1:51168'\nexport ANTHROPIC_API_KEY='thomas-tok-abc'",
    );
  });

  it("renders multiple vars including a literal value", () => {
    const block = renderEnvBlock(
      {
        HERMES_INFERENCE_PROVIDER: "openrouter",
        OPENROUTER_API_KEY: "${THOMAS_TOKEN}",
        OPENROUTER_BASE_URL: "${THOMAS_URL}/v1",
      },
      ctx,
      "sh",
    );
    expect(block).toBe(
      [
        "export HERMES_INFERENCE_PROVIDER='openrouter'",
        "export OPENROUTER_API_KEY='thomas-tok-abc'",
        "export OPENROUTER_BASE_URL='http://127.0.0.1:51168/v1'",
      ].join("\n"),
    );
  });

  it("escapes single quotes in values for sh", () => {
    const block = renderEnvBlock({ FOO: "ab'cd" }, ctx, "sh");
    expect(block).toBe(`export FOO='ab'\\''cd'`);
  });

  it("uses cmd-style quoting for windows", () => {
    const block = renderEnvBlock({ X: "${THOMAS_URL}/v1" }, ctx, "cmd");
    expect(block).toBe(`set "X=http://127.0.0.1:51168/v1"`);
  });

  it("escapes percent and double-quote for cmd", () => {
    const block = renderEnvBlock({ X: 'a"b%c' }, ctx, "cmd");
    expect(block).toBe(`set "X=a""b%%c"`);
  });

  it("returns empty string for empty env map", () => {
    expect(renderEnvBlock({}, ctx, "sh")).toBe("");
  });
});

describe("verifyShimWins", () => {
  let dir: string;
  const ORIG_THOMAS_HOME = process.env.THOMAS_HOME;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "thomas-shim-verify-"));
    process.env.THOMAS_HOME = dir;
  });

  afterEach(async () => {
    if (ORIG_THOMAS_HOME !== undefined) process.env.THOMAS_HOME = ORIG_THOMAS_HOME;
    else delete process.env.THOMAS_HOME;
    await rm(dir, { recursive: true, force: true });
  });

  const sep = process.platform === "win32" ? ";" : ":";
  const binDir = () => resolve(dir, "bin");

  it("ok when binDir is on PATH and the original binary's dir is not", () => {
    const fakeBin = "/some/where/else/openclaw";
    const v = verifyShimWins(fakeBin, { PATH: binDir() });
    expect(v.ok).toBe(true);
  });

  it("ok when binDir comes before originalBinary's dir on PATH", () => {
    const origDir = "/usr/local/bin";
    const v = verifyShimWins(`${origDir}/openclaw`, {
      PATH: [binDir(), origDir].join(sep),
    });
    expect(v.ok).toBe(true);
  });

  it("missing when PATH does not contain binDir", () => {
    const origDir = "/usr/local/bin";
    const v = verifyShimWins(`${origDir}/openclaw`, { PATH: origDir });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toBe("missing");
      expect(v.binDir).toBe(binDir());
      expect(v.originalDir).toBe(origDir);
    }
  });

  it("missing when PATH is empty", () => {
    const v = verifyShimWins("/usr/local/bin/openclaw", { PATH: "" });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("missing");
  });

  it("shadowed when binDir appears after originalBinary's dir on PATH", () => {
    const origDir = "/usr/local/bin";
    const v = verifyShimWins(`${origDir}/openclaw`, {
      PATH: [origDir, binDir()].join(sep),
    });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toBe("shadowed");
      expect(v.binDir).toBe(binDir());
      expect(v.originalDir).toBe(origDir);
    }
  });

  it("normalizes path entries (resolves ./ and trailing slashes)", () => {
    const v = verifyShimWins("/usr/local/bin/openclaw", {
      PATH: `${binDir()}/`,
    });
    expect(v.ok).toBe(true);
  });
});
