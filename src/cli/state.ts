// Shared converters from internal runtime state to public output schema.
// Keep these pure: same inputs → same outputs, no I/O. The commands fetch the
// raw state, then call these to map it into the public shape.

import type { Credential } from "../config/credentials.js";
import type { ProxyStatus } from "../daemon/lifecycle.js";
import { resolveService } from "../daemon/service.js";
import type { DaemonState, ProxyState } from "./output.js";

export function proxyStateOf(status: ProxyStatus, defaultPort: number, host: string): ProxyState {
  if (status.running) {
    return {
      running: true,
      pid: status.pid,
      port: status.port,
      url: `http://${host}:${status.port}`,
      startedAt: null,
      uptimeSeconds: null,
    };
  }
  return {
    running: false,
    pid: null,
    port: defaultPort,
    url: `http://${host}:${defaultPort}`,
    startedAt: null,
    uptimeSeconds: null,
  };
}

export async function daemonStateOf(): Promise<DaemonState> {
  const platform = platformId();
  if (platform === "unsupported") {
    return { installed: false, platform, label: null, running: null };
  }
  let svc;
  try {
    svc = resolveService();
  } catch {
    return { installed: false, platform: "unsupported", label: null, running: null };
  }
  const status = await svc.status();
  return {
    installed: status.installed,
    platform,
    label: svc.label,
    running: status.installed ? status.running : null,
  };
}

function platformId(): DaemonState["platform"] {
  if (process.platform === "darwin") return "launchd";
  if (process.platform === "linux") return "systemd";
  if (process.platform === "win32") return "scheduled-task";
  return "unsupported";
}

export function credentialSourceOf(
  c: Credential | undefined,
): "thomas-store" | "env" | "keychain" | null {
  if (!c) return null;
  if (c.keyRef?.source === "env") return "env";
  // We don't currently distinguish keychain-origin in the store; future field.
  return "thomas-store";
}
