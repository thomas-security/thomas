import { paths } from "./paths.js";
import { readJson, writeJsonAtomic } from "./io.js";

export type ConnectedAgent = {
  shimPath: string;
  originalBinary: string;
  connectedAt: string;
  token: string;
};

type AgentStore = { connected: Record<string, ConnectedAgent> };

export async function readAgents(): Promise<AgentStore> {
  return readJson<AgentStore>(paths.agents, { connected: {} });
}

export async function writeAgents(store: AgentStore): Promise<void> {
  await writeJsonAtomic(paths.agents, store);
}

export async function recordConnect(agentId: string, info: ConnectedAgent): Promise<void> {
  const store = await readAgents();
  store.connected[agentId] = info;
  await writeAgents(store);
}

export async function recordDisconnect(agentId: string): Promise<void> {
  const store = await readAgents();
  delete store.connected[agentId];
  await writeAgents(store);
}

export async function findByToken(token: string): Promise<{ agentId: string } | undefined> {
  const store = await readAgents();
  for (const [agentId, info] of Object.entries(store.connected)) {
    if (info.token === token) return { agentId };
  }
  return undefined;
}
