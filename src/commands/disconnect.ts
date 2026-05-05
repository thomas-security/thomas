import { getAgent } from "../agents/registry.js";
import type { AgentId } from "../agents/types.js";
import { ThomasError, runJson } from "../cli/json.js";
import type { DisconnectData } from "../cli/output.js";
import { readAgents, recordDisconnect } from "../config/agents.js";
import { deleteSnapshot, readSnapshot } from "../config/snapshots.js";
import { removeShim } from "../shim/install.js";

export async function disconnect(
  agentId: string,
  opts: { json: boolean },
): Promise<number> {
  return runJson({
    command: "disconnect",
    json: opts.json,
    fetch: () => doDisconnect(agentId),
    printHuman: (d) => {
      const agent = getAgent(d.agent);
      const display = agent?.displayName ?? d.agent;
      if (!d.wasConnected) {
        console.log(`${display} is not connected.`);
        return;
      }
      const note = d.configReverted ? "config restored, shim removed" : "shim removed";
      console.log(`Disconnected ${display}. ${note}.`);
    },
  });
}

async function doDisconnect(agentId: string): Promise<DisconnectData> {
  const spec = getAgent(agentId);
  if (!spec) {
    throw new ThomasError({
      code: "E_AGENT_NOT_FOUND",
      message: `unknown agent '${agentId}'`,
      remediation: "Run `thomas doctor` to see installed agents",
      details: { requested: agentId, known: ["claude-code", "codex", "openclaw", "hermes"] },
    });
  }
  const store = await readAgents();
  if (!store.connected[agentId]) {
    return { agent: spec.id, wasConnected: false, shimRemoved: false, configReverted: false };
  }

  const snapshot = await readSnapshot(spec.id);
  let configReverted = false;
  if (snapshot && spec.revertConfig) {
    await spec.revertConfig(snapshot);
    await deleteSnapshot(spec.id);
    configReverted = true;
  }

  await removeShim(spec);
  await recordDisconnect(agentId);
  return { agent: spec.id as AgentId, wasConnected: true, shimRemoved: true, configReverted };
}
