import { ThomasError, runJson } from "../cli/json.js";
import type {
  DaemonInstallData,
  DaemonStatusData,
  DaemonUninstallData,
} from "../cli/output.js";
import { daemonStateOf, proxyStateOf } from "../cli/state.js";
import { readConfig } from "../config/config.js";
import { getStatus } from "../daemon/lifecycle.js";
import { defaultInstallParams, resolveService } from "../daemon/service.js";

export async function daemonInstall(opts: { json: boolean }): Promise<number> {
  return runJson({
    command: "daemon.install",
    json: opts.json,
    fetch: doDaemonInstall,
    printHuman: (d) => {
      console.log(`Installed: ${d.label}${d.running ? " (running)" : ""}`);
      console.log("The proxy now starts at login and is restarted on failure.");
    },
  });
}

async function doDaemonInstall(): Promise<DaemonInstallData> {
  const cfg = await readConfig();
  const svc = resolveOrThrow();
  try {
    await svc.install(defaultInstallParams(cfg.port));
  } catch (err) {
    throw new ThomasError({
      code: "E_INTERNAL",
      message: `daemon install failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  const status = await svc.status();
  const daemon = await daemonStateOf();
  return {
    platform: daemon.platform,
    label: svc.label,
    running: status.running,
  };
}

export async function daemonUninstall(opts: { json: boolean }): Promise<number> {
  return runJson({
    command: "daemon.uninstall",
    json: opts.json,
    fetch: doDaemonUninstall,
    printHuman: (d) => {
      if (d.removed)
        console.log("Uninstalled. The proxy now runs in lazy on-demand mode (started by shims).");
      else console.log("Daemon was not installed.");
    },
  });
}

async function doDaemonUninstall(): Promise<DaemonUninstallData> {
  const svc = resolveOrThrow();
  const before = await svc.status();
  if (!before.installed) return { removed: false };
  try {
    await svc.uninstall();
  } catch (err) {
    throw new ThomasError({
      code: "E_INTERNAL",
      message: `daemon uninstall failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  return { removed: true };
}

function resolveOrThrow() {
  try {
    return resolveService();
  } catch (err) {
    throw new ThomasError({
      code: "E_INVALID_ARG",
      message: err instanceof Error ? err.message : String(err),
      remediation: "daemon supervision is not supported on this platform",
    });
  }
}

export async function daemonStatus(opts: { json: boolean }): Promise<number> {
  return runJson({
    command: "daemon",
    json: opts.json,
    fetch: fetchDaemonStatus,
    printHuman: printDaemonStatus,
  });
}

async function fetchDaemonStatus(): Promise<DaemonStatusData> {
  const cfg = await readConfig();
  const [daemon, proxy] = await Promise.all([daemonStateOf(), getStatus(cfg.port)]);
  return { ...daemon, proxy: proxyStateOf(proxy, cfg.port, cfg.host) };
}

function printDaemonStatus(d: DaemonStatusData): void {
  if (d.platform === "unsupported") {
    console.log("daemon supervision not supported on this platform");
    return;
  }
  console.log(d.platform);
  if (!d.installed) {
    console.log("  not installed (lazy on-demand mode)");
    return;
  }
  console.log(`  label:   ${d.label}`);
  console.log(`  running: ${d.running ? "yes" : "no"}`);
}
