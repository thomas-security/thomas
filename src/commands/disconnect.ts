import { readAgents, recordDisconnect } from "../config/agents.js";
import { deleteSnapshot, readSnapshot } from "../config/snapshots.js";
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

  const snapshot = await readSnapshot(spec.id);
  if (snapshot && spec.revertConfig) {
    await spec.revertConfig(snapshot);
    await deleteSnapshot(spec.id);
  }

  await removeShim(spec);
  await recordDisconnect(agentId);
  const note = snapshot ? "config restored, shim removed" : "shim removed";
  console.log(`Disconnected ${spec.displayName}. ${note}.`);
  return 0;
}
