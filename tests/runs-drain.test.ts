// Retry/drain semantics for the runs uplink.
//
//   1. Failed enqueueRun → record lands in runs-pending.jsonl
//   2. `thomas cloud sync-runs` empties pending when cloud succeeds
//   3. Mid-drain server failure → unsent records stay in pending
//   4. Concurrent failure during drain → fresh failures land in the new
//      runs-pending.jsonl, not in the in-flight .draining file
//   5. sync-runs without login → E_CLOUD_NOT_LOGGED_IN
//   6. sync-runs with empty pending → no-op, scanned=0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cloudSyncRuns } from "../src/commands/cloud/sync-runs.js";
import { writeIdentity } from "../src/cloud/identity.js";
import { appendPending, checkoutPending } from "../src/cloud/runs-pending.js";
import { enqueueRun } from "../src/cloud/runs-uplink.js";
import { paths } from "../src/config/paths.js";
import type { RunRecord } from "../src/runs/types.js";
import { captureStdout } from "./_util.js";

let dir: string;
const ORIG_HOME = process.env.THOMAS_HOME;
const ORIG_BASE_URL = process.env.THOMAS_CLOUD_BASE_URL;
const ORIG_FETCH = globalThis.fetch;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "thomas-drain-"));
  process.env.THOMAS_HOME = dir;
  process.env.THOMAS_CLOUD_BASE_URL = "http://cloud.test";
});

afterEach(async () => {
  if (ORIG_HOME !== undefined) process.env.THOMAS_HOME = ORIG_HOME;
  else delete process.env.THOMAS_HOME;
  if (ORIG_BASE_URL !== undefined) process.env.THOMAS_CLOUD_BASE_URL = ORIG_BASE_URL;
  else delete process.env.THOMAS_CLOUD_BASE_URL;
  globalThis.fetch = ORIG_FETCH;
  await rm(dir, { recursive: true, force: true });
});

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: "run-1",
    agent: "openclaw",
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: 0,
    status: "ok",
    inboundProtocol: "openai",
    outboundProvider: "openai",
    outboundModel: "gpt-5.5",
    inputTokens: 0,
    outputTokens: 0,
    cost: 0.01,
    streamed: false,
    httpStatus: 200,
    errorMessage: null,
    failovers: 0,
    failoverNote: null,
    ...overrides,
  };
}

async function loginToCloud(): Promise<void> {
  await writeIdentity({
    baseUrl: "http://cloud.test",
    deviceToken: "thomas_dev_secret",
    deviceId: "01TEST_DEVICE000000000000",
    workspaceId: "01TEST_WORKSPACE0000000000",
    loggedInAt: new Date().toISOString(),
  });
}

describe("enqueueRun on uplink failure", () => {
  it("appends the record to runs-pending.jsonl", async () => {
    await loginToCloud();
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: "boom" }), { status: 500 });

    enqueueRun(record({ runId: "fail-1", startedAt: "2026-05-07T10:00:00.000Z" }));
    await new Promise((r) => setTimeout(r, 50));

    const text = await readFile(paths.runsPending, "utf8").catch(() => "");
    expect(text).toContain('"runId":"fail-1"');
  });

  it("does NOT enqueue when not logged in (no destination yet)", async () => {
    // No writeIdentity. fetch should never even be called.
    let fetchHits = 0;
    globalThis.fetch = async () => {
      fetchHits += 1;
      return new Response("", { status: 200 });
    };
    enqueueRun(record({ runId: "no-login" }));
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchHits).toBe(0);
    const text = await readFile(paths.runsPending, "utf8").catch(() => "");
    expect(text).toBe("");
  });
});

