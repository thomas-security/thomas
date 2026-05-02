import { describe, expect, it } from "bun:test";
import { renderEnvBlock } from "../src/shim/install.js";

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
