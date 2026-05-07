import { listAgents } from "../agents/registry.js";
import { runJson } from "../cli/json.js";
import type { AgentRecent, StatusData } from "../cli/output.js";
import { proxyStateOf } from "../cli/state.js";
import { readAgents } from "../config/agents.js";
import { readConfig } from "../config/config.js";
import { readRoutes } from "../config/routes.js";
import { getStatus } from "../daemon/lifecycle.js";
import { getMeter } from "../metering/registry.js";
import { decide } from "../policy/decide.js";
import { readPolicies } from "../policy/store.js";

const EMPTY_RECENT: AgentRecent = {
  requests24h: null,
  errors24h: null,
  spendDay: null,
  lastRequestAt: null,
  lastError: null,
};

export async function status(opts: { json: boolean }): Promise<number> {
  return runJson({
    command: "status",
    json: opts.json,
    fetch: fetchStatusData,
    printHuman: printStatus,
  });
}

async function fetchStatusData(): Promise<StatusData> {
  const cfg = await readConfig();
  const [agentsState, routes, proxy, policies] = await Promise.all([
    readAgents(),
    readRoutes(),
    getStatus(cfg.port),
    readPolicies(),
  ]);

  const agents = await Promise.all(
    listAgents().map(async (spec) => {
      const conn = agentsState.connected[spec.id];
      const route = routes.routes[spec.id];
      const target = route ? { provider: route.provider, model: route.model } : null;
      const policy = policies.policies[spec.id];
      let effective = target;
      let policySnapshot: { id: string; reason: string } | null = null;
      let spendDay: number | null = null;
      if (policy && conn) {
        const usage = await getMeter(spec.id).usageInWindow(spec.id, "day");
        spendDay = usage.spend;
        const decision = decide(policy, usage);
        effective = decision.target;
        policySnapshot = { id: decision.policyId ?? policy.id, reason: decision.reason };
      }
      return {
        id: spec.id,
        connected: !!conn,
        route: target,
        effective,
        policy: policySnapshot,
        recent: { ...EMPTY_RECENT, spendDay },
      };
    }),
  );

  return {
    proxy: proxyStateOf(proxy, cfg.port, cfg.host),
    spend: { day: null, month: null, currency: "USD" },
    agents,
  };
}

function printStatus(data: StatusData): void {
  const specs = listAgents();
  const byId = new Map(specs.map((s) => [s.id, s]));

  if (data.proxy.running) {
    console.log(`Proxy: running  ${data.proxy.url}  pid=${data.proxy.pid}`);
  } else {
    console.log(`Proxy: not running  ${data.proxy.url}`);
  }
  console.log("");
  console.log("Agents");
  for (const a of data.agents) {
    const display = byId.get(a.id)?.displayName ?? a.id;
    if (!a.connected) {
      console.log(`  ${display.padEnd(16)} not connected`);
      continue;
    }
    if (a.effective) {
      console.log(`  ${display.padEnd(16)} ${a.effective.provider}/${a.effective.model}`);
    } else {
      console.log(`  ${display.padEnd(16)} connected (no route)`);
    }
  }
}