describe("thomas cloud sync-runs", () => {
  it("returns E_CLOUD_NOT_LOGGED_IN when no identity", async () => {
    await writeFile(paths.runsPending, JSON.stringify(record({ runId: "x" })) + "\n");
    const { result, out } = await captureStdout(() => cloudSyncRuns({ json: true }));
    expect(result).toBe(1);
    expect(JSON.parse(out).error.code).toBe("E_CLOUD_NOT_LOGGED_IN");
  });

  it("is a no-op (scanned=0) when pending file is empty / absent", async () => {
    await loginToCloud();
    let fetchHits = 0;
    globalThis.fetch = async () => {
      fetchHits += 1;
      return new Response(JSON.stringify({ accepted: 0, duplicates: 0 }), { status: 200 });
    };
    const { result, out } = await captureStdout(() => cloudSyncRuns({ json: true }));
    expect(result).toBe(0);
    const data = JSON.parse(out).data;
    expect(data).toEqual({ scanned: 0, uploaded: 0, duplicates: 0, remaining: 0 });
    expect(fetchHits).toBe(0);
  });

  it("uploads pending records and clears the file on success", async () => {
    await loginToCloud();
    await appendPending(record({ runId: "p1", startedAt: "2026-05-07T10:00:00.000Z" }));
    await appendPending(record({ runId: "p2", startedAt: "2026-05-07T10:01:00.000Z" }));
    await appendPending(record({ runId: "p3", startedAt: "2026-05-07T10:02:00.000Z" }));

    const captured: unknown[] = [];
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      captured.push(body);
      return new Response(
        JSON.stringify({ accepted: body.runs.length, duplicates: 0 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const { result, out } = await captureStdout(() => cloudSyncRuns({ json: true }));
    expect(result).toBe(0);
    const data = JSON.parse(out).data;
    expect(data).toEqual({ scanned: 3, uploaded: 3, duplicates: 0, remaining: 0 });

    // Pending file should be gone (or empty)
    const text = await readFile(paths.runsPending, "utf8").catch(() => "");
    expect(text).toBe("");
    // The .draining file should also be gone.
    const draining = await readFile(paths.runsPending + ".draining", "utf8").catch(() => null);
    expect(draining).toBeNull();
  });

  it("counts dedup hits as duplicates without resurfacing them in pending", async () => {
    await loginToCloud();
    await appendPending(record({ runId: "dup1", startedAt: "2026-05-07T10:00:00.000Z" }));
    await appendPending(record({ runId: "dup2", startedAt: "2026-05-07T10:01:00.000Z" }));
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ accepted: 0, duplicates: 2 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const { out } = await captureStdout(() => cloudSyncRuns({ json: true }));
    const data = JSON.parse(out).data;
    expect(data).toEqual({ scanned: 2, uploaded: 0, duplicates: 2, remaining: 0 });
    expect(await readFile(paths.runsPending, "utf8").catch(() => "")).toBe("");
  });

  it("on mid-drain server failure, leaves the failed batch + remainder in pending", async () => {
    await loginToCloud();
    // 3 records, but our fetch will fail on the SECOND POST (we rig this by
    // counting calls). With BATCH_SIZE=100, all 3 fit in batch 1 — so we
    // just simulate batch-1 failure with 3 records.
    await appendPending(record({ runId: "p1", startedAt: "2026-05-07T10:00:00.000Z" }));
    await appendPending(record({ runId: "p2", startedAt: "2026-05-07T10:01:00.000Z" }));
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: "boom" }), { status: 500 });

    const { result, out } = await captureStdout(() => cloudSyncRuns({ json: true }));
    expect(result).toBe(0);
    const data = JSON.parse(out).data;
    expect(data.scanned).toBe(2);
    expect(data.uploaded).toBe(0);
    expect(data.remaining).toBe(2);

    // Both records back in pending for next time
    const text = await readFile(paths.runsPending, "utf8");
    expect(text).toContain('"runId":"p1"');
    expect(text).toContain('"runId":"p2"');
    // .draining cleaned up
    const draining = await readFile(paths.runsPending + ".draining", "utf8").catch(() => null);
    expect(draining).toBeNull();
  });

  it("checkoutPending isolates concurrent failures from the in-flight drain", async () => {
    // Simulate the drain's atomic-rename: appendPending after checkoutPending
    // must NOT show up in the records returned by checkoutPending.
    await appendPending(record({ runId: "before-checkout" }));
    const drained = await checkoutPending();
    expect(drained.map((r) => r.runId)).toEqual(["before-checkout"]);

    // A new failure happens during the drain. It should write to a fresh
    // runs-pending.jsonl, NOT to the .draining file we already grabbed.
    await appendPending(record({ runId: "during-drain" }));
    const liveText = await readFile(paths.runsPending, "utf8");
    expect(liveText).toContain('"runId":"during-drain"');
    expect(liveText).not.toContain('"runId":"before-checkout"');
  });
});
