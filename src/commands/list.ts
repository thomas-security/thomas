import { readAgents } from "../config/agents.js";
import { readConfig } from "../config/config.js";
import { readCredentials } from "../config/credentials.js";
import { readRoutes } from "../config/routes.js";
import { listAgents } from "../agents/registry.js";
import { getStatus } from "../daemon/lifecycle.js";
import { resolveService } from "../daemon/service.js";

export async function list(): Promise<void> {
  const cfg = await readConfig();
  const [agentsState, routes, credentials, status] = await Promise.all([
    readAgents(),
    readRoutes(),
    readCredentials(),
    getStatus(cfg.port),
  ]);

  console.log("Agents");
  for (const spec of listAgents()) {
    const conn = agentsState.connected[spec.id];
    const route = routes.routes[spec.id];
    if (!conn) {
      console.log(`  ${spec.displayName.padEnd(16)} not connected`);
      continue;
    }
    const target = route ? `${route.provider}/${route.model}` : "no route";
    console.log(`  ${spec.displayName.padEnd(16)} connected → ${target}`);
  }

  console.log("");
  console.log("Providers");
  if (credentials.providers.length === 0) {
    console.log("  (none configured)");
  } else {
    for (const cred of credentials.providers) {
      const source = cred.key
        ? "api_key"
        : cred.access
          ? "oauth"
          : cred.keyRef
            ? `${cred.keyRef.source}:${cred.keyRef.id}`
            : "?";
      console.log(`  ${cred.provider.padEnd(16)} ${source}`);
    }
  }

  console.log("");
  console.log("Proxy");
  if (status.running) {
    console.log(`  http://${cfg.host}:${cfg.port}   running (pid=${status.pid})`);
  } else {
    console.log(`  http://${cfg.host}:${cfg.port}   not running`);
  }

  let daemonLine = "  supervision:  not available on this platform";
  try {
    const svc = resolveService();
    const svcStatus = await svc.status();
    if (!svcStatus.installed) {
      daemonLine = `  supervision:  lazy on-demand (run \`thomas daemon install\` for persistence)`;
    } else {
      daemonLine = `  supervision:  ${svc.platformLabel} ${svcStatus.running ? "active" : "inactive"}`;
    }
  } catch {
    // unsupported platform
  }
  console.log(daemonLine);
}
