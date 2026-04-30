import { join } from "node:path";
import type { Credential } from "../config/credentials.js";
import { home } from "../config/paths.js";
import { fileExists, tryGetVersion, whichBinary } from "./detect-helpers.js";
import { parseDotenv } from "./dotenv.js";
import type { AgentSpec, CredentialSource, DetectResult } from "./types.js";

function hermesHome(): string {
  return process.env.HERMES_HOME ?? home(".hermes");
}

/** Map of hermes env-var key → thomas built-in provider id. */
const ENV_KEY_TO_PROVIDER: Record<string, string> = {
  OPENROUTER_API_KEY: "openrouter",
  OPENAI_API_KEY: "openai",
  ANTHROPIC_API_KEY: "anthropic",
  KIMI_API_KEY: "kimi",
  DEEPSEEK_API_KEY: "deepseek",
  GROQ_API_KEY: "groq",
};

export const hermes: AgentSpec = {
  id: "hermes",
  displayName: "Hermes Agent",
  binaries: ["hermes"],
  protocol: "openai",
  shimEnv: { baseUrl: "OPENAI_BASE_URL", apiKey: "OPENAI_API_KEY" },
  baseUrlPath: "/v1",

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

  async extractCredentials(): Promise<Credential[]> {
    const env = await parseDotenv(join(hermesHome(), ".env"));
    const out: Credential[] = [];
    for (const [envKey, provider] of Object.entries(ENV_KEY_TO_PROVIDER)) {
      const value = env[envKey];
      if (typeof value === "string" && value.length > 0) {
        out.push({ provider, type: "api_key", key: value });
      }
    }
    return out;
  },
};
