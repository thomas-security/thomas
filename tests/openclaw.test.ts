import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openclaw } from "../src/agents/openclaw.js";

describe("openclaw spec", () => {
  let dir: string;
  const originalHome = process.env.OPENCLAW_HOME;
  const originalPlist = process.env.THOMAS_OPENCLAW_LAUNCHD_PLIST;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "thomas-openclaw-"));
    process.env.OPENCLAW_HOME = dir;
    // Point the LaunchAgent plist override at a path that doesn't exist so
    // applyConfig/revertConfig's plist mutation is a no-op during these tests.
    // Without this, a contributor running `bun test` on macOS with openclaw
    // installed would have their real LaunchAgent rewritten.
    process.env.THOMAS_OPENCLAW_LAUNCHD_PLIST = join(dir, "no-such.plist");
  });

  afterEach(async () => {
    if (originalHome !== undefined) process.env.OPENCLAW_HOME = originalHome;
    else delete process.env.OPENCLAW_HOME;
    if (originalPlist !== undefined) process.env.THOMAS_OPENCLAW_LAUNCHD_PLIST = originalPlist;
    else delete process.env.THOMAS_OPENCLAW_LAUNCHD_PLIST;
    await rm(dir, { recursive: true, force: true });
  });

  describe("extractCredentials", () => {
    it("reads api_key + oauth profiles and attaches custom ProviderSpec when baseUrl is in main config", async () => {
      await writeFile(
        join(dir, "openclaw.json"),
        JSON.stringify({
          models: {
            providers: {
              vllm: {
                baseUrl: "https://api.example.com/coding/v1",
                api: "openai-completions",
                apiKey: "VLLM_API_KEY",
              },
            },
          },
        }),
      );
      const profileDir = join(dir, "agents", "main", "agent");
      await mkdir(profileDir, { recursive: true });
      await writeFile(
        join(profileDir, "auth-profiles.json"),
        JSON.stringify({
          version: 1,
          profiles: {
            "anthropic:claude-cli": {
              type: "oauth",
              provider: "claude-cli",
              access: "sk-ant-oat-xyz",
              refresh: "sk-ant-ort-xyz",
              expires: 1777466903004,
            },
            "vllm:default": {
              type: "api_key",
              provider: "vllm",
              key: "vllm-key-abc",
            },
          },
        }),
      );

      const items = await openclaw.extractCredentials!();
      const byProvider = Object.fromEntries(items.map((i) => [i.credential.provider, i]));

      expect(byProvider.vllm!.credential.key).toBe("vllm-key-abc");
      expect(byProvider.vllm!.provider).toEqual({
        id: "vllm",
        protocol: "openai",
        // Full baseUrl preserved (including /v1) — old behavior stripped /v1, which
        // also dropped post-/v1 segments and broke openclaw-style /v1/gateway endpoints.
        originBaseUrl: "https://api.example.com/coding/v1",
        custom: true,
      });

      const claudeCli = byProvider["claude-cli"]!;
      expect(claudeCli.credential.type).toBe("oauth");
      expect(claudeCli.credential.access).toBe("sk-ant-oat-xyz");
      expect(claudeCli.provider).toBeUndefined();
    });

    it("returns empty when no agent profiles exist", async () => {
      const items = await openclaw.extractCredentials!();
      expect(items).toEqual([]);
    });
  });

  describe("applyConfig + revertConfig", () => {
    it("applies thomas provider additively and reverts cleanly", async () => {
      const path = join(dir, "openclaw.json");
      const original = {
        agents: {
          defaults: {
            workspace: "/Users/tom/.openclaw/workspace",
            models: { "vllm/og-coding": {} },
            model: { primary: "vllm/og-coding" },
          },
          list: [{ id: "main" }],
        },
        models: {
          mode: "merge",
          providers: {
            vllm: {
              baseUrl: "https://api.example.com/coding/v1",
              api: "openai-completions",
              apiKey: "VLLM_API_KEY",
            },
          },
        },
      };
      await writeFile(path, JSON.stringify(original));

      const snapshot = await openclaw.applyConfig!({
        thomasUrl: "http://127.0.0.1:51168",
        thomasToken: "thomas-token-xyz",
      });

      const after = JSON.parse(await readFile(path, "utf8"));
      // user state preserved
      expect(after.models.providers.vllm).toEqual(original.models.providers.vllm);
      expect(after.agents.defaults.workspace).toBe(original.agents.defaults.workspace);
      expect(after.agents.defaults.list).toBeUndefined();
      expect(after.agents.list).toEqual(original.agents.list);
      // thomas provider added
      expect(after.models.providers.thomas).toMatchObject({
        baseUrl: "http://127.0.0.1:51168/v1",
        api: "openai-completions",
        apiKey: "${THOMAS_OPENCLAW_TOKEN}",
      });
      // default switched
      expect(after.agents.defaults.model.primary).toBe("thomas/auto");
      expect(after.agents.defaults.models["thomas/auto"]).toEqual({});
      expect(after.agents.defaults.models["vllm/og-coding"]).toEqual({});

      // snapshot captures the prior values
      expect(snapshot.data).toMatchObject({
        previousModelPrimary: "vllm/og-coding",
        previousModelsEntry: undefined,
        previousProvidersEntry: undefined,
      });

      await openclaw.revertConfig!(snapshot);
      const restored = JSON.parse(await readFile(path, "utf8"));
      expect(restored.agents.defaults.model.primary).toBe("vllm/og-coding");
      expect(restored.agents.defaults.models["thomas/auto"]).toBeUndefined();
      expect(restored.models.providers.thomas).toBeUndefined();
      expect(restored.models.providers.vllm).toEqual(original.models.providers.vllm);
    });

    it("preserves a pre-existing thomas provider entry across the round-trip", async () => {
      const path = join(dir, "openclaw.json");
      const preExisting = {
        baseUrl: "http://example.com/old",
        api: "openai-completions",
        apiKey: "OLD_KEY",
      };
      await writeFile(
        path,
        JSON.stringify({
          agents: { defaults: { model: { primary: "openai/gpt" } } },
          models: { providers: { thomas: preExisting } },
        }),
      );

      const snapshot = await openclaw.applyConfig!({
        thomasUrl: "http://127.0.0.1:51168",
        thomasToken: "tok",
      });
      await openclaw.revertConfig!(snapshot);
      const restored = JSON.parse(await readFile(path, "utf8"));
      expect(restored.models.providers.thomas).toEqual(preExisting);
      expect(restored.agents.defaults.model.primary).toBe("openai/gpt");
    });
  });
});
