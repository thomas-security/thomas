import { readAgents, recordDisconnect } from "../config/agents.js";
import { getAgent } from "../agents/registry.js";
import { removeShim } from "../shim/install.js";

export async function disconnect(agentId: string): Promise<number> {
  const spec = getAgent(agentId);
  if (!spec) {
    console.error(`thomas: unknown agent '${agentId}'`);
    return 1;
  }
  const store = await readAgents();
  if (!store.connected[agentId]) {
    console.log(`${spec.displayName} is not connected.`);
    return 0;
  }
  await removeShim(spec);
  await recordDisconnect(agentId);
  console.log(`Disconnected ${spec.displayName}. Original binary remains untouched.`);
  return 0;
}
