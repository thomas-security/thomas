import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { connect } from "../src/commands/connect.js";
import { disconnect } from "../src/commands/disconnect.js";
import { doctor } from "../src/commands/doctor.js";
import {
  providersAdd,
  providersRegister,
  providersRemove,
  providersUnregister,
} from "../src/commands/providers.js";
import { route } from "../src/commands/route.js";
import { isSkillInstalled, skillInstall, skillRemove } from "../src/commands/skill.js";
import { recordConnect } from "../src/config/agents.js";
import { setRoute } from "../src/config/routes.js";
import { captureStdout } from "./_util.js";

let dir: string;
const ORIG_THOMAS_HOME = process.env.THOMAS_HOME;
const ORIG_HOMEDIR = process.env.HOME;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "thomas-cmd-"));
  process.env.THOMAS_HOME = dir;
  // Override HOME so skill commands resolve under the temp dir, not ~/.claude.
  process.env.HOME = dir;
});

afterEach(async () => {
  if (ORIG_THOMAS_HOME !== undefined) process.env.THOMAS_HOME = ORIG_THOMAS_HOME;
  else delete process.env.THOMAS_HOME;
  if (ORIG_HOMEDIR !== undefined) process.env.HOME = ORIG_HOMEDIR;
  else delete process.env.HOME;
  await rm(dir, { recursive: true, force: true });
});

describe("providers.add (--json)", () => {
  it("adds a key for a built-in provider with replacedExisting=false", async () => {
    const { result, out } = await captureStdout(() =>
      providersAdd("anthropic", "sk-ant-fake", { json: true }),
    );
    expect(result).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.command).toBe("providers.add");
    expect(parsed.data).toEqual({ provider: "anthropic", replacedExisting: false });
  });

  it("returns replacedExisting=true on second add", async () => {
    await captureStdout(() => providersAdd("anthropic", "sk-1", { json: true }));
    const { result, out } = await captureStdout(() =>
      providersAdd("anthropic", "sk-2", { json: true }),
    );
    expect(result).toBe(0);
    expect(JSON.parse(out).data.replacedExisting).toBe(true);
  });

  it("errors on unknown provider with E_PROVIDER_NOT_FOUND", async () => {
    const { result, out } = await captureStdout(() =>
      providersAdd("nope", "sk-x", { json: true }),
    );
    expect(result).toBe(1);
    const parsed = JSON.parse(out);
    expect(parsed.error.code).toBe("E_PROVIDER_NOT_FOUND");
    expect(parsed.error.details).toEqual({ requested: "nope" });
  });

  it("does not include the key in JSON output", async () => {
    const { out } = await captureStdout(() =>
      providersAdd("anthropic", "sk-secret-12345", { json: true }),
    );
    expect(out).not.toContain("sk-secret-12345");
  });
});

describe("providers.remove (--json)", () => {
  it("removes existing credentials with removed=true", async () => {
    await captureStdout(() => providersAdd("openai", "sk-o", { json: true }));
    const { result, out } = await captureStdout(() =>
      providersRemove("openai", { json: true }),
    );
    expect(result).toBe(0);
    expect(JSON.parse(out).data).toEqual({ provider: "openai", removed: true });
  });

  it("returns removed=false (not error, exit 0) when no credentials exist", async () => {
    const { result, out } = await captureStdout(() =>
      providersRemove("openai", { json: true }),
    );
    expect(result).toBe(0);
    expect(JSON.parse(out).data).toEqual({ provider: "openai", removed: false });
  });
});

