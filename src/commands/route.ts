import { readAgents } from "../config/agents.js";
import { parseRouteSpec, setRoute } from "../config/routes.js";
import { getAgent } from "../agents/registry.js";
import { getProvider } from "../providers/registry.js";

export async function route(agentId: string, spec: string): Promise<number> {
  const agent = getAgent(agentId);
  if (!agent) {
    console.error(`thomas: unknown agent '${agentId}'`);
    return 1;
  }
  const parsed = parseRouteSpec(spec);
  if (!parsed) {
    console.error(`thomas: route spec must be in 'provider/model' form (got '${spec}')`);
    return 1;
  }
  const provider = await getProvider(parsed.provider);
  if (!provider) {
    console.error(`thomas: unknown provider '${parsed.provider}'`);
    return 1;
  }
  if (provider.protocol !== agent.protocol && parsed.model === "passthrough") {
    console.error(
      "thomas: 'passthrough' model is only valid same-protocol; specify a real provider model.",
    );
    return 1;
  }
  const connected = await readAgents();
  if (!connected.connected[agentId]) {
    console.error(`thomas: ${agent.displayName} is not connected. Run \`thomas connect ${agentId}\` first.`);
    return 1;
  }
  await setRoute(agentId, parsed);
  console.log(`Route set: ${agentId} → ${parsed.provider}/${parsed.model}`);
  return 0;
}
