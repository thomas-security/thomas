import { describe, expect, it } from "bun:test";
import { ensureOpenAIIncludeUsage } from "../src/proxy/usage-injection.js";

describe("ensureOpenAIIncludeUsage", () => {
  it("injects stream_options.include_usage=true on streaming bodies missing it", () => {
    const body = JSON.stringify({ model: "gpt-4o", stream: true, messages: [] });
    const out = ensureOpenAIIncludeUsage(body);
    const parsed = JSON.parse(out);
    expect(parsed.stream_options).toEqual({ include_usage: true });
  });

  it("preserves other stream_options keys when injecting", () => {
    const body = JSON.stringify({
      model: "gpt-4o",
      stream: true,
      stream_options: { other_flag: "x" },
    });
    const parsed = JSON.parse(ensureOpenAIIncludeUsage(body));
    expect(parsed.stream_options).toEqual({ other_flag: "x", include_usage: true });
  });

  it("respects explicit include_usage=true (no double-write)", () => {
    const body = JSON.stringify({
      model: "gpt-4o",
      stream: true,
      stream_options: { include_usage: true },
    });
    const out = ensureOpenAIIncludeUsage(body);
    expect(JSON.parse(out).stream_options.include_usage).toBe(true);
    // body should be byte-identical (no rewrite)
    expect(out).toBe(body);
  });

  it("respects explicit include_usage=false (does not override)", () => {
    const body = JSON.stringify({
      model: "gpt-4o",
      stream: true,
      stream_options: { include_usage: false },
    });
    const out = ensureOpenAIIncludeUsage(body);
    expect(JSON.parse(out).stream_options.include_usage).toBe(false);
    expect(out).toBe(body);
  });

  it("does nothing for non-streaming bodies (stream missing or false)", () => {
    const a = JSON.stringify({ model: "gpt-4o", messages: [] });
    expect(ensureOpenAIIncludeUsage(a)).toBe(a);
    const b = JSON.stringify({ model: "gpt-4o", stream: false, messages: [] });
    expect(ensureOpenAIIncludeUsage(b)).toBe(b);
  });

  it("returns body unchanged when JSON parse fails", () => {
    expect(ensureOpenAIIncludeUsage("{not json")).toBe("{not json");
  });

  it("returns body unchanged for empty/null input", () => {
    expect(ensureOpenAIIncludeUsage("")).toBe("");
  });

  it("returns body unchanged when parsed value is not an object", () => {
    expect(ensureOpenAIIncludeUsage("true")).toBe("true");
    expect(ensureOpenAIIncludeUsage("[]")).toBe("[]");
  });
});
