// End-to-end integration: a real proxy server in front of two fake upstreams.
// Verifies that on a retryable 503 from the primary, the proxy retries on the
// failover target and the agent sees the secondary's response.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { recordConnect } from "../src/config/agents.js";
import { upsertCredential } from "../src/config/credentials.js";
import { setRoute } from "../src/config/routes.js";
import { setPolicy } from "../src/policy/store.js";
import { startServer } from "../src/proxy/server.js";
import { registerCustom } from "../src/providers/registry.js";
import { readRuns } from "../src/runs/store.js";
import type { RunRecord } from "../src/runs/types.js";

// persistRun fires inside the proxy handler's finally block, after res.end() has
// already resolved the client's fetch. Poll until the run lands instead of racing.
async function waitForRuns(expected: number, timeoutMs = 2000): Promise<RunRecord[]> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const records = await readRuns();
    if (records.length >= expected) return records;
    await new Promise((r) => setTimeout(r, 20));
  }
  return readRuns();
}

let dir: string;
const ORIG_THOMAS_HOME = process.env.THOMAS_HOME;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "thomas-proxy-fo-"));
  process.env.THOMAS_HOME = dir;
});

afterEach(async () => {
  if (ORIG_THOMAS_HOME !== undefined) process.env.THOMAS_HOME = ORIG_THOMAS_HOME;
  else delete process.env.THOMAS_HOME;
  await rm(dir, { recursive: true, force: true });
});

