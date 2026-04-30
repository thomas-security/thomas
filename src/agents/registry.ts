import { claudeCode } from "./claude-code.js";
import { codex } from "./codex.js";
import { hermes } from "./hermes.js";
import { openclaw } from "./openclaw.js";
import type { AgentId, AgentSpec } from "./types.js";

export const agents: Record<AgentId, AgentSpec> = {
  "claude-code": claudeCode,
  codex,
  openclaw,
  hermes,
};

export function getAgent(id: string): AgentSpec | undefined {
  return (agents as Record<string, AgentSpec>)[id];
}

export function listAgents(): AgentSpec[] {
  return Object.values(agents);
}
