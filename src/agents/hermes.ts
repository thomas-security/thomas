import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Credential } from "../config/credentials.js";
import { home } from "../config/paths.js";
import type { ProviderSpec } from "../providers/registry.js";
import { fileExists, tryGetVersion, whichBinary } from "./detect-helpers.js";
import { parseDotenv } from "./dotenv.js";
import { HERMES_PROVIDERS, type HermesProviderEntry } from "../providers/agents/hermes.generated.js";
import type { AgentSpec, CredentialSource, DetectResult, ExtractedCredential } from "./types.js";

function hermesHome(): string {
  return process.env.HERMES_HOME ?? home(".hermes");
}

export const hermes: AgentSpec = {
  id: "hermes",
  displayName: "Hermes Agent",
  binaries: ["hermes"],
  protocol: "openai",
  shimEnv: {
    HERMES_INFERENCE_PROVIDER: "openrouter",
    OPENROUTER_API_KEY: "${THOMAS_TOKEN}",
    OPENROUTER_BASE_URL: "${THOMAS_URL}/v1",
  },

  async detect(): Promise<DetectResult> {
    const binaryPath = await whichBinary("hermes");
    if (!binaryPath) {
      return { installed: false, configPaths: [], credentialSources: [] };
    }
    const root = hermesHome();
    const envFile = join(root, ".env");
    const configFile = join(root, "config.yaml");
    const authFile = join(root, "auth.json");

    const configPaths: string[] = [];
    const credentialSources: CredentialSource[] = [];

    if (await fileExists(configFile)) configPaths.push(configFile);
    if (await fileExists(envFile)) {
      configPaths.push(envFile);
      credentialSources.push({ kind: "file", path: envFile });
    }
    if (await fileExists(authFile)) {
      configPaths.push(authFile);
      credentialSources.push({ kind: "file", path: authFile });
    }

    return {
      installed: true,
      binaryPath,
      version: await tryGetVersion(binaryPath),
      configPaths,
      credentialSources,
    };
  },

  async extractCredentials(): Promise<ExtractedCredential[]> {
    const env = await parseDotenv(join(hermesHome(), ".env"));
    const out: ExtractedCredential[] = [];
    const seen = new Set<string>();

    for (const entry of HERMES_PROVIDERS) {
      if (seen.has(entry.thomasId)) continue;
      const key = pickFirst(env, entry.envKeys);
      if (!key) continue;
      seen.add(entry.thomasId);
      const credential: Credential = {
        provider: entry.thomasId,
        type: "api_key",
        key,
      };
      out.push({ credential, provider: providerSpec(entry) });
    }

    return out;
  },
};

function pickFirst(env: Record<string, string>, keys: readonly string[]): string | undefined {
  for (const k of keys) {
    const v = env[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

/** Surface a ProviderSpec only for hermes-only providers. Built-ins (anthropic/openai/etc.)
 *  are already registered, so don't shadow them. */
function providerSpec(entry: HermesProviderEntry): ProviderSpec | undefined {
  if (entry.builtin) return undefined;
  return {
    id: entry.thomasId,
    protocol: entry.protocol,
    originBaseUrl: entry.originBaseUrl,
    custom: true,
  };
}
