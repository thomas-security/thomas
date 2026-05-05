import { getAgent } from "../agents/registry.js";
import type { AgentId } from "../agents/types.js";
import { ThomasError, runJson } from "../cli/json.js";
import type { RouteData } from "../cli/output.js";
import { readAgents } from "../config/agents.js";
import { getRoute, parseRouteSpec, setRoute } from "../config/routes.js";
import { getProvider } from "../providers/registry.js";

export async function route(
  agentId: string,
  spec: string,
  opts: { json: boolean },
): Promise<number> {
  return runJson({
    command: "route",
    json: opts.json,
    fetch: () => doRoute(agentId, spec),
    printHuman: (d) => {
      console.log(`Route set: ${d.agent} → ${d.current.provider}/${d.current.model}`);
    },
  });
}

async function doRoute(agentId: string, spec: string): Promise<RouteData> {
  const agent = getAgent(agentId);
  if (!agent) {
    throw new ThomasError({
      code: "E_AGENT_NOT_FOUND",
      message: `unknown agent '${agentId}'`,
      remediation: "Run `thomas doctor` to see installed agents",
      details: { requested: agentId, known: ["claude-code", "codex", "openclaw", "hermes"] },
    });
  }
  const parsed = parseRouteSpec(spec);
  if (!parsed) {
    throw new ThomasError({
      code: "E_INVALID_ARG",
      message: `route spec must be in 'provider/model' form (got '${spec}')`,
      details: { arg: "spec", value: spec },
    });
  }
  const provider = await getProvider(parsed.provider);
  if (!provider) {
    throw new ThomasError({
      code: "E_PROVIDER_NOT_FOUND",
      message: `unknown provider '${parsed.provider}'`,
      remediation: "Run `thomas providers --json` to see registered providers",
      details: { requested: parsed.provider },
    });
  }
  if (provider.protocol !== agent.protocol && parsed.model === "passthrough") {
    throw new ThomasError({
      code: "E_INVALID_ARG",
      message: "'passthrough' model is only valid same-protocol; specify a real provider model",
      details: { agentProtocol: agent.protocol, providerProtocol: provider.protocol },
    });
  }
  const connected = await readAgents();
  if (!connected.connected[agentId]) {
    throw new ThomasError({
      code: "E_AGENT_NOT_CONNECTED",
      message: `${agent.displayName} is not connected`,
      remediation: `Run \`thomas connect ${agentId}\` first`,
      details: { agent: agentId },
    });
  }
  const previous = await getRoute(agentId);
  await setRoute(agentId, parsed);
  return {
    agent: agentId as AgentId,
    previous: previous ? { provider: previous.provider, model: previous.model } : null,
    current: { provider: parsed.provider, model: parsed.model },
  };
}
