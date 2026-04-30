import { readConfig } from "../config/config.js";
import { defaultInstallParams, resolveService } from "../daemon/service.js";

export async function daemonInstall(): Promise<number> {
  const cfg = await readConfig();
  let svc;
  try {
    svc = resolveService();
  } catch (err) {
    console.error(String(err));
    return 1;
  }
  console.log(`Installing thomas as a ${svc.platformLabel}…`);
  try {
    await svc.install(defaultInstallParams(cfg.port));
  } catch (err) {
    console.error(`thomas: install failed — ${err}`);
    return 1;
  }
  const status = await svc.status();
  console.log(
    `Installed: ${svc.label}${status.running ? " (running)" : status.detail ? ` (${status.detail})` : ""}`,
  );
  console.log("The proxy now starts at login and is restarted on failure.");
  return 0;
}

export async function daemonUninstall(): Promise<number> {
  let svc;
  try {
    svc = resolveService();
  } catch (err) {
    console.error(String(err));
    return 1;
  }
  console.log(`Uninstalling thomas ${svc.platformLabel}…`);
  try {
    await svc.uninstall();
  } catch (err) {
    console.error(`thomas: uninstall failed — ${err}`);
    return 1;
  }
  console.log("Uninstalled. The proxy now runs in lazy on-demand mode (started by shims).");
  return 0;
}

export async function daemonStatus(): Promise<number> {
  let svc;
  try {
    svc = resolveService();
  } catch (err) {
    console.log(String(err));
    return 0;
  }
  const status = await svc.status();
  console.log(svc.platformLabel);
  if (!status.installed) {
    console.log("  not installed (lazy on-demand mode)");
    return 0;
  }
  console.log(`  label:   ${svc.label}`);
  console.log(`  running: ${status.running ? "yes" : "no"}${status.detail ? `  (${status.detail})` : ""}`);
  return 0;
}