describe("providers.register (--json)", () => {
  it("registers a custom provider preserving the user's full baseUrl", async () => {
    const { result, out } = await captureStdout(() =>
      providersRegister("myvllm", "openai", "https://example.com/v1", { json: true }),
    );
    expect(result).toBe(0);
    // Full URL preserved — proxy decides at request time whether /v1 is needed.
    // Old behavior stripped /v1 here, which also dropped post-/v1 segments.
    expect(JSON.parse(out).data).toEqual({
      provider: "myvllm",
      protocol: "openai",
      baseUrl: "https://example.com/v1",
      replacedExisting: false,
    });
  });

  it("preserves path-after-/v1 segments (e.g. /v1/gateway) on register", async () => {
    const { result, out } = await captureStdout(() =>
      providersRegister(
        "vllm-gateway",
        "openai",
        "https://api.example.com/v1/gateway/",
        { json: true },
      ),
    );
    expect(result).toBe(0);
    // trailing slash trimmed; rest preserved
    expect(JSON.parse(out).data.baseUrl).toBe("https://api.example.com/v1/gateway");
  });

  it("rejects unknown protocol with E_INVALID_ARG", async () => {
    const { result, out } = await captureStdout(() =>
      providersRegister("x", "weird", "https://example.com", { json: true }),
    );
    expect(result).toBe(1);
    const parsed = JSON.parse(out);
    expect(parsed.error.code).toBe("E_INVALID_ARG");
    expect(parsed.error.details).toEqual({ arg: "--protocol", value: "weird" });
  });

  it("rejects non-http URL with E_INVALID_ARG", async () => {
    const { result, out } = await captureStdout(() =>
      providersRegister("x", "openai", "ftp://nope.com", { json: true }),
    );
    expect(result).toBe(1);
    expect(JSON.parse(out).error.code).toBe("E_INVALID_ARG");
  });

  it("rejects re-registering a built-in id", async () => {
    const { result, out } = await captureStdout(() =>
      providersRegister("anthropic", "openai", "https://example.com", { json: true }),
    );
    expect(result).toBe(1);
    expect(JSON.parse(out).error.code).toBe("E_INVALID_ARG");
  });
});

describe("providers.unregister (--json)", () => {
  it("removes a registered custom provider", async () => {
    await captureStdout(() =>
      providersRegister("myx", "openai", "https://x.com", { json: true }),
    );
    const { result, out } = await captureStdout(() =>
      providersUnregister("myx", { json: true }),
    );
    expect(result).toBe(0);
    expect(JSON.parse(out).data).toEqual({ provider: "myx", removed: true });
  });

  it("returns removed=false (exit 0) for unknown id", async () => {
    const { result, out } = await captureStdout(() =>
      providersUnregister("nope", { json: true }),
    );
    expect(result).toBe(0);
    expect(JSON.parse(out).data).toEqual({ provider: "nope", removed: false });
  });
});

describe("route (--json)", () => {
  it("errors on unknown agent", async () => {
    const { result, out } = await captureStdout(() =>
      route("nope", "anthropic/claude", { json: true }),
    );
    expect(result).toBe(1);
    const parsed = JSON.parse(out);
    expect(parsed.error.code).toBe("E_AGENT_NOT_FOUND");
    expect(parsed.error.details.known).toContain("claude-code");
  });

  it("errors on bad spec format with E_INVALID_ARG", async () => {
    const { result, out } = await captureStdout(() =>
      route("claude-code", "missingslash", { json: true }),
    );
    expect(result).toBe(1);
    expect(JSON.parse(out).error.code).toBe("E_INVALID_ARG");
  });

  it("errors on unknown provider with E_PROVIDER_NOT_FOUND", async () => {
    const { result, out } = await captureStdout(() =>
      route("claude-code", "fake-provider/some-model", { json: true }),
    );
    expect(result).toBe(1);
    expect(JSON.parse(out).error.code).toBe("E_PROVIDER_NOT_FOUND");
  });

  it("errors when agent is not connected", async () => {
    const { result, out } = await captureStdout(() =>
      route("claude-code", "anthropic/claude-opus", { json: true }),
    );
    expect(result).toBe(1);
    expect(JSON.parse(out).error.code).toBe("E_AGENT_NOT_CONNECTED");
  });

  it("succeeds when agent is connected; returns previous + current", async () => {
    await recordConnect("claude-code", {
      shimPath: join(dir, "bin", "claude"),
      originalBinary: "/usr/bin/claude",
      connectedAt: new Date().toISOString(),
      token: "fake",
    });
    await setRoute("claude-code", { provider: "anthropic", model: "claude-old" });
    const { result, out } = await captureStdout(() =>
      route("claude-code", "anthropic/claude-new", { json: true }),
    );
    expect(result).toBe(0);
    expect(JSON.parse(out).data).toEqual({
      agent: "claude-code",
      previous: { provider: "anthropic", model: "claude-old" },
      current: { provider: "anthropic", model: "claude-new" },
    });
  });

  it("returns previous=null when no prior route existed", async () => {
    await recordConnect("claude-code", {
      shimPath: join(dir, "bin", "claude"),
      originalBinary: "/usr/bin/claude",
      connectedAt: new Date().toISOString(),
      token: "fake",
    });
    const { out } = await captureStdout(() =>
      route("claude-code", "anthropic/claude-new", { json: true }),
    );
    expect(JSON.parse(out).data.previous).toBeNull();
  });
});

