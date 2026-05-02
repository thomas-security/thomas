import { readFile } from "node:fs/promises";
import { home } from "../config/paths.js";
import {
  fileExists,
  macKeychainFind,
  macKeychainRead,
  tryGetVersion,
  whichBinary,
} from "./detect-helpers.js";
import type { AgentSpec, CredentialSource, DetectResult, ExtractedCredential } from "./types.js";

export const codex: AgentSpec = {
  id: "codex",
  displayName: "Codex CLI",
  binaries: ["codex"],
  protocol: "openai",
  shimEnv: {
    OPENAI_BASE_URL: "${THOMAS_URL}/v1",
    OPENAI_API_KEY: "${THOMAS_TOKEN}",
  },

  async detect(): Promise<DetectResult> {
    const binaryPath = await whichBinary("codex");
    if (!binaryPath) {
      return { installed: false, configPaths: [], credentialSources: [] };
    }

    const auth = home(".codex", "auth.json");
    const config = home(".codex", "config.toml");

    const configPaths: string[] = [];
    if (await fileExists(config)) configPaths.push(config);
    if (await fileExists(auth)) configPaths.push(auth);

    const credentialSources: CredentialSource[] = [];
    const keychain = await macKeychainFind("Codex Auth");
    if (keychain) {
      credentialSources.push({
        kind: "keychain",
        service: "Codex Auth",
        account: keychain.account,
      });
    }
    if (await fileExists(auth)) {
      credentialSources.push({ kind: "file", path: auth });
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
    const blob =
      (await macKeychainRead("Codex Auth")) ??
      (await readFile(home(".codex", "auth.json"), "utf8").catch(() => undefined));
    if (!blob) return [];
    try {
      const parsed = JSON.parse(blob);
      const apiKey = parsed.OPENAI_API_KEY ?? parsed.openai_api_key ?? parsed.apiKey;
      if (typeof apiKey === "string" && apiKey.length > 0) {
        return [{ credential: { provider: "openai", type: "api_key", key: apiKey } }];
      }
      const tokens = parsed.tokens ?? parsed.OPENAI_TOKENS;
      if (tokens?.access_token) {
        return [
          {
            credential: {
              provider: "openai",
              type: "oauth",
              access: tokens.access_token,
              refresh: tokens.refresh_token,
              expiresAt: tokens.expires_at,
            },
          },
        ];
      }
    } catch {
      // fall through
    }
    return [];
  },
};
