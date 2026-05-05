// End-to-end exercise of `thomas cloud` against a fake thomas-cloud server.
//
// We spin up an HTTP server that mimics the device-code grant + /v1/sync.
// Then we drive each CLI command and check both the persisted state on disk
// and the JSON output the agent will see.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cloudLogin } from "../src/commands/cloud/login.js";
import { cloudLogout } from "../src/commands/cloud/logout.js";
import { cloudSync } from "../src/commands/cloud/sync.js";
import { cloudWhoami } from "../src/commands/cloud/whoami.js";
import { readJson } from "../src/config/io.js";
import { paths } from "../src/config/paths.js";
import type { CloudIdentity } from "../src/cloud/types.js";

import { captureStdout } from "./_util.js";

let dir: string;
const ORIG_THOMAS_HOME = process.env.THOMAS_HOME;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "thomas-cloud-"));
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
      const addr = server.address();
      if (addr && typeof addr !== "string") resolve(addr.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function readBody(req: Parameters<Parameters<typeof createServer>[0]>[0]): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Fake thomas-cloud — implements just enough of the API to drive these tests.
 * The /poll endpoint returns "authorization_pending" until you call .approve()
 * on the returned controller, then returns a real device_token.
 */
function fakeCloud() {
  let pendingDeviceCode: string | null = null;
  let approved = false;
  let issuedToken = "thomas_dev_fake_" + Math.random().toString(36).slice(2);
  const requests: Array<{ method: string; url: string; auth: string | null }> = [];

  const server = createServer(async (req, res) => {
    requests.push({
      method: req.method ?? "",
      url: req.url ?? "",
      auth: (req.headers.authorization as string) ?? null,
    });

    if (req.url === "/v1/devices/begin" && req.method === "POST") {
      pendingDeviceCode = "devcode_abcdef";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          device_code: pendingDeviceCode,
          user_code: "ABCD2345",
          verification_uri: "http://web.example/devices",
          verification_uri_complete: "http://web.example/devices?code=ABCD2345",
          interval: 1, // tests want to poll fast
          expires_in: 60,
        }),
      );
      return;
    }

    if (req.url === "/v1/devices/poll" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      if (body.device_code !== pendingDeviceCode) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ detail: { error: "invalid_grant" } }));
        return;
      }
      if (!approved) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ detail: { error: "authorization_pending" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          device_token: issuedToken,
          workspace_id: "01TEST_WORKSPACE_ULID00000",
          device_id: "01TEST_DEVICE_ULID0000000",
        }),
      );
      return;
    }

    if (req.url === "/v1/sync" && req.method === "GET") {
      // Require auth header.
      if (!req.headers.authorization?.includes("Bearer ")) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ detail: { error: "unauthenticated" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          schemaVersion: 1,
          policies: [{ id: "p-1" }],
          bundles: [],
          bindings: [{ agent: "claude-code", target: "anthropic/claude-haiku" }],
          providers: [],
          redactRulesVersion: "v0",
        }),
      );
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ detail: { error: "not_found" } }));
  });

  return {
    server,
    approve: () => {
      approved = true;
    },
    issuedToken: () => issuedToken,
    requests,
  };
}

