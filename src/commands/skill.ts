import { existsSync } from "node:fs";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fileExists } from "../agents/detect-helpers.js";
import { getAgent } from "../agents/registry.js";
import type { AgentId } from "../agents/types.js";
import { ThomasError, runJson } from "../cli/json.js";
import type { SkillInstallData, SkillRemoveData } from "../cli/output.js";
import { home } from "../config/paths.js";

// Relative skill-dir segments per agent. Resolved against the user's home
// at call time (via `home()`), not at module load — tests can override HOME.
const SKILL_DIR_SEGMENTS: Partial<Record<AgentId, readonly string[]>> = {
  "claude-code": [".claude", "skills", "thomas"],
};

function skillDirFor(id: AgentId): string | undefined {
  const segs = SKILL_DIR_SEGMENTS[id];
  return segs ? home(...segs) : undefined;
}

export async function skillInstall(
  agentId: string,
  opts: { json: boolean },
): Promise<number> {
  return runJson({
    command: "skill.install",
    json: opts.json,
    fetch: () => doSkillInstall(agentId),
    printHuman: (d) => {
      console.log(`Installed thomas skill → ${d.path}`);
      console.log("Restart your agent's session for it to pick up the skill.");
    },
  });
}

async function doSkillInstall(agentId: string): Promise<SkillInstallData> {
  const spec = getAgent(agentId);
  if (!spec) throw unknownAgent(agentId);
  const target = skillDirFor(spec.id);
  if (!target) {
    throw new ThomasError({
      code: "E_INVALID_ARG",
      message: `skill install for '${agentId}' is not supported in v0.1.0`,
      remediation:
        "Copy SKILL.md manually from https://github.com/trustunknown/thomas",
      details: { agent: agentId },
    });
  }
  const source = locateSkillSource();
  if (!source || !(await fileExists(source))) {
    throw new ThomasError({
      code: "E_INTERNAL",
      message: "SKILL.md not found in package",
      remediation: "Reinstall thomas",
    });
  }
  await mkdir(target, { recursive: true });
  await copyFile(source, join(target, "SKILL.md"));
  return { agent: spec.id, path: join(target, "SKILL.md") };
}

export async function skillRemove(
  agentId: string,
  opts: { json: boolean },
): Promise<number> {
  return runJson({
    command: "skill.remove",
    json: opts.json,
    fetch: () => doSkillRemove(agentId),
    printHuman: (d) => {
      if (d.removed) console.log(`Removed thomas skill from ${d.path}`);
      else console.log(`No thomas skill installed at ${d.path}`);
    },
  });
}

async function doSkillRemove(agentId: string): Promise<SkillRemoveData> {
  const target = skillDirFor(agentId as AgentId);
  if (!target) {
    throw new ThomasError({
      code: "E_INVALID_ARG",
      message: `skill remove for '${agentId}' is not supported`,
      details: { agent: agentId },
    });
  }
  const id = agentId as AgentId;
  if (!existsSync(target)) {
    return { agent: id, path: target, removed: false };
  }
  await rm(target, { recursive: true, force: true });
  return { agent: id, path: target, removed: true };
}

export async function isSkillInstalled(agentId: AgentId): Promise<boolean> {
  const target = skillDirFor(agentId);
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

function unknownAgent(id: string): ThomasError {
  return new ThomasError({
    code: "E_AGENT_NOT_FOUND",
    message: `unknown agent '${id}'`,
    remediation: "Run `thomas doctor` to see installed agents",
    details: { requested: id, known: ["claude-code", "codex", "openclaw", "hermes"] },
  });
}
