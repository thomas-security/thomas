import { listAgents } from "../agents/registry.js";
import type { AgentId, DetectResult } from "../agents/types.js";
import { isSkillInstalled } from "./skill.js";

export async function doctor(): Promise<void> {
  const specs = listAgents();
  const results = await Promise.all(
    specs.map(async (spec) => ({
      spec,
      detect: await spec.detect(),
      skillInstalled: await isSkillInstalled(spec.id),
    })),
  );

  console.log("Agents");
  for (const { spec, detect, skillInstalled } of results) {
    printAgent(spec.displayName, spec.id, detect, skillInstalled);
  }

  const installedCount = results.filter((r) => r.detect.installed).length;
  console.log("");
  console.log(`Detected ${installedCount} of ${results.length} supported agents.`);
  console.log("");
  printSkillTip(results);
}

function printAgent(
  displayName: string,
  id: string,
  d: DetectResult,
  skillInstalled: boolean,
): void {
  if (!d.installed) {
    console.log(`  ${displayName.padEnd(16)} not installed`);
    return;
  }
  const version = d.version ? `  (${d.version})` : "";
  console.log(`  ${displayName.padEnd(16)} ${d.binaryPath}${version}`);
  if (d.configPaths.length > 0) {
    for (const p of d.configPaths) console.log(`    config:      ${p}`);
  }
  for (const src of d.credentialSources) {
    if (src.kind === "keychain") {
      console.log(`    credentials: keychain (${src.service})`);
    } else if (src.kind === "file") {
      console.log(`    credentials: file ${src.path}`);
    } else {
      console.log(`    credentials: env $${src.name}`);
    }
  }
  if (d.skillDir) {
    const status = skillInstalled ? "thomas skill installed" : "thomas skill not installed";
    console.log(`    skill dir:   ${d.skillDir}  (${status})`);
  } else if (id === "claude-code") {
    console.log(`    skill dir:   not detected (run \`mkdir -p ~/.claude/skills\`)`);
  }
}

function printSkillTip(
  results: { spec: { id: AgentId }; detect: DetectResult; skillInstalled: boolean }[],
): void {
  const claude = results.find((r) => r.spec.id === "claude-code");
  if (!claude?.detect.installed) {
    console.log("Tip: skills can be fetched from https://github.com/thomas-security/thomas");
    return;
  }
  if (claude.skillInstalled) {
    console.log("Tip: thomas skill is installed for Claude Code. It can drive thomas for you.");
    return;
  }
  console.log("Tip: install the skill so Claude Code can drive thomas for you:");
  console.log("  thomas skill install claude-code");
}
