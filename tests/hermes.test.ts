import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDotenv } from "../src/agents/dotenv.js";
import { hermes } from "../src/agents/hermes.js";
import { HERMES_PROVIDERS } from "../src/providers/agents/hermes.generated.js";

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

describe("hermes provider catalog", () => {
  it("covers all built-ins plus hermes-only providers", () => {
    const ids = HERMES_PROVIDERS.map((p) => p.thomasId);
    expect(ids).toContain("openrouter");
    expect(ids).toContain("anthropic");
    expect(ids).toContain("xai");
    expect(ids).toContain("zai");
    expect(ids).toContain("gemini");
    expect(ids).toContain("copilot");
    expect(ids.length).toBeGreaterThanOrEqual(25);
  });

  it("marks built-ins so connect doesn't try to register them as custom", () => {
    const builtins = HERMES_PROVIDERS.filter((p) => p.builtin).map((p) => p.thomasId);
    expect(new Set(builtins)).toEqual(
      new Set(["anthropic", "openai", "openrouter", "deepseek", "kimi", "groq"]),
    );
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

  it("maps built-in env keys to thomas providers", async () => {
    await writeFile(
      join(dir, ".env"),
      [
        "OPENROUTER_API_KEY=sk-or-test",
        "OPENAI_API_KEY=sk-oai-test",
        "ANTHROPIC_API_KEY=sk-ant-test",
        "KIMI_API_KEY=sk-kimi-test",
        "GROQ_API_KEY=gsk-test",
        "DEEPSEEK_API_KEY=sk-deepseek-test",
      ].join("\n"),
    );
    const items = await hermes.extractCredentials!();
    const byProvider = Object.fromEntries(items.map((i) => [i.credential.provider, i.credential.key]));
    expect(byProvider.openrouter).toBe("sk-or-test");
    expect(byProvider.openai).toBe("sk-oai-test");
    expect(byProvider.anthropic).toBe("sk-ant-test");
    expect(byProvider.kimi).toBe("sk-kimi-test");
    expect(byProvider.groq).toBe("gsk-test");
    expect(byProvider.deepseek).toBe("sk-deepseek-test");
    // KIMI_API_KEY also feeds kimi-coding (a separate non-builtin provider) since hermes
    // recognizes the same env alias for both. The non-builtin gets a ProviderSpec attached.
    const builtinItems = items.filter((i) => ["openrouter", "openai", "anthropic", "kimi", "groq", "deepseek"].includes(i.credential.provider));
    expect(builtinItems.every((i) => i.provider === undefined)).toBe(true);
  });

  it("imports hermes-only providers and attaches a custom ProviderSpec for each", async () => {
    await writeFile(
      join(dir, ".env"),
      [
        "XAI_API_KEY=xai-test",
        "GLM_API_KEY=glm-test",
        "GEMINI_API_KEY=gemini-test",
        "COPILOT_GITHUB_TOKEN=ghp-test",
      ].join("\n"),
    );
    const items = await hermes.extractCredentials!();
    const byProvider = Object.fromEntries(items.map((i) => [i.credential.provider, i] as const));
    expect(byProvider.xai!.credential.key).toBe("xai-test");
    expect(byProvider.xai!.provider?.originBaseUrl).toBe("https://api.x.ai");
    expect(byProvider.zai!.credential.key).toBe("glm-test");
    expect(byProvider.gemini!.credential.key).toBe("gemini-test");
    expect(byProvider.copilot!.credential.key).toBe("ghp-test");
    for (const item of items) {
      expect(item.provider?.custom).toBe(true);
    }
  });

  it("uses first matching alias when multiple aliases set", async () => {
    await writeFile(
      join(dir, ".env"),
      "ANTHROPIC_TOKEN=second\nANTHROPIC_API_KEY=first\n",
    );
    const items = await hermes.extractCredentials!();
    const ant = items.find((i) => i.credential.provider === "anthropic");
    expect(ant?.credential.key).toBe("first");
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
