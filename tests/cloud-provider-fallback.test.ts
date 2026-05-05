// When a provider is configured ONLY on thomas-cloud (cloud-cache.providers
// has it, but the local user hasn't `thomas providers register`'d it), the
// proxy should still be able to reach it. Credential lookup stays local —
// "no key" still 503s, but with a clearer remediation hint.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeCache } from "../src/cloud/cache.js";
import type { CloudSnapshot } from "../src/cloud/types.js";
import { recordConnect } from "../src/config/agents.js";
import { upsertCredential } from "../src/config/credentials.js";
import { setRoute } from "../src/config/routes.js";
import { startServer } from "../src/proxy/server.js";

let dir: string;
const ORIG_THOMAS_HOME = process.env.THOMAS_HOME;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "thomas-cloud-prov-"));
  process.env.THOMAS_HOME = dir;
});

afterEach(async () => {
  if (ORIG_THOMAS_HOME !== undefined) process.env.THOMAS_HOME = ORIG_THOMAS_HOME;
  else delete process.env.THOMAS_HOME;
  await rm(dir, { recursive: true, force: true });
});

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      if (a && typeof a !== "string") resolve(a.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((r) => server.close(() => r()));
}

function snapshot(partial: Partial<CloudSnapshot>): CloudSnapshot {
  return {
    schemaVersion: 1,
    policies: [],
    bundles: [],
    bindings: [],
    providers: [],
    redactRulesVersion: null,
    syncedAt: new Date().toISOString(),
    ...partial,
  };
}

describe("proxy: cloud-only provider fallback", () => {
  it("forwards to a provider that exists ONLY in cloud-cache (not in local providers.json)", async () => {
    let upstreamHits = 0;
    let upstreamAuth = "";
    const upstream = createServer((req, res) => {
      upstreamHits += 1;
      upstreamAuth = String(req.headers.authorization ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-x",
          object: "chat.completion",
          choices: [
            { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
    const upstreamPort = await listen(upstream);

    // Cloud-cache says "cloudonly" provider exists at this URL with openai protocol.
    // We deliberately do NOT call providers.register("cloudonly") locally.
    await writeCache(
      snapshot({
        providers: [
          {
            providerId: "cloudonly",
            protocol: "openai",
            originBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
            isBuiltin: false,
          },
        ],
      }) as unknown as CloudSnapshot,
    );

    // Local: cred for "cloudonly" lives here. Privacy boundary unchanged.
    await upsertCredential({ provider: "cloudonly", type: "api_key", key: "test-key" });

    // Connected agent + route → cloudonly. Cloud could also drive this via a
    // binding, but the route fallback is enough to exercise the lookup path.
    await recordConnect("claude-code", {
      shimPath: "",
      originalBinary: "/usr/bin/claude",
      connectedAt: new Date().toISOString(),
      token: "thomas-claude-code-test-token",
    });
    await setRoute("claude-code", { provider: "cloudonly", model: "anything" });

    const server = await startServer(0);
    const port = (server.address() as { port: number }).port;

    try {
      const resp = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer thomas-claude-code-test-token",
        },
        body: JSON.stringify({
          model: "anything",
          messages: [{ role: "user", content: "hi" }],
        }),
      });

      expect(resp.status).toBe(200);
      expect(upstreamHits).toBe(1);
      // The proxy uses our LOCAL key when forwarding upstream — not anything
      // from cloud (which never sees keys).
      expect(upstreamAuth).toBe("Bearer test-key");
    } finally {
      await close(server);
      await close(upstream);
    }
  });

  it("returns a clear remediation when cloud provider has no local credential", async () => {
    await writeCache(
      snapshot({
        providers: [
          {
            providerId: "cloud-no-key",
            protocol: "openai",
            originBaseUrl: "http://example.invalid/v1",
            isBuiltin: false,
          },
        ],
      }) as unknown as CloudSnapshot,
    );
    // NO upsertCredential call → local key missing.

    await recordConnect("claude-code", {
      shimPath: "",
      originalBinary: "/usr/bin/claude",
      connectedAt: new Date().toISOString(),
      token: "thomas-tok-nokey",
    });
    await setRoute("claude-code", { provider: "cloud-no-key", model: "x" });

    const server = await startServer(0);
    const port = (server.address() as { port: number }).port;
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer thomas-tok-nokey",
        },
        body: JSON.stringify({ model: "x", messages: [{ role: "user", content: "hi" }] }),
      });
      // proxy wraps internal 503s as 502 (bad gateway) externally
      expect(resp.status).toBe(502);
      const text = await resp.text();
      expect(text).toContain("No credentials for provider cloud-no-key");
      // The cloud-only path adds a remediation hint that ordinary local
      // missing-cred 503s don't have:
      expect(text).toContain("delivered from thomas-cloud");
      expect(text).toContain("thomas providers add cloud-no-key");
    } finally {
      await close(server);
    }
  });

  it("local providers.json wins over cloud-cache when both have the same id", async () => {
    let cloudHits = 0;
    let localHits = 0;
    const cloud = createServer((_req, res) => {
      cloudHits += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"choices":[{"index":0,"message":{"role":"assistant","content":""}}],"usage":{}}');
    });
    const local = createServer((_req, res) => {
      localHits += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"choices":[{"index":0,"message":{"role":"assistant","content":""}}],"usage":{}}');
    });
    const cloudPort = await listen(cloud);
    const localPort = await listen(local);

    // Both cloud-cache + local providers.json claim "shared" — local should win.
    await writeCache(
      snapshot({
        providers: [
          {
            providerId: "shared",
            protocol: "openai",
            originBaseUrl: `http://127.0.0.1:${cloudPort}/v1`,
            isBuiltin: false,
          },
        ],
      }) as unknown as CloudSnapshot,
    );

    const { registerCustom } = await import("../src/providers/registry.js");
    await registerCustom({
      id: "shared",
      protocol: "openai",
      originBaseUrl: `http://127.0.0.1:${localPort}/v1`,
    });
    await upsertCredential({ provider: "shared", type: "api_key", key: "k" });

    await recordConnect("claude-code", {
      shimPath: "",
      originalBinary: "/usr/bin/claude",
      connectedAt: new Date().toISOString(),
      token: "thomas-tok-shared",
    });
    await setRoute("claude-code", { provider: "shared", model: "m" });

    const server = await startServer(0);
    const port = (server.address() as { port: number }).port;
    try {
      await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer thomas-tok-shared",
        },
        body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
      });
      expect(localHits).toBe(1);
      expect(cloudHits).toBe(0);
    } finally {
      await close(server);
      await close(cloud);
      await close(local);
    }
  });
});
