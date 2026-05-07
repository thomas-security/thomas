// appendRun fires a fire-and-forget cloud upload. This test exercises the
// uplink module directly: when logged in, it POSTs /v1/runs with the right
// payload; when not, it's a no-op; cloud failures don't propagate.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeIdentity } from "../src/cloud/identity.js";
import { enqueueRun, toWireRun } from "../src/cloud/runs-uplink.js";
import type { RunRecord } from "../src/runs/types.js";

let dir: string;
const ORIG_HOME = process.env.THOMAS_HOME;
const ORIG_BASE_URL = process.env.THOMAS_CLOUD_BASE_URL;
const ORIG_FETCH = globalThis.fetch;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "thomas-uplink-"));
  process.env.THOMAS_HOME = dir;
});

afterEach(async () => {
  if (ORIG_HOME !== undefined) process.env.THOMAS_HOME = ORIG_HOME;
  else delete process.env.THOMAS_HOME;
  if (ORIG_BASE_URL !== undefined) process.env.THOMAS_CLOUD_BASE_URL = ORIG_BASE_URL;
  else delete process.env.THOMAS_CLOUD_BASE_URL;
  globalThis.fetch = ORIG_FETCH;
  await rm(dir, { recursive: true, force: true });
});

const RECORD: RunRecord = {
  runId: "run-123",
  agent: "openclaw",
  startedAt: "2026-05-07T10:00:00.000Z",
  endedAt: "2026-05-07T10:00:01.500Z",
  durationMs: 1500,
  status: "ok",
  inboundProtocol: "openai",
  outboundProvider: "openai",
  outboundModel: "gpt-5.5",
  inputTokens: 100,
  outputTokens: 50,
  cost: 0.0123,
  streamed: true,
  httpStatus: 200,
  errorMessage: null,
  failovers: 0,
  failoverNote: null,
};

describe("toWireRun", () => {
  it("renames `agent` → `agentId` and preserves the rest", () => {
    const wire = toWireRun(RECORD);
    expect(wire.agentId).toBe("openclaw");
    expect(wire.runId).toBe("run-123");
    expect(wire.cost).toBe(0.0123);
    expect((wire as Record<string, unknown>).agent).toBeUndefined();
  });
});

describe("enqueueRun", () => {
  it("is a no-op when ~/.thomas/cloud.json is absent", async () => {
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      return new Response("", { status: 200 });
    };

    enqueueRun(RECORD);
    // Give the background promise a tick to run.
    await new Promise((r) => setTimeout(r, 20));
    expect(called).toBe(false);
  });

  it("posts to /v1/runs with bearer token + correct payload when logged in", async () => {
    process.env.THOMAS_CLOUD_BASE_URL = "http://cloud.test";
    await writeIdentity({
      baseUrl: "http://cloud.test",
      deviceToken: "thomas_dev_secret",
      deviceId: "01TEST_DEVICE000000000000",
      workspaceId: "01TEST_WORKSPACE0000000000",
      loggedInAt: new Date().toISOString(),
    });

    let captured: { url: string; init: RequestInit } | null = null;
    globalThis.fetch = async (input, init) => {
      captured = { url: String(input), init: init ?? {} };
      return new Response(JSON.stringify({ accepted: 1, duplicates: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    enqueueRun(RECORD);
    await new Promise((r) => setTimeout(r, 50));

    expect(captured).not.toBeNull();
    expect(captured!.url).toBe("http://cloud.test/v1/runs");
    expect(captured!.init.method).toBe("POST");
    const headers = new Headers(captured!.init.headers);
    expect(headers.get("authorization")).toBe("Bearer thomas_dev_secret");
    expect(headers.get("content-type")).toBe("application/json");
    const body = JSON.parse(String(captured!.init.body));
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]).toMatchObject({
      runId: "run-123",
      agentId: "openclaw",
      cost: 0.0123,
    });
  });

  it("swallows cloud failures — caller never sees an error", async () => {
    await writeIdentity({
      baseUrl: "http://cloud.test",
      deviceToken: "thomas_dev_secret",
      deviceId: "01TEST_DEVICE000000000000",
      workspaceId: "01TEST_WORKSPACE0000000000",
      loggedInAt: new Date().toISOString(),
    });
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: "boom" }), { status: 500 });

    let unhandled: unknown = null;
    const handler = (reason: unknown) => {
      unhandled = reason;
    };
    process.on("unhandledRejection", handler);

    enqueueRun(RECORD);
    await new Promise((r) => setTimeout(r, 50));

    process.off("unhandledRejection", handler);
    expect(unhandled).toBeNull();
  });
});
