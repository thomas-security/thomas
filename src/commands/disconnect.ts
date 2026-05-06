import { getAgent } from "../agents/registry.js";
import type { AgentId, AgentSpec, RestartOutcome } from "../agents/types.js";
import { ThomasError, runJson } from "../cli/json.js";
import type { DisconnectData } from "../cli/output.js";
import { readAgents, recordDisconnect } from "../config/agents.js";
import { deleteSnapshot, readSnapshot } from "../config/snapshots.js";
import { removeShim } from "../shim/install.js";

export type DisconnectOptions = {
  json: boolean;
  restartAgent?: boolean;
};

export async function disconnect(
  agentId: string,
  opts: DisconnectOptions,
): Promise<number> {
  return runJson({
    command: "disconnect",
    json: opts.json,
    fetch: () => doDisconnect(agentId, opts),
    printHuman: (d) => {
      const agent = getAgent(d.agent);
      const display = agent?.displayName ?? d.agent;
      if (!d.wasConnected) {
        console.log(`${display} is not connected.`);
        return;
      }
      const note = d.configReverted ? "config restored, shim removed" : "shim removed";
      console.log(`Disconnected ${display}. ${note}.`);
      if (d.restart && d.restart.attempted) {
        console.log(`  restart:  ${d.restart.ok ? "ok" : "FAILED"} (${d.restart.method})`);
      }
      for (const n of d.notes) {
        console.log("");
        console.log(`Note: ${n}`);
      }
    },
  });
}

async function doDisconnect(agentId: string, opts: DisconnectOptions): Promise<DisconnectData> {
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
    return {
      agent: spec.id,
      wasConnected: false,
      shimRemoved: false,
      configReverted: false,
      restart: null,
      notes: [],
    };
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

  const restart = await maybeRestart(spec, opts.restartAgent);

  // Mirror the connect-side warning: a launchd-managed openclaw daemon won't
  // drop the now-stale THOMAS_OPENCLAW_TOKEN env until the service is
  // bootstrap'd. Without --restart-agent, requests from the daemon still go
  // out as the previous user, with a token thomas no longer recognizes.
  const notes: string[] = [];
  if (
    spec.id === "openclaw" &&
    process.platform === "darwin" &&
    !opts.restartAgent
  ) {
    notes.push(
      "OpenClaw daemon still has the prior THOMAS_OPENCLAW_TOKEN cached in its environment. Pass `--restart-agent` (or run `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/ai.openclaw.gateway.plist && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.openclaw.gateway.plist`) so the service reloads the now-cleaned plist.",
    );
  }

  return {
    agent: spec.id as AgentId,
    wasConnected: true,
    shimRemoved: true,
    configReverted,
    restart,
    notes,
  };
}

async function maybeRestart(
  spec: AgentSpec,
  requested: boolean | undefined,
): Promise<RestartOutcome | null> {
  if (!requested) return null;
  if (!spec.restart) {
    return {
      attempted: false,
      ok: false,
      method: "n/a",
      message: `${spec.displayName} has no automated restart hook (shim-env agents are picked up on next process spawn).`,
    };
  }
  return spec.restart();
}
