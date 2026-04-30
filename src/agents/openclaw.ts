import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Credential } from "../config/credentials.js";
import { home } from "../config/paths.js";
import { fileExists, tryGetVersion, whichBinary } from "./detect-helpers.js";
import type { AgentSpec, CredentialSource, DetectResult } from "./types.js";

export const openclaw: AgentSpec = {
  id: "openclaw",
  displayName: "OpenClaw",
  binaries: ["openclaw"],
  protocol: "openai",
  shimEnv: { baseUrl: "OPENAI_BASE_URL", apiKey: "OPENAI_API_KEY" },
  baseUrlPath: "/v1",

  async detect(): Promise<DetectResult> {
    const binaryPath = await whichBinary("openclaw");
    if (!binaryPath) {
      return { installed: false, configPaths: [], credentialSources: [] };
    }

    const stateDir = process.env.OPENCLAW_STATE_DIR ?? home(".openclaw");
    const agentsDir = join(stateDir, "agents");

    const configPaths: string[] = [];
    const credentialSources: CredentialSource[] = [];

    if (await fileExists(agentsDir)) {
      const ids = await readdir(agentsDir).catch(() => []);
      for (const id of ids) {
        const profile = join(agentsDir, id, "agent", "auth-profiles.json");
        if (await fileExists(profile)) {
          configPaths.push(profile);
          credentialSources.push({ kind: "file", path: profile });
        }
      }
    }

    return {
      installed: true,
      binaryPath,
      version: await tryGetVersion(binaryPath),
      configPaths,
      credentialSources,
    };
  },

  async extractCredentials(): Promise<Credential[]> {
    const stateDir = process.env.OPENCLAW_STATE_DIR ?? home(".openclaw");
    const agentsDir = join(stateDir, "agents");
    if (!(await fileExists(agentsDir))) return [];
    const out: Credential[] = [];
    const ids = await readdir(agentsDir).catch(() => []);
    for (const id of ids) {
      const profilePath = join(agentsDir, id, "agent", "auth-profiles.json");
      const raw = await readFile(profilePath, "utf8").catch(() => undefined);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        const profiles = Array.isArray(parsed) ? parsed : (parsed.profiles ?? []);
        for (const p of profiles) {
          if (p?.type === "api_key" && typeof p.key === "string" && p.provider) {
            out.push({ provider: p.provider, type: "api_key", key: p.key });
          } else if (p?.type === "oauth" && p.access && p.provider) {
            out.push({
              provider: p.provider,
              type: "oauth",
              access: p.access,
              refresh: p.refresh,
              expiresAt: p.expires,
            });
          }
        }
      } catch {
        // skip malformed
      }
    }
    return out;
  },
};
