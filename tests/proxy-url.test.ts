import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { recordConnect } from "../src/config/agents.js";
import { upsertCredential } from "../src/config/credentials.js";
import { setRoute } from "../src/config/routes.js";
import { buildOutboundCandidates, startServer } from "../src/proxy/server.js";
import { registerCustom } from "../src/providers/registry.js";

describe("buildOutboundCandidates", () => {
  it("emits a single URL when originBaseUrl already contains /v1 (suffix)", () => {
    expect(
      buildOutboundCandidates("https://api.openai.com/v1", "/v1/chat/completions"),
    ).toEqual(["https://api.openai.com/v1/chat/completions"]);
  });

  it("emits a single URL when /v1 sits mid-path (e.g. /v1/gateway)", () => {
    expect(
      buildOutboundCandidates("https://api.example.com/v1/gateway", "/v1/chat/completions"),
    ).toEqual(["https://api.example.com/v1/gateway/chat/completions"]);
  });

  it("emits two candidates when originBaseUrl has no /v1 — no-/v1 first, /v1 fallback", () => {
    expect(
      buildOutboundCandidates("https://api.example.com", "/v1/chat/completions"),
    ).toEqual([
      "https://api.example.com/chat/completions",
      "https://api.example.com/v1/chat/completions",
    ]);
  });

  it("preserves /openai-style prefixes that sit before the /v1 segment", () => {
    // groq's pattern — host has /openai prefix BEFORE /v1; legacy data shape.
    expect(
      buildOutboundCandidates("https://api.groq.com/openai", "/v1/chat/completions"),
    ).toEqual([
      "https://api.groq.com/openai/chat/completions",
      "https://api.groq.com/openai/v1/chat/completions",
    ]);
  });

  it("trims trailing slashes off the base", () => {
    expect(
      buildOutboundCandidates("https://api.example.com/v1/", "/v1/chat/completions"),
    ).toEqual(["https://api.example.com/v1/chat/completions"]);
  });

  it("works for /v1/messages too", () => {
    expect(
      buildOutboundCandidates("https://api.anthropic.com", "/v1/messages"),
    ).toEqual([
      "https://api.anthropic.com/messages",
      "https://api.anthropic.com/v1/messages",
    ]);
  });

  it("does not strip /v1 from outboundPath when it appears mid-string", () => {
    // Defensive: regex anchored at start, so we don't accidentally strip /v1
    // suffixes (paths normally won't contain that, but the regex must not match it).
    expect(
      buildOutboundCandidates("https://api.example.com/v1", "/v1/messages"),
    ).toEqual(["https://api.example.com/v1/messages"]);
  });
});

// Integration: spin up a fake upstream that 404s on /chat/completions and
// 200s on /v1/chat/completions. Proxy must adapt and use the second URL.
describe("proxy adaptive URL fallback (404 → retry with /v1)", () => {
  let dir: string;
  const ORIG_THOMAS_HOME = process.env.THOMAS_HOME;
  let upstream: Server | undefined;
  let proxy: Server | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "thomas-proxy-url-"));
    process.env.THOMAS_HOME = dir;
  });

  afterEach(async () => {
    if (ORIG_THOMAS_HOME !== undefined) process.env.THOMAS_HOME = ORIG_THOMAS_HOME;
    else delete process.env.THOMAS_HOME;
    await new Promise<void>((r) => (upstream ? upstream.close(() => r()) : r()));
    await new Promise<void>((r) => (proxy ? proxy.close(() => r()) : r()));
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

  it("falls back from /chat/completions (404) to /v1/chat/completions (200)", async () => {
    let firstHitPath: string | null = null;
    let secondHitPath: string | null = null;
    upstream = createServer((req, res) => {
      // Simulate a server that only serves the /v1-prefixed verb.
      if (req.url === "/v1/chat/completions") {
        secondHitPath = req.url;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "x",
            object: "chat.completion",
            choices: [{ index: 0, message: { role: "assistant", content: "ok" } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
        return;
      }
      firstHitPath = req.url ?? "";
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    });
    const upstreamPort = await listen(upstream);

    await registerCustom({
      id: "fake-novr1",
      protocol: "openai",
      // No /v1 in originBaseUrl — proxy should try /chat/completions first, fall back.
      originBaseUrl: `http://127.0.0.1:${upstreamPort}`,
    });
    await upsertCredential({ provider: "fake-novr1", type: "api_key", key: "test-key" });
    await setRoute("openclaw", { provider: "fake-novr1", model: "passthrough" });
    await recordConnect("openclaw", {
      shimPath: "",
      originalBinary: "/usr/bin/openclaw",
      connectedAt: new Date().toISOString(),
      token: "thomas-openclaw-test-token",
    });

    proxy = await startServer(0);
    const proxyPort = (proxy.address() as { port: number }).port;

    const resp = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer thomas-openclaw-test-token",
      },
      body: JSON.stringify({
        model: "any",
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(resp.status).toBe(200);
    // Proxy hit the no-/v1 URL first, then the /v1 URL on fallback
    expect(firstHitPath).toBe("/chat/completions");
    expect(secondHitPath).toBe("/v1/chat/completions");
  });

  it("does NOT retry on 401 (ambiguous between wrong-path and wrong-key)", async () => {
    let hits = 0;
    upstream = createServer((_req, res) => {
      hits += 1;
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
    });
    const upstreamPort = await listen(upstream);

    await registerCustom({
      id: "fake-401",
      protocol: "openai",
      originBaseUrl: `http://127.0.0.1:${upstreamPort}`,
    });
    await upsertCredential({ provider: "fake-401", type: "api_key", key: "bad-key" });
    await setRoute("openclaw", { provider: "fake-401", model: "passthrough" });
    await recordConnect("openclaw", {
      shimPath: "",
      originalBinary: "/usr/bin/openclaw",
      connectedAt: new Date().toISOString(),
      token: "thomas-openclaw-test-token-401",
    });

    proxy = await startServer(0);
    const proxyPort = (proxy.address() as { port: number }).port;

    const resp = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer thomas-openclaw-test-token-401",
      },
      body: JSON.stringify({
        model: "any",
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    // Proxy passes upstream 401 through (no fallback to second URL — would waste a call).
    expect(resp.status).toBe(401);
    expect(hits).toBe(1);
  });
});
