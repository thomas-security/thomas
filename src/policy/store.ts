import type { AgentId } from "../agents/types.js";
import { readJson, writeJsonAtomic } from "../config/io.js";
import { paths } from "../config/paths.js";
import type { PoliciesStore, PolicyConfig } from "./types.js";

export async function readPolicies(): Promise<PoliciesStore> {
  // fresh default each call — readJson returns the default by reference, and
  // setPolicy mutates the store, so a shared module-level default would leak.
  return readJson<PoliciesStore>(paths.policies, { policies: {} });
}

export async function getPolicy(agentId: AgentId): Promise<PolicyConfig | undefined> {
  const store = await readPolicies();
  return store.policies[agentId];
}

export async function setPolicy(agentId: AgentId, policy: PolicyConfig): Promise<void> {
  const store = await readPolicies();
  store.policies[agentId] = policy;
  await writeJsonAtomic(paths.policies, store);
}

export async function clearPolicy(agentId: AgentId): Promise<boolean> {
  const store = await readPolicies();
  if (!store.policies[agentId]) return false;
  delete store.policies[agentId];
  await writeJsonAtomic(paths.policies, store);
  return true;
}