describe("disconnect (--json)", () => {
  it("errors on unknown agent", async () => {
    const { result, out } = await captureStdout(() =>
      disconnect("nope", { json: true }),
    );
    expect(result).toBe(1);
    expect(JSON.parse(out).error.code).toBe("E_AGENT_NOT_FOUND");
  });

  it("returns wasConnected=false (exit 0) when agent was not connected", async () => {
    const { result, out } = await captureStdout(() =>
      disconnect("openclaw", { json: true }),
    );
    expect(result).toBe(0);
    expect(JSON.parse(out).data).toEqual({
      agent: "openclaw",
      wasConnected: false,
      shimRemoved: false,
      configReverted: false,
      restart: null,
      notes: [],
    });
  });
});

describe("connect (--json)", () => {
  it("errors on unknown agent with E_AGENT_NOT_FOUND", async () => {
    const { result, out } = await captureStdout(() =>
      connect({ agentId: "nope", json: true }),
    );
    expect(result).toBe(1);
    const parsed = JSON.parse(out);
    expect(parsed.command).toBe("connect");
    expect(parsed.error.code).toBe("E_AGENT_NOT_FOUND");
    expect(parsed.error.details).toEqual({
      requested: "nope",
      known: ["claude-code", "codex", "openclaw", "hermes"],
    });
  });

  it("errors with E_AGENT_NOT_INSTALLED when the binary is absent from PATH", async () => {
    const origPath = process.env.PATH;
    // Empty PATH so whichBinary("claude") returns nothing regardless of host.
    process.env.PATH = "";
    try {
      const { result, out } = await captureStdout(() =>
        connect({ agentId: "claude-code", json: true }),
      );
      expect(result).toBe(1);
      const parsed = JSON.parse(out);
      expect(parsed.error.code).toBe("E_AGENT_NOT_INSTALLED");
      expect(parsed.error.details).toEqual({ agent: "claude-code" });
    } finally {
      if (origPath !== undefined) process.env.PATH = origPath;
      else delete process.env.PATH;
    }
  });
});

