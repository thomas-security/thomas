import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { upsertCredential } from "../src/config/credentials.js";
import { probeProvider } from "../src/providers/health.js";
import type { ProviderSpec } from "../src/providers/registry.js";

let dir: string;
const ORIG_THOMAS_HOME = process.env.THOMAS_HOME;
let upstream: Server | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "thomas-health-"));
  process.env.THOMAS_HOME = dir;
});

afterEach(async () => {
  if (ORIG_THOMAS_HOME !== undefined) process.env.THOMAS_HOME = ORIG_THOMAS_HOME;
  else delete process.env.THOMAS_HOME;
  await new Promise<void>((r) => (upstream ? upstream.close(() => r()) : r()));
  upstream = undefined;
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

async function specWithKey(originBaseUrl: string, protocol: "openai" | "anthropic" = "openai"): Promise<ProviderSpec> {
  const id = `probe-${Math.random().toString(36).slice(2, 8)}`;
  await upsertCredential({ provider: id, type: "api_key", key: "test-key" });
  return { id, protocol, originBaseUrl };
}

describe("probeProvider", () => {
  it("returns ok=true when /v1/models returns 200", async () => {
    upstream = createServer((req, res) => {
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: "gpt-x" }] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const port = await listen(upstream);
    const spec = await specWithKey(`http://127.0.0.1:${port}/v1`);

    const r = await probeProvider(spec);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.status).toBe(200);
      expect(r.url).toBe(`http://127.0.0.1:${port}/v1/models`);
    }
  });

  it("classifies 401 as auth_failed (no fallback)", async () => {
    let hits = 0;
    upstream = createServer((_req, res) => {
      hits += 1;
      res.writeHead(401, { "content-type": "application/json" });
      res.end('{"error":"Unauthorized"}');
    });
    const port = await listen(upstream);
    const spec = await specWithKey(`http://127.0.0.1:${port}/v1`);

    const r = await probeProvider(spec);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("auth_failed");
      expect(r.status).toBe(401);
    }
    expect(hits).toBe(1); // single attempt — must not retry on 401
  });

  it("classifies 404-on-everything as wrong_path (both /models and OPTIONS verb 404)", async () => {
    let hits = 0;
    upstream = createServer((_req, res) => {
      hits += 1;
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("nope");
    });
    const port = await listen(upstream);
    // No /v1 in originBaseUrl → adaptive code tries /models AND /v1/models for GET,
    // then /chat/completions AND /v1/chat/completions for OPTIONS — all 404 here.
    const spec = await specWithKey(`http://127.0.0.1:${port}`);

    const r = await probeProvider(spec);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("wrong_path");
    // Phase 1 (GET): 2 candidates × 404. Phase 2 (OPTIONS): 2 more candidates × 404.
    expect(hits).toBe(4);
  });

  it("treats /models 404 + OPTIONS 2xx as ok (server doesn't expose /models but URL is correct)", async () => {
    // Models the user's actual real xiangxinai vllm endpoint: /v1/models 404 (not exposed),
    // OPTIONS /v1/chat/completions 204 (CORS preflight handler). Should NOT false-positive.
    const requests: Array<{ method: string; url: string }> = [];
    upstream = createServer((req, res) => {
      requests.push({ method: req.method ?? "", url: req.url ?? "" });
      if (req.url === "/v1/models") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end('{"detail":"Not Found"}');
        return;
      }
      if (req.method === "OPTIONS" && req.url === "/v1/chat/completions") {
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const port = await listen(upstream);
    const spec = await specWithKey(`http://127.0.0.1:${port}/v1`);

    const r = await probeProvider(spec);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url).toBe(`http://127.0.0.1:${port}/v1/chat/completions`);
    // Phase 1 GET (1 candidate) → 404; Phase 2 OPTIONS (1 candidate) → 204.
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual({ method: "GET", url: "/v1/models" });
    expect(requests[1]).toEqual({ method: "OPTIONS", url: "/v1/chat/completions" });
  });

  it("treats /models 404 + OPTIONS 405 as models_unavailable (anthropic-style strict server)", async () => {
    // Anthropic returns 405 to OPTIONS at /v1/messages even though the URL is correct.
    // We can't tell that apart from "URL is wrong AND server returns 405 by default,"
    // so we surface as models_unavailable rather than false-claiming wrong_path.
    upstream = createServer((req, res) => {
      if (req.url === "/v1/models") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end('{"detail":"Not Found"}');
        return;
      }
      if (req.method === "OPTIONS") {
        res.writeHead(405, { "content-type": "application/json" });
        res.end('{"error":"Method Not Allowed"}');
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const port = await listen(upstream);
    const spec = await specWithKey(`http://127.0.0.1:${port}/v1`);

    const r = await probeProvider(spec);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("models_unavailable");
      expect(r.status).toBe(405);
    }
  });

  it("falls back from 404 on /models to 200 on /v1/models (adaptive URL inside phase 1)", async () => {
    upstream = createServer((req, res) => {
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"object":"list","data":[]}');
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const port = await listen(upstream);
    // No /v1 in originBaseUrl → adaptive: /models (404) → /v1/models (200).
    const spec = await specWithKey(`http://127.0.0.1:${port}`);

    const r = await probeProvider(spec);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url).toBe(`http://127.0.0.1:${port}/v1/models`);
  });

  it("classifies network errors as unreachable", async () => {
    // Port 1 is reserved & should reliably refuse connection on localhost.
    const spec = await specWithKey("http://127.0.0.1:1");
    const r = await probeProvider(spec, { timeoutMs: 1500 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unreachable");
  });

  it("classifies 5xx as 'other'", async () => {
    upstream = createServer((_req, res) => {
      res.writeHead(503, { "content-type": "application/json" });
      res.end('{"error":"service unavailable"}');
    });
    const port = await listen(upstream);
    const spec = await specWithKey(`http://127.0.0.1:${port}/v1`);

    const r = await probeProvider(spec);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("other");
      expect(r.status).toBe(503);
    }
  });

  it("uses x-api-key + anthropic-version header for anthropic protocol", async () => {
    let receivedAuth = "";
    let receivedXApiKey = "";
    let receivedVersion = "";
    upstream = createServer((req, res) => {
      receivedAuth = String(req.headers.authorization ?? "");
      receivedXApiKey = String(req.headers["x-api-key"] ?? "");
      receivedVersion = String(req.headers["anthropic-version"] ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"data":[]}');
    });
    const port = await listen(upstream);
    const spec = await specWithKey(`http://127.0.0.1:${port}/v1`, "anthropic");

    const r = await probeProvider(spec);
    expect(r.ok).toBe(true);
    expect(receivedXApiKey).toBe("test-key");
    expect(receivedVersion).toBe("2023-06-01");
    expect(receivedAuth).toBe("");
  });

  it("uses Bearer header for openai protocol", async () => {
    let receivedAuth = "";
    upstream = createServer((req, res) => {
      receivedAuth = String(req.headers.authorization ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"data":[]}');
    });
    const port = await listen(upstream);
    const spec = await specWithKey(`http://127.0.0.1:${port}/v1`, "openai");

    const r = await probeProvider(spec);
    expect(r.ok).toBe(true);
    expect(receivedAuth).toBe("Bearer test-key");
  });

  it("times out and reports unreachable when server hangs", async () => {
    upstream = createServer(() => {
      // never responds
    });
    const port = await listen(upstream);
    const spec = await specWithKey(`http://127.0.0.1:${port}/v1`);

    const start = Date.now();
    const r = await probeProvider(spec, { timeoutMs: 300 });
    const elapsed = Date.now() - start;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unreachable");
    expect(elapsed).toBeLessThan(2000);
  });
});