function listenEphemeral(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr !== "string") resolve(addr.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function readReqBody(req: Parameters<Parameters<typeof createServer>[0]>[0]): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

describe("proxy in-run failover", () => {
  it("retries on 503 and surfaces the failover target's response", async () => {
    let primaryHits = 0;
    let secondaryHits = 0;
    let secondarySawBody = "";

    const primary = createServer(async (req, res) => {
      primaryHits++;
      await readReqBody(req);
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "overloaded", message: "down" } }));
    });
    const secondary = createServer(async (req, res) => {
      secondaryHits++;
      secondarySawBody = await readReqBody(req);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "msg_123",
          type: "message",
          role: "assistant",
          model: "claude-haiku-4-5",
          content: [{ type: "text", text: "hello from secondary" }],
          usage: { input_tokens: 7, output_tokens: 3 },
        }),
      );
    });

    const primaryPort = await listenEphemeral(primary);
    const secondaryPort = await listenEphemeral(secondary);

    await registerCustom({
      id: "fake-primary",
      protocol: "anthropic",
      originBaseUrl: `http://127.0.0.1:${primaryPort}`,
    });
    await registerCustom({
      id: "fake-secondary",
      protocol: "anthropic",
      originBaseUrl: `http://127.0.0.1:${secondaryPort}`,
    });
    await upsertCredential({ provider: "fake-primary", type: "api_key", key: "sk-fake1" });
    await upsertCredential({ provider: "fake-secondary", type: "api_key", key: "sk-fake2" });

    const token = "thomas-test-failover-token";
    await recordConnect("claude-code", {
      shimPath: join(dir, "bin", "claude"),
      originalBinary: "/usr/bin/claude",
      connectedAt: new Date().toISOString(),
      token,
    });
    await setRoute("claude-code", { provider: "fake-primary", model: "claude-opus-4-7" });
    await setPolicy("claude-code", {
      id: "cost-cascade",
      primary: { provider: "fake-primary", model: "claude-opus-4-7" },
      cascade: [],
      failoverTo: { provider: "fake-secondary", model: "claude-haiku-4-5" },
    });

    const proxy = await startServer(0, "127.0.0.1");
    const proxyAddr = proxy.address();
    const proxyPort = proxyAddr && typeof proxyAddr !== "string" ? proxyAddr.port : 0;

    let resp: Response;
    let body: { content: Array<{ text: string }>; model: string };
    try {
      resp = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
        method: "POST",
        headers: {
          "x-api-key": token,
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "ignored-by-proxy",
          max_tokens: 100,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      body = (await resp.json()) as typeof body;
    } finally {
      await closeServer(proxy);
      await closeServer(primary);
      await closeServer(secondary);
    }

    expect(primaryHits).toBe(1);
    expect(secondaryHits).toBe(1);
    expect(resp.status).toBe(200);
    expect(body.content[0]?.text).toBe("hello from secondary");
    // The proxy rewrites `model` to the FAILOVER target
    expect(secondarySawBody).toContain("claude-haiku-4-5");

    // 1 run record reflecting the final (successful) attempt with failovers=1
    const runs = await waitForRuns(1);
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.failovers).toBe(1);
    expect(run.outboundProvider).toBe("fake-secondary");
    expect(run.outboundModel).toBe("claude-haiku-4-5");
    expect(run.failoverNote).toContain("primary fake-primary/claude-opus-4-7");
    expect(run.failoverNote).toContain("HTTP 503");
    expect(run.status).toBe("ok");
    expect(run.httpStatus).toBe(200);
    expect(run.inputTokens).toBe(7);
    expect(run.outputTokens).toBe(3);
  });

  it("auto-injects stream_options.include_usage on OpenAI-protocol streaming requests", async () => {
    let capturedBody = "";
    const upstream = createServer(async (req, res) => {
      capturedBody = await readReqBody(req);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
    });
    const port = await listenEphemeral(upstream);
    await registerCustom({
      id: "fake-openai",
      protocol: "openai",
      originBaseUrl: `http://127.0.0.1:${port}`,
    });
    await upsertCredential({ provider: "fake-openai", type: "api_key", key: "sk-x" });

    const token = "thomas-test-include-usage-token";
    await recordConnect("codex", {
      shimPath: join(dir, "bin", "codex"),
      originalBinary: "/usr/bin/codex",
      connectedAt: new Date().toISOString(),
      token,
    });
    await setRoute("codex", { provider: "fake-openai", model: "fake-model" });

    const proxy = await startServer(0, "127.0.0.1");
    const proxyAddr = proxy.address();
    const proxyPort = proxyAddr && typeof proxyAddr !== "string" ? proxyAddr.port : 0;

    try {
      const resp = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        // Note: client did NOT send stream_options.include_usage — proxy must inject it
        body: JSON.stringify({
          model: "ignored",
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      await resp.text();
    } finally {
      await closeServer(proxy);
      await closeServer(upstream);
    }

    const upstreamBody = JSON.parse(capturedBody);
    expect(upstreamBody.stream).toBe(true);
    expect(upstreamBody.stream_options).toEqual({ include_usage: true });
  });

  it("respects X-Thomas-Run-Id: two requests with same id aggregate to one task", async () => {
    const upstream = createServer(async (req, res) => {
      await readReqBody(req);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "msg",
          type: "message",
          role: "assistant",
          model: "x",
          content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      );
    });
    const port = await listenEphemeral(upstream);
    await registerCustom({
      id: "fake",
      protocol: "anthropic",
      originBaseUrl: `http://127.0.0.1:${port}`,
    });
    await upsertCredential({ provider: "fake", type: "api_key", key: "sk-x" });

    const token = "thomas-test-runid-token";
    await recordConnect("claude-code", {
      shimPath: join(dir, "bin", "claude"),
      originalBinary: "/usr/bin/claude",
      connectedAt: new Date().toISOString(),
      token,
    });
    await setRoute("claude-code", { provider: "fake", model: "claude-opus-4-7" });

    const proxy = await startServer(0, "127.0.0.1");
    const proxyAddr = proxy.address();
    const proxyPort = proxyAddr && typeof proxyAddr !== "string" ? proxyAddr.port : 0;

    const sharedRunId = "task-aggregation-test-001";
    try {
      for (let i = 0; i < 2; i++) {
        const resp = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
          method: "POST",
          headers: {
            "x-api-key": token,
            "content-type": "application/json",
            "anthropic-version": "2023-06-01",
            "x-thomas-run-id": sharedRunId,
          },
          body: JSON.stringify({
            model: "x",
            max_tokens: 100,
            messages: [{ role: "user", content: "hi" }],
          }),
        });
        await resp.text();
      }
    } finally {
      await closeServer(proxy);
      await closeServer(upstream);
    }

    const records = await waitForRuns(2);
    expect(records).toHaveLength(2);
    expect(records[0]!.runId).toBe(sharedRunId);
    expect(records[1]!.runId).toBe(sharedRunId);
    // Two HTTP calls share the same logical task; aggregation collapses them.
    const { aggregateRecords } = await import("../src/runs/aggregate.js");
    const agg = aggregateRecords(records);
    expect(agg).toHaveLength(1);
    expect(agg[0]!.modelCalls).toBe(2);
    expect(agg[0]!.inputTokens).toBe(20);
    expect(agg[0]!.outputTokens).toBe(10);
  });

  it("does not retry when status is not retryable (401)", async () => {
    let primaryHits = 0;
    let secondaryHits = 0;

    const primary = createServer(async (req, res) => {
      primaryHits++;
      await readReqBody(req);
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "unauthorized" } }));
    });
    const secondary = createServer(async (req, res) => {
      secondaryHits++;
      await readReqBody(req);
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });

    const primaryPort = await listenEphemeral(primary);
    const secondaryPort = await listenEphemeral(secondary);

    await registerCustom({
      id: "fake-primary",
      protocol: "anthropic",
      originBaseUrl: `http://127.0.0.1:${primaryPort}`,
    });
    await registerCustom({
      id: "fake-secondary",
      protocol: "anthropic",
      originBaseUrl: `http://127.0.0.1:${secondaryPort}`,
    });
    await upsertCredential({ provider: "fake-primary", type: "api_key", key: "sk-fake1" });
    await upsertCredential({ provider: "fake-secondary", type: "api_key", key: "sk-fake2" });

    const token = "thomas-test-failover-401-token";
    await recordConnect("claude-code", {
      shimPath: join(dir, "bin", "claude"),
      originalBinary: "/usr/bin/claude",
      connectedAt: new Date().toISOString(),
      token,
    });
    await setRoute("claude-code", { provider: "fake-primary", model: "claude-opus-4-7" });
    await setPolicy("claude-code", {
      id: "cost-cascade",
      primary: { provider: "fake-primary", model: "claude-opus-4-7" },
      cascade: [],
      failoverTo: { provider: "fake-secondary", model: "claude-haiku-4-5" },
    });

    const proxy = await startServer(0, "127.0.0.1");
    const proxyAddr = proxy.address();
    const proxyPort = proxyAddr && typeof proxyAddr !== "string" ? proxyAddr.port : 0;

    let resp: Response;
    try {
      resp = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
        method: "POST",
        headers: {
          "x-api-key": token,
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "x",
          max_tokens: 100,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      await resp.text();
    } finally {
      await closeServer(proxy);
      await closeServer(primary);
      await closeServer(secondary);
    }

    expect(primaryHits).toBe(1);
    expect(secondaryHits).toBe(0); // 401 is not retryable
    expect(resp.status).toBe(401);

    const runs = await waitForRuns(1);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.failovers).toBe(0);
    expect(runs[0]!.failoverNote).toBeNull();
    expect(runs[0]!.status).toBe("error");
    expect(runs[0]!.httpStatus).toBe(401);
  });
});
