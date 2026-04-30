import { unlink } from "node:fs/promises";
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

export async function proxyEnsure(portOverride?: number): Promise<number> {
  const cfg = await readConfig();
  const port = portOverride ?? cfg.port;
  const status = await ensureRunning(port);
  if (status.running) return 0;
  console.error(`thomas proxy: failed to start (${status.reason})`);
  return 1;
}

export async function proxyStatus(): Promise<number> {
  const cfg = await readConfig();
  const status = await getStatus(cfg.port);
  if (status.running) {
    console.log(`running  pid=${status.pid}  port=${status.port}`);
    return 0;
  }
  console.log(`not running  (${status.reason})`);
  return 1;
}

export async function proxyStop(): Promise<number> {
  const result = await stop();
  console.log(result.stopped ? "stopped" : "not running");
  return 0;
}
