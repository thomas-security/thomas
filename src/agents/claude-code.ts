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

export const claudeCode: AgentSpec = {
  id: "claude-code",
  displayName: "Claude Code",
  binaries: ["claude"],
  protocol: "anthropic",
  shimEnv: {
    ANTHROPIC_BASE_URL: "${THOMAS_URL}",
    ANTHROPIC_API_KEY: "${THOMAS_TOKEN}",
  },

  async detect(): Promise<DetectResult> {
    const binaryPath = await whichBinary("claude");
    if (!binaryPath) {
      return { installed: false, configPaths: [], credentialSources: [] };
    }

    const settings = home(".claude", "settings.json");
    const credsFile = home(".claude", ".credentials.json");
    const skillDir = home(".claude", "skills");

    const configPaths: string[] = [];
    if (await fileExists(settings)) configPaths.push(settings);

    const credentialSources: CredentialSource[] = [];
    const keychain = await macKeychainFind("Claude Code-credentials");
    if (keychain) {
      credentialSources.push({
        kind: "keychain",
        service: "Claude Code-credentials",
        account: keychain.account,
      });
    }
    if (await fileExists(credsFile)) {
      credentialSources.push({ kind: "file", path: credsFile });
    }

    return {
      installed: true,
      binaryPath,
      version: await tryGetVersion(binaryPath),
      configPaths,
      credentialSources,
      skillDir: (await fileExists(skillDir)) ? skillDir : undefined,
    };
  },

  async extractCredentials(): Promise<ExtractedCredential[]> {
    const blob =
      (await macKeychainRead("Claude Code-credentials")) ??
      (await readFile(home(".claude", ".credentials.json"), "utf8").catch(() => undefined));
    if (!blob) return [];
    try {
      const parsed = JSON.parse(blob);
      const oauth = parsed.claudeAiOauth ?? parsed;
      if (oauth?.accessToken) {
        return [
          {
            credential: {
              provider: "anthropic",
              type: "oauth",
              access: oauth.accessToken,
              refresh: oauth.refreshToken,
              expiresAt: oauth.expiresAt,
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
