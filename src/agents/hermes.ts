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
    const auth = await readAuthJson(join(hermesHome(), "auth.json"));
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

    // Hermes 0.12+ stores keys in auth.json's credential_pool, not .env. The pool key is the
    // upstream hermes provider id (matches HERMES_PROVIDERS.thomasId), or "custom:<host>" for
    // user-defined endpoints.
    for (const [hermesId, entries] of Object.entries(auth?.credential_pool ?? {})) {
      const picked = pickPoolEntry(entries);
      if (!picked) continue;

      if (hermesId.startsWith("custom:")) {
        const host = hermesId.slice("custom:".length);
        const thomasId = customSlug(host);
        if (seen.has(thomasId)) continue;
        seen.add(thomasId);
        out.push({
          credential: { provider: thomasId, type: "api_key", key: picked.access_token },
          provider: {
            id: thomasId,
            protocol: "openai",
            originBaseUrl: stripV1(picked.base_url ?? `https://${host}`),
            custom: true,
          },
        });
        continue;
      }

      const known = HERMES_PROVIDERS.find((e) => e.thomasId === hermesId);
      if (!known || seen.has(known.thomasId)) continue;
      seen.add(known.thomasId);
      out.push({
        credential: { provider: known.thomasId, type: "api_key", key: picked.access_token },
        provider: providerSpec(known),
      });
    }

    return out;
  },
};

type HermesAuthEntry = {
  auth_type?: string;
  priority?: number;
  access_token?: string;
  base_url?: string;
};

type HermesAuthFile = {
  credential_pool?: Record<string, HermesAuthEntry[]>;
};

async function readAuthJson(path: string): Promise<HermesAuthFile | null> {
  try {
    const text = await readFile(path, "utf8");
    return JSON.parse(text) as HermesAuthFile;
  } catch {
    return null;
  }
}

function pickPoolEntry(entries: HermesAuthEntry[]): HermesAuthEntry | undefined {
  // Lower priority value wins; only api_key entries — OAuth needs flow-specific handling.
  return [...entries]
    .filter((e) => e.auth_type === "api_key" && typeof e.access_token === "string" && e.access_token.length > 0)
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))[0];
}

function customSlug(host: string): string {
  return host.replace(/\./g, "-");
}

function stripV1(url: string): string {
  // Preserved name + signature for callers, but no longer strips /v1 — the
  // proxy now adds /v1 adaptively when missing, and stripping here would lose
  // path segments after /v1 (e.g. https://example/v1/gateway).
  return url.replace(/\/+$/, "");
}

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
