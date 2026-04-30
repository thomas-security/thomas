import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDotenv } from "../src/agents/dotenv.js";
import { hermes } from "../src/agents/hermes.js";

describe("parseDotenv", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "thomas-dotenv-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("parses simple KEY=VALUE", async () => {
    const path = join(dir, ".env");
    await writeFile(path, "FOO=bar\nBAZ=qux\n");
    expect(await parseDotenv(path)).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("ignores comments and blank lines", async () => {
    const path = join(dir, ".env");
    await writeFile(path, "# comment\n\nKEY=value\n  # indented comment\n");
    expect(await parseDotenv(path)).toEqual({ KEY: "value" });
  });

  it("handles export prefix and quoted values", async () => {
    const path = join(dir, ".env");
    await writeFile(
      path,
      `export DOUBLE="hello world"\nSINGLE='no \\n escapes'\nESC="line1\\nline2"\n`,
    );
    const parsed = await parseDotenv(path);
    expect(parsed.DOUBLE).toBe("hello world");
    expect(parsed.SINGLE).toBe("no \\n escapes");
    expect(parsed.ESC).toBe("line1\nline2");
  });

  it("returns empty for missing file", async () => {
    expect(await parseDotenv(join(dir, "nonexistent"))).toEqual({});
  });

  it("skips empty values", async () => {
    const path = join(dir, ".env");
    await writeFile(path, "EMPTY=\nGOOD=value\n");
    expect(await parseDotenv(path)).toEqual({ GOOD: "value" });
  });
});

describe("hermes extractCredentials", () => {
  let dir: string;
  const originalHome = process.env.HERMES_HOME;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "thomas-hermes-"));
    process.env.HERMES_HOME = dir;
  });

  afterEach(async () => {
    if (originalHome !== undefined) process.env.HERMES_HOME = originalHome;
    else delete process.env.HERMES_HOME;
    await rm(dir, { recursive: true, force: true });
  });

  it("maps known env keys to thomas providers", async () => {
    await writeFile(
      join(dir, ".env"),
      [
        "OPENROUTER_API_KEY=sk-or-test",
        "OPENAI_API_KEY=sk-oai-test",
        "ANTHROPIC_API_KEY=sk-ant-test",
        "KIMI_API_KEY=sk-kimi-test",
        "GROQ_API_KEY=gsk-test",
        "DEEPSEEK_API_KEY=sk-deepseek-test",
        "NOUS_API_KEY=ignored-not-built-in",
        "GLM_API_KEY=ignored-too",
      ].join("\n"),
    );
    const creds = await hermes.extractCredentials!();
    const byProvider = Object.fromEntries(creds.map((c) => [c.provider, c.key]));
    expect(byProvider).toEqual({
      openrouter: "sk-or-test",
      openai: "sk-oai-test",
      anthropic: "sk-ant-test",
      kimi: "sk-kimi-test",
      groq: "gsk-test",
      deepseek: "sk-deepseek-test",
    });
    expect(creds).toHaveLength(6);
  });

  it("returns empty when .env missing", async () => {
    const creds = await hermes.extractCredentials!();
    expect(creds).toEqual([]);
  });

  it("skips unknown env keys silently", async () => {
    await writeFile(join(dir, ".env"), "RANDOM_KEY=value\nNOUS_API_KEY=skip\n");
    const creds = await hermes.extractCredentials!();
    expect(creds).toEqual([]);
  });
});
