import { userInfo } from "node:os";
import { listAgents } from "../agents/registry.js";
import type { CredentialSource } from "../agents/types.js";
import { runJson } from "../cli/json.js";
import type {
  CredentialFinding,
  CredentialSourceKind,
  DoctorData,
  ProviderProbe,
} from "../cli/output.js";
import { daemonStateOf, proxyStateOf } from "../cli/state.js";
import { readAgents } from "../config/agents.js";
import { readConfig } from "../config/config.js";
import { readCredentials } from "../config/credentials.js";
import { getStatus } from "../daemon/lifecycle.js";
import { probeProviders } from "../providers/health.js";
import { isSkillInstalled } from "./skill.js";

export async function doctor(opts: { json: boolean; check?: boolean }): Promise<number> {
  return runJson({
    command: "doctor",
    json: opts.json,
    fetch: () => fetchDoctorData({ check: !!opts.check }),
    printHuman: printDoctor,
  });
}

async function fetchDoctorData(opts: { check: boolean }): Promise<DoctorData> {
  const cfg = await readConfig();
  const specs = listAgents();
  const [agentsState, credentialsStore, proxy, daemon] = await Promise.all([
    readAgents(),
    readCredentials(),
    getStatus(cfg.port),
    daemonStateOf(),
  ]);
  const imported = new Set(credentialsStore.providers.map((c) => c.provider));

  const agents = await Promise.all(
    specs.map(async (spec) => {
      const detect = await spec.detect();
      const conn = agentsState.connected[spec.id];
      const skillInstalled = detect.installed && detect.skillDir
        ? await isSkillInstalled(spec.id)
        : null;
      return {
        id: spec.id,
        installed: detect.installed,
        binaryPath: detect.binaryPath ?? null,
        configPath: detect.configPaths[0] ?? null,
        connectMode: spec.applyConfig ? ("config-file" as const) : ("shim-env" as const),
        connected: !!conn,
        shimPath: conn?.shimPath ?? null,
        credentials: detect.credentialSources.map((src) => credentialFinding(src, imported)),
        skillInstalled,
      };
    }),
  );

  // Provider health probes are opt-in (--check) because each does a real
  // network call. Probe every provider that has credentials in the thomas
  // store — that covers built-ins (e.g. anthropic) AND custom-registered ones
  // (e.g. user's vllm). Providers without credentials are skipped: a probe
  // without auth tells us little about whether the URL is correct.
  let providerHealth: ProviderProbe[] | null = null;
  if (opts.check) {
    const ids = credentialsStore.providers.map((c) => c.provider);
    const results = await probeProviders(ids);
    providerHealth = results.map((p) =>
      p.ok
        ? { provider: p.provider, ok: true, status: p.status, url: p.url, latencyMs: p.latencyMs }
        : {
            provider: p.provider,
            ok: false,
            reason: p.reason,
            status: p.status,
            url: p.url,
            latencyMs: p.latencyMs,
            message: p.message,
          },
    );
  }

  return {
    host: { os: process.platform, arch: process.arch, user: userInfo().username },
    agents,
    proxy: proxyStateOf(proxy, cfg.port, cfg.host),
    daemon,
    providerHealth,
  };
}

function credentialFinding(src: CredentialSource, imported: Set<string>): CredentialFinding {
  const { source, location } = mapSource(src);
  return {
    source,
    location,
    providerHint: null,
    imported: imported.has(location),
  };
}

function mapSource(src: CredentialSource): { source: CredentialSourceKind; location: string } {
  if (src.kind === "keychain") return { source: "keychain", location: src.service };
  if (src.kind === "file") return { source: "file", location: src.path };
  return { source: "env", location: src.name };
}

function printDoctor(data: DoctorData): void {
  const specs = listAgents();
  const byId = new Map(specs.map((s) => [s.id, s]));

  console.log("Agents");
  for (const a of data.agents) {
    const displayName = byId.get(a.id)?.displayName ?? a.id;
    if (!a.installed) {
      console.log(`  ${displayName.padEnd(16)} not installed`);
      continue;
    }
    console.log(`  ${displayName.padEnd(16)} ${a.binaryPath ?? "(unknown path)"}`);
    if (a.configPath) console.log(`    config:      ${a.configPath}`);
    for (const cred of a.credentials) {
      console.log(`    credentials: ${formatCredential(cred)}`);
    }
    if (a.skillInstalled !== null) {
      console.log(`    skill:       ${a.skillInstalled ? "installed" : "not installed"}`);
    }
  }

  const installed = data.agents.filter((a) => a.installed).length;
  console.log("");
  console.log(`Detected ${installed} of ${data.agents.length} supported agents.`);

  if (data.providerHealth) {
    console.log("");
    console.log("Provider health (--check)");
    if (data.providerHealth.length === 0) {
      console.log("  no credentialed providers to probe");
    }
    for (const p of data.providerHealth) {
      if (p.ok) {
        console.log(`  ${p.provider.padEnd(18)} ok      HTTP ${p.status} ${p.url} (${p.latencyMs}ms)`);
      } else {
        console.log(
          `  ${p.provider.padEnd(18)} ${p.reason.padEnd(7)} ${p.status ?? "—"} ${p.url} — ${p.message}`,
        );
      }
    }
  }

  const claude = data.agents.find((a) => a.id === "claude-code");
  console.log("");
  if (!claude || !claude.installed) {
    console.log("Tip: skills can be fetched from https://github.com/trustunknown/thomas");
  } else if (claude.skillInstalled) {
    console.log("Tip: thomas skill is installed for Claude Code. It can drive thomas for you.");
  } else {
    console.log("Tip: install the skill so Claude Code can drive thomas for you:");
    console.log("  thomas skill install claude-code");
  }
}

function formatCredential(cred: CredentialFinding): string {
  if (cred.source === "keychain") return `keychain (${cred.location})`;
  if (cred.source === "file") return `file ${cred.location}`;
  if (cred.source === "env") return `env $${cred.location}`;
  return `dotenv ${cred.location}`;
}
