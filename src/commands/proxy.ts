import { unlink } from "node:fs/promises";
import { runJson } from "../cli/json.js";
import type { ProxyStatusData } from "../cli/output.js";
import { proxyStateOf } from "../cli/state.js";
import { readConfig } from "../config/config.js";
import { paths } from "../config/paths.js";
import { ensureRunning, getStatus, stop } from "../daemon/lifecycle.js";
import { startServer } from "../proxy/server.js";

export async function proxyServe(portOverride?: number): Promise<never> {
  const cfg = await readConfig();
  const port = portOverride ?? cfg.port;
  const server = await startServer(port, cfg.host);

  const shutdown = () => {
    server.close();
    unlink(paths.proxyPid)
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return new Promise<never>(() => {
    // Block forever; signal handlers exit the process.
  });
}

export async function proxyStart(portOverride?: number): Promise<number> {
  const cfg = await readConfig();
  const port = portOverride ?? cfg.port;
  const status = await ensureRunning(port);
  if (status.running) return 0;
  console.error(`thomas proxy: failed to start (${status.reason})`);
  return 1;
}

export async function proxyStatus(opts: { json: boolean }): Promise<number> {
  return runJson({
    command: "proxy",
    json: opts.json,
    fetch: fetchProxyStatus,
    printHuman: printProxyStatus,
  });
}

async function fetchProxyStatus(): Promise<ProxyStatusData> {
  const cfg = await readConfig();
  const status = await getStatus(cfg.port);
  return proxyStateOf(status, cfg.port, cfg.host);
}

function printProxyStatus(s: ProxyStatusData): void {
  if (s.running) {
    console.log(`running  pid=${s.pid}  port=${s.port}`);
  } else {
    console.log(`not running  port=${s.port}`);
  }
}

export async function proxyStop(): Promise<number> {
  const result = await stop();
  console.log(result.stopped ? "stopped" : "not running");
  return 0;
}