describe("thomas cloud login → whoami → sync → logout", () => {
  it("walks the full happy path", async () => {
    const fake = fakeCloud();
    const port = await listen(fake.server);
    try {
      // Approve before login starts polling — interval=1s so the first poll succeeds.
      fake.approve();
      const loginExit = await cloudLogin({
        baseUrl: `http://127.0.0.1:${port}`,
        label: "test-host",
      });
      expect(loginExit).toBe(0);

      // cloud.json was written
      expect(existsSync(paths.cloud)).toBe(true);
      const identity = await readJson<CloudIdentity | null>(paths.cloud, null);
      expect(identity).not.toBeNull();
      expect(identity!.deviceToken).toBe(fake.issuedToken());
      expect(identity!.workspaceId).toBe("01TEST_WORKSPACE_ULID00000");

      // whoami JSON
      const { result, out } = await captureStdout(() => cloudWhoami({ json: true }));
      expect(result).toBe(0);
      const whoami = JSON.parse(out);
      expect(whoami.command).toBe("cloud.whoami");
      expect(whoami.data.loggedIn).toBe(true);
      expect(whoami.data.workspaceId).toBe("01TEST_WORKSPACE_ULID00000");
      expect(whoami.data.lastSyncAt).toBeNull();

      // sync JSON — should pull the snapshot and update last_sync
      const sync = await captureStdout(() => cloudSync({ json: true }));
      expect(sync.result).toBe(0);
      const syncBody = JSON.parse(sync.out);
      expect(syncBody.command).toBe("cloud.sync");
      expect(syncBody.data.policiesCount).toBe(1);
      expect(syncBody.data.bindingsCount).toBe(1);
      expect(syncBody.data.redactRulesVersion).toBe("v0");

      // cache file written
      expect(existsSync(paths.cloudCache)).toBe(true);
      const cache = await readJson<{ policies: unknown[]; syncedAt: string }>(
        paths.cloudCache,
        { policies: [], syncedAt: "" },
      );
      expect(cache.policies).toHaveLength(1);
      expect(cache.syncedAt).toBeTruthy();

      // whoami again — lastSyncAt should now be populated
      const after = await captureStdout(() => cloudWhoami({ json: true }));
      expect(JSON.parse(after.out).data.lastSyncAt).toBeTruthy();

      // /v1/sync request carried Bearer auth
      const syncReq = fake.requests.find((r) => r.url === "/v1/sync");
      expect(syncReq?.auth).toBe(`Bearer ${fake.issuedToken()}`);

      // logout removes cloud.json
      const logout = await captureStdout(() => cloudLogout({ json: true }));
      expect(logout.result).toBe(0);
      expect(JSON.parse(logout.out).data.wasLoggedIn).toBe(true);
      expect(existsSync(paths.cloud)).toBe(false);

      // logout again is idempotent (wasLoggedIn=false)
      const logout2 = await captureStdout(() => cloudLogout({ json: true }));
      expect(logout2.result).toBe(0);
      expect(JSON.parse(logout2.out).data.wasLoggedIn).toBe(false);
    } finally {
      await closeServer(fake.server);
    }
  });

  it("login errors out if already logged in", async () => {
    const fake = fakeCloud();
    const port = await listen(fake.server);
    try {
      fake.approve();
      const first = await cloudLogin({ baseUrl: `http://127.0.0.1:${port}` });
      expect(first).toBe(0);
      // Second attempt should fail without re-issuing a device code.
      const before = fake.requests.length;
      const second = await cloudLogin({ baseUrl: `http://127.0.0.1:${port}` });
      expect(second).toBe(1);
      // Didn't hit /devices/begin a second time.
      expect(fake.requests.length).toBe(before);
    } finally {
      await closeServer(fake.server);
    }
  });

  it("sync without login surfaces E_CLOUD_NOT_LOGGED_IN", async () => {
    const { result, out } = await captureStdout(() => cloudSync({ json: true }));
    expect(result).toBe(1);
    const parsed = JSON.parse(out);
    expect(parsed.command).toBe("cloud.sync");
    expect(parsed.error.code).toBe("E_CLOUD_NOT_LOGGED_IN");
  });

  it("whoami when not logged in returns loggedIn=false (exit 0)", async () => {
    const { result, out } = await captureStdout(() => cloudWhoami({ json: true }));
    expect(result).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.data.loggedIn).toBe(false);
    expect(parsed.data.workspaceId).toBeNull();
    expect(parsed.data.deviceId).toBeNull();
  });

  it("sync surfaces E_CLOUD_UNAUTHORIZED on 401", async () => {
    // Server returns 401 unconditionally — simulates a revoked token.
    const server = createServer((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ detail: { error: "unauthenticated" } }));
    });
    const port = await listen(server);
    try {
      // Stash a fake identity directly so sync has a token to send.
      const { writeIdentity } = await import("../src/cloud/identity.js");
      await writeIdentity({
        baseUrl: `http://127.0.0.1:${port}`,
        deviceToken: "stale-token",
        deviceId: "dev",
        workspaceId: "ws",
        loggedInAt: new Date().toISOString(),
      });

      const { result, out } = await captureStdout(() => cloudSync({ json: true }));
      expect(result).toBe(1);
      expect(JSON.parse(out).error.code).toBe("E_CLOUD_UNAUTHORIZED");
    } finally {
      await closeServer(server);
    }
  });
});
