import { existsSync } from "node:fs";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fileExists } from "../agents/detect-helpers.js";
import { getAgent } from "../agents/registry.js";
import type { AgentId } from "../agents/types.js";
import { home } from "../config/paths.js";

const SKILL_DIRS: Partial<Record<AgentId, string>> = {
  "claude-code": home(".claude", "skills", "thomas"),
};

export async function skillInstall(agentId: string): Promise<number> {
  const spec = getAgent(agentId);
  if (!spec) {
    console.error(`thomas: unknown agent '${agentId}'`);
    return 1;
  }
  const target = SKILL_DIRS[spec.id];
  if (!target) {
    console.error(`thomas: skill install for '${agentId}' is not supported in v0.1.0.`);
    console.error("Copy SKILL.md manually from https://github.com/thomas-security/thomas");
    return 1;
  }
  const source = locateSkillSource();
  if (!source || !(await fileExists(source))) {
    console.error("thomas: SKILL.md not found in package. Reinstall thomas?");
    return 1;
  }
  await mkdir(target, { recursive: true });
  await copyFile(source, join(target, "SKILL.md"));
  console.log(`Installed thomas skill → ${target}/SKILL.md`);
  console.log("Restart your agent's session for it to pick up the skill.");
  return 0;
}

export async function skillRemove(agentId: string): Promise<number> {
  const target = SKILL_DIRS[agentId as AgentId];
  if (!target) {
    console.error(`thomas: skill remove for '${agentId}' is not supported.`);
    return 1;
  }
  if (!existsSync(target)) {
    console.log(`No thomas skill installed at ${target}.`);
    return 0;
  }
  await rm(target, { recursive: true, force: true });
  console.log(`Removed thomas skill from ${target}`);
  return 0;
}

export async function isSkillInstalled(agentId: AgentId): Promise<boolean> {
  const target = SKILL_DIRS[agentId];
  if (!target) return false;
  return fileExists(join(target, "SKILL.md"));
}

function locateSkillSource(): string | undefined {
  let cur = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(cur, "package.json"))) {
      return join(cur, "SKILL.md");
    }
    const parent = dirname(cur);
    if (parent === cur) return undefined;
    cur = parent;
  }
  return undefined;
}
