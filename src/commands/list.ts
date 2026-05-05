import { listAgents } from "../agents/registry.js";
import { runJson } from "../cli/json.js";
import type { ListData, ProviderInfo } from "../cli/output.js";
import { credentialSourceOf, daemonStateOf, proxyStateOf } from "../cli/state.js";
import { readAgents } from "../config/agents.js";
import { readConfig } from "../config/config.js";
import { readCredentials } from "../config/credentials.js";
import { readRoutes } from "../config/routes.js";
import { getStatus } from "../daemon/lifecycle.js";
import { listProviders } from "../providers/registry.js";

export async function list(opts: { json: boolean }): Promise<number> {
  return runJson({
    command: "list",
    json: opts.json,
    fetch: fetchListData,
    printHuman: printList,
  });
}

async function fetchListData(): Promise<ListData> {
  const cfg = await readConfig();
  const [agentsState, routes, credentialsStore, providersAll, proxy, daemon] = await Promise.all([
    readAgents(),
    readRoutes(),
    readCredentials(),
    listProviders(),
    getStatus(cfg.port),
    daemonStateOf(),
  ]);
  const credByProvider = new Map(credentialsStore.providers.map((c) => [c.provider, c]));

  const agents = listAgents().map((spec) => {
    const conn = agentsState.connected[spec.id];
    return {
      id: spec.id,
      connected: !!conn,
      shimPath: conn?.shimPath ?? null,
    };
  });

  const providers: ProviderInfo[] = providersAll.map((p) => {
    const cred = credByProvider.get(p.id);
    return {
      id: p.id,
      protocol: p.protocol,
      baseUrl: p.originBaseUrl,
      isBuiltin: !p.custom,
      isCustom: !!p.custom,
      hasCredentials: !!cred,
      credentialSource: credentialSourceOf(cred),
      knownModels: null,
    };
  });

  const routeEntries = Object.entries(routes.routes).map(([agent, r]) => ({
    agent: agent as ListData["routes"][number]["agent"],
    target: { provider: r.provider, model: r.model },
  }));

  return {
    proxy: proxyStateOf(proxy, cfg.port, cfg.host),
    daemon,
    agents,
    providers,
    routes: routeEntries,
  };
}

function printList(data: ListData): void {
  const specs = listAgents();
  const byId = new Map(specs.map((s) => [s.id, s]));
  const routesByAgent = new Map(data.routes.map((r) => [r.agent, r.target]));

  console.log("Agents");
  for (const a of data.agents) {
    const displayName = byId.get(a.id)?.displayName ?? a.id;
    if (!a.connected) {
      console.log(`  ${displayName.padEnd(16)} not connected`);
      continue;
    }
    const target = routesByAgent.get(a.id);
    const routeStr = target ? `${target.provider}/${target.model}` : "no route";
    console.log(`  ${displayName.padEnd(16)} connected → ${routeStr}`);
  }

  console.log("");
  console.log("Providers");
  const configured = data.providers.filter((p) => p.hasCredentials);
  if (configured.length === 0) {
    console.log("  (none configured)");
  } else {
    for (const p of configured) {
      const tag = p.isCustom ? " (custom)" : "";
      console.log(`  ${p.id.padEnd(16)} ${p.credentialSource ?? "—"}${tag}`);
    }
  }

  console.log("");
  console.log("Proxy");
  if (data.proxy.running) {
    console.log(`  ${data.proxy.url}   running (pid=${data.proxy.pid})`);
  } else {
    console.log(`  ${data.proxy.url}   not running`);
  }
  console.log(`  supervision:  ${formatDaemon(data.daemon)}`);
}

function formatDaemon(d: ListData["daemon"]): string {
  if (d.platform === "unsupported") return "not available on this platform";
  if (!d.installed) return "lazy on-demand (run `thomas daemon install` for persistence)";
  return `${d.platform} ${d.running ? "active" : "inactive"}`;
}
