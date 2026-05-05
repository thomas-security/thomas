import { homedir } from "node:os";
import { join } from "node:path";

function thomasDir(): string {
  return process.env.THOMAS_HOME ?? join(homedir(), ".thomas");
}

export const paths = {
  get root() {
    return thomasDir();
  },
  get config() {
    return join(thomasDir(), "config.json");
  },
  get credentials() {
    return join(thomasDir(), "credentials.json");
  },
  get routes() {
    return join(thomasDir(), "routes.json");
  },
  get agents() {
    return join(thomasDir(), "agents.json");
  },
  get providers() {
    return join(thomasDir(), "providers.json");
  },
  get bin() {
    return join(thomasDir(), "bin");
  },
  get snapshots() {
    return join(thomasDir(), "snapshots");
  },
  get proxyPid() {
    return join(thomasDir(), "proxy.pid");
  },
  get proxyLog() {
    return join(thomasDir(), "proxy.log");
  },
  get runs() {
    return join(thomasDir(), "runs.jsonl");
  },
  get policies() {
    return join(thomasDir(), "policies.json");
  },
  get prices() {
    return join(thomasDir(), "prices.json");
  },
  // thomas cloud — set on `thomas cloud login`, cleared on `thomas cloud logout`.
  // 0600 perms: holds the device token (exact-once value from /v1/devices/poll).
  get cloud() {
    return join(thomasDir(), "cloud.json");
  },
  // Snapshot pulled from /v1/sync. Read-only from local thomas's perspective —
  // the source of truth lives in the SaaS. Stale tolerated when offline.
  get cloudCache() {
    return join(thomasDir(), "cloud-cache.json");
  },
};

export function home(...segments: string[]): string {
  // Read process.env.HOME at call time, not homedir(). Bun caches the result
  // of os.homedir() after the first call, so a test that sets process.env.HOME
  // mid-process won't see the override otherwise.
  return join(process.env.HOME ?? homedir(), ...segments);
}
