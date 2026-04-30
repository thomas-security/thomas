import { spawn } from "node:child_process";
import { open, readFile, unlink } from "node:fs/promises";
import { paths } from "../config/paths.js";
import { resolveService } from "./service.js";

export type ProxyStatus =
  | { running: true; pid: number; port: number }
  | { running: false; reason: string };

export async function getStatus(port: number): Promise<ProxyStatus> {
  const pid = await readPid();
  if (pid !== undefined && processAlive(pid) && (await pingHealth(port))) {
    return { running: true, pid, port };
  }
  if (pid !== undefined && !processAlive(pid)) {
    await unlink(paths.proxyPid).catch(() => undefined);
  }
  return { running: false, reason: "not running" };
}

export async function ensureRunning(port: number): Promise<ProxyStatus> {
  const current = await getStatus(port);
  if (current.running) return current;

  try {
    const svc = resolveService();
    const status = await svc.status();
    if (status.installed) {
      await svc.start().catch(() => undefined);
      for (let i = 0; i < 30; i++) {
        await sleep(150);
        if (await pingHealth(port)) {
          const pid = await readPid();
          return { running: true, pid: pid ?? -1, port };
        }
      }
      return { running: false, reason: "supervised service started but health check timed out" };
    }
  } catch {
    // Unsupported platform — fall through to ad-hoc spawn
  }

  return spawnDetached(port);
}

export async function stop(): Promise<{ stopped: boolean }> {
  const pid = await readPid();
  if (pid === undefined || !processAlive(pid)) {
    await unlink(paths.proxyPid).catch(() => undefined);
    return { stopped: false };
  }
  process.kill(pid, "SIGTERM");
  await unlink(paths.proxyPid).catch(() => undefined);
  return { stopped: true };
}

async function readPid(): Promise<number | undefined> {
  const raw = await readFile(paths.proxyPid, "utf8").catch(() => undefined);
  if (!raw) return undefined;
  const pid = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(pid) ? pid : undefined;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function pingHealth(port: number): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1000);
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: ctrl.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

async function spawnDetached(port: number): Promise<ProxyStatus> {
  const logFd = await open(paths.proxyLog, "a").then((h) => h.fd);
  const child = spawn(
    process.execPath,
    [process.argv[1]!, "proxy", "serve", "--port", String(port)],
    {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: process.env,
    },
  );
  child.unref();
  for (let i = 0; i < 20; i++) {
    await sleep(100);
    if (await pingHealth(port)) {
      return { running: true, pid: child.pid ?? -1, port };
    }
  }
  return { running: false, reason: "spawned but health check timed out" };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