describe("connect (--json) — shim PATH verification", () => {
  // /usr/bin and /bin must stay on PATH so execFile can find `which` itself.
  // Test scenarios layer fake/thomas dirs on top of those baseline entries.
  const SYSTEM_PATH = "/usr/bin:/bin";

  // Drop a fake executable in fakeBinDir so detect()/whichBinary finds it,
  // then point PATH at scenarios that exercise the verifyShimWins decision.
  async function fakeBinary(name: string): Promise<{ binDir: string; binary: string }> {
    const binDir = join(dir, "fakebin");
    await mkdir(binDir, { recursive: true });
    const binary = join(binDir, name);
    await writeFile(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    return { binDir, binary };
  }

  it("shim-env agent: rolls back when ~/.thomas/bin is missing from PATH", async () => {
    const { binDir } = await fakeBinary("claude");
    const origPath = process.env.PATH;
    process.env.PATH = `${binDir}:${SYSTEM_PATH}`;
    try {
      const { result, out } = await captureStdout(() =>
        connect({ agentId: "claude-code", json: true }),
      );
      expect(result).toBe(1);
      const parsed = JSON.parse(out);
      expect(parsed.error.code).toBe("E_SHIM_NOT_ON_PATH");
      expect(parsed.error.details.reason).toBe("missing");
      expect(parsed.error.details.agent).toBe("claude-code");
      // shim file removed by rollback
      expect(existsSync(join(dir, "bin", "claude"))).toBe(false);
      // remediation must include the export PATH line
      expect(parsed.error.remediation).toContain(`export PATH="${join(dir, "bin")}:$PATH"`);
    } finally {
      if (origPath !== undefined) process.env.PATH = origPath;
      else delete process.env.PATH;
    }
  });

  it("shim-env agent: rolls back when ~/.thomas/bin is shadowed by binary's dir", async () => {
    const { binDir } = await fakeBinary("claude");
    const thomasBin = join(dir, "bin");
    const origPath = process.env.PATH;
    // Original-binary dir comes BEFORE thomas/bin → real binary wins.
    process.env.PATH = `${SYSTEM_PATH}:${binDir}:${thomasBin}`;
    try {
      const { result, out } = await captureStdout(() =>
        connect({ agentId: "claude-code", json: true }),
      );
      expect(result).toBe(1);
      const parsed = JSON.parse(out);
      expect(parsed.error.code).toBe("E_SHIM_NOT_ON_PATH");
      expect(parsed.error.details.reason).toBe("shadowed");
      expect(existsSync(join(dir, "bin", "claude"))).toBe(false);
    } finally {
      if (origPath !== undefined) process.env.PATH = origPath;
      else delete process.env.PATH;
    }
  });

  it("config-mode agent: rolls back BOTH shim and config patch", async () => {
    // Pre-existing openclaw config with a real model the user picked. After
    // a rolled-back connect, the file should be exactly as it was.
    const openclawDir = join(dir, ".openclaw");
    await mkdir(openclawDir, { recursive: true });
    const openclawConfig = join(openclawDir, "openclaw.json");
    const originalConfig = {
      agents: {
        defaults: {
          models: { "vllm/gpt-5.5": {} },
          model: { primary: "vllm/gpt-5.5" },
        },
      },
      models: {
        mode: "merge",
        providers: {
          vllm: { baseUrl: "https://example.com/v1", api: "openai-completions" },
        },
      },
    };
    await writeFile(openclawConfig, JSON.stringify(originalConfig, null, 2));

    const { binDir } = await fakeBinary("openclaw");
    const origPath = process.env.PATH;
    process.env.PATH = `${binDir}:${SYSTEM_PATH}`; // thomas/bin missing → verifyShimWins fails
    try {
      const { result, out } = await captureStdout(() =>
        connect({ agentId: "openclaw", json: true }),
      );
      expect(result).toBe(1);
      const parsed = JSON.parse(out);
      expect(parsed.error.code).toBe("E_SHIM_NOT_ON_PATH");

      // Shim removed
      expect(existsSync(join(dir, "bin", "openclaw"))).toBe(false);
      // Snapshot deleted
      expect(existsSync(join(dir, "snapshots", "openclaw.json"))).toBe(false);
      // Config restored — primary back to vllm, no thomas provider added
      const restored = JSON.parse(await readFile(openclawConfig, "utf8"));
      expect(restored.agents.defaults.model.primary).toBe("vllm/gpt-5.5");
      expect(restored.models.providers.thomas).toBeUndefined();
      expect(Object.keys(restored.agents.defaults.models)).not.toContain("thomas/auto");
    } finally {
      if (origPath !== undefined) process.env.PATH = origPath;
      else delete process.env.PATH;
    }
  });
});

describe("connect (--json) — provider health probes", () => {
  it("emits providerProbes + a warning note when imported provider URL is wrong", async () => {
    // Fake "upstream" that always returns 404 — simulates the user's vllm/coding case.
    const { createServer } = await import("node:http");
    const upstream = createServer((_req, res) => {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    });
    const port = await new Promise<number>((resolve) => {
      upstream.listen(0, "127.0.0.1", () => {
        const a = upstream.address();
        if (a && typeof a !== "string") resolve(a.port);
      });
    });

    try {
      // Stand up a fake openclaw config so extractCredentials returns one provider.
      const openclawDir = join(dir, ".openclaw");
      await mkdir(openclawDir, { recursive: true });
      await writeFile(
        join(openclawDir, "openclaw.json"),
        JSON.stringify({
          models: {
            providers: {
              brokenvllm: {
                baseUrl: `http://127.0.0.1:${port}/dead`,
                api: "openai-completions",
              },
            },
          },
        }),
      );
      const profileDir = join(openclawDir, "agents", "main", "agent");
      await mkdir(profileDir, { recursive: true });
      await writeFile(
        join(profileDir, "auth-profiles.json"),
        JSON.stringify({
          version: 1,
          profiles: {
            "brokenvllm:default": { type: "api_key", provider: "brokenvllm", key: "k" },
          },
        }),
      );

      // --no-proxy avoids the shim/PATH path; we just want connect to import + probe.
      const { binDir } = await fakeBinaryHelper("openclaw");
      const origPath = process.env.PATH;
      process.env.PATH = `${binDir}:/usr/bin:/bin`;
      try {
        const { result, out } = await captureStdout(() =>
          connect({ agentId: "openclaw", noProxy: true, json: true }),
        );
        expect(result).toBe(0);
        const parsed = JSON.parse(out);
        const probes = parsed.data.providerProbes;
        expect(probes).toHaveLength(1);
        expect(probes[0].provider).toBe("brokenvllm");
        expect(probes[0].ok).toBe(false);
        expect(probes[0].reason).toBe("wrong_path");

        const notes: string[] = parsed.data.notes;
        expect(notes.some((n) => n.includes("brokenvllm") && n.includes("404"))).toBe(true);
      } finally {
        if (origPath !== undefined) process.env.PATH = origPath;
        else delete process.env.PATH;
      }
    } finally {
      await new Promise<void>((r) => upstream.close(() => r()));
    }
  });

  // Helper for this describe block — same shape as the verifyShim describe's fakeBinary.
  async function fakeBinaryHelper(name: string): Promise<{ binDir: string }> {
    const binDir = join(dir, `fakebin-${name}`);
    await mkdir(binDir, { recursive: true });
    await writeFile(join(binDir, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    return { binDir };
  }
});

describe("doctor (--json) — provider health probes", () => {
  // Doctor calls detect() for every agent; on the host we'd shell out to real
  // claude/codex/openclaw/hermes --version (3s timeout each). Stub PATH to a
  // dir with only system bins so detect() reports "not installed" cheaply.
  let savedPath: string | undefined;
  beforeEach(() => {
    savedPath = process.env.PATH;
    process.env.PATH = "/usr/bin:/bin"; // 'which' resolves; no agents found
  });
  afterEach(() => {
    if (savedPath !== undefined) process.env.PATH = savedPath;
    else delete process.env.PATH;
  });

  it("providerHealth is null when --check is not passed (no network calls)", async () => {
    await captureStdout(() => providersAdd("anthropic", "sk-ant-fake", { json: true }));
    const { result, out } = await captureStdout(() => doctor({ json: true }));
    expect(result).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.data.providerHealth).toBeNull();
  });

  it("--check populates providerHealth with one entry per credentialed provider", async () => {
    const { createServer } = await import("node:http");
    const upstream = createServer((req, res) => {
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"object":"list","data":[]}');
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const port = await new Promise<number>((resolve) => {
      upstream.listen(0, "127.0.0.1", () => {
        const a = upstream.address();
        if (a && typeof a !== "string") resolve(a.port);
      });
    });

    try {
      await captureStdout(() =>
        providersRegister("local-vllm", "openai", `http://127.0.0.1:${port}/v1`, { json: true }),
      );
      await captureStdout(() => providersAdd("local-vllm", "key", { json: true }));

      const { result, out } = await captureStdout(() => doctor({ json: true, check: true }));
      expect(result).toBe(0);
      const parsed = JSON.parse(out);
      expect(parsed.data.providerHealth).toHaveLength(1);
      expect(parsed.data.providerHealth[0]).toMatchObject({
        provider: "local-vllm",
        ok: true,
        status: 200,
      });
    } finally {
      await new Promise<void>((r) => upstream.close(() => r()));
    }
  });

  it("--check surfaces a wrong_path probe when the registered URL is dead", async () => {
    const { createServer } = await import("node:http");
    const upstream = createServer((_req, res) => {
      res.writeHead(404);
      res.end("nope");
    });
    const port = await new Promise<number>((resolve) => {
      upstream.listen(0, "127.0.0.1", () => {
        const a = upstream.address();
        if (a && typeof a !== "string") resolve(a.port);
      });
    });

    try {
      await captureStdout(() =>
        providersRegister("dead", "openai", `http://127.0.0.1:${port}/dead/v1`, { json: true }),
      );
      await captureStdout(() => providersAdd("dead", "key", { json: true }));

      const { result, out } = await captureStdout(() => doctor({ json: true, check: true }));
      expect(result).toBe(0);
      const parsed = JSON.parse(out);
      const dead = parsed.data.providerHealth.find((p: { provider: string }) => p.provider === "dead");
      expect(dead.ok).toBe(false);
      expect(dead.reason).toBe("wrong_path");
    } finally {
      await new Promise<void>((r) => upstream.close(() => r()));
    }
  });
});

describe("skill.install / skill.remove (--json)", () => {
  it("install copies SKILL.md to ~/.claude/skills/thomas/ and returns the path", async () => {
    const { result, out } = await captureStdout(() =>
      skillInstall("claude-code", { json: true }),
    );
    expect(result).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.command).toBe("skill.install");
    expect(parsed.data.agent).toBe("claude-code");
    const expected = join(dir, ".claude", "skills", "thomas", "SKILL.md");
    expect(parsed.data.path).toBe(expected);
    expect(existsSync(expected)).toBe(true);
  });

  it("install errors on unsupported agent with E_INVALID_ARG", async () => {
    const { result, out } = await captureStdout(() =>
      skillInstall("codex", { json: true }),
    );
    expect(result).toBe(1);
    const parsed = JSON.parse(out);
    expect(parsed.error.code).toBe("E_INVALID_ARG");
    expect(parsed.error.details).toEqual({ agent: "codex" });
  });

  it("install errors on unknown agent with E_AGENT_NOT_FOUND", async () => {
    const { result, out } = await captureStdout(() =>
      skillInstall("nope", { json: true }),
    );
    expect(result).toBe(1);
    expect(JSON.parse(out).error.code).toBe("E_AGENT_NOT_FOUND");
  });

  it("remove after install returns removed=true and deletes the directory", async () => {
    await captureStdout(() => skillInstall("claude-code", { json: true }));
    const installedPath = join(dir, ".claude", "skills", "thomas");
    expect(existsSync(installedPath)).toBe(true);
    const { result, out } = await captureStdout(() =>
      skillRemove("claude-code", { json: true }),
    );
    expect(result).toBe(0);
    expect(JSON.parse(out).data.removed).toBe(true);
    expect(existsSync(installedPath)).toBe(false);
  });

  it("remove returns removed=false (exit 0) when nothing is installed", async () => {
    const { result, out } = await captureStdout(() =>
      skillRemove("claude-code", { json: true }),
    );
    expect(result).toBe(0);
    expect(JSON.parse(out).data.removed).toBe(false);
  });

  it("isSkillInstalled reflects post-install state under HOME override", async () => {
    expect(await isSkillInstalled("claude-code")).toBe(false);
    await captureStdout(() => skillInstall("claude-code", { json: true }));
    expect(await isSkillInstalled("claude-code")).toBe(true);
  });
});
