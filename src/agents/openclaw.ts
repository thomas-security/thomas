import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Credential } from "../config/credentials.js";
import { readJson, writeJsonAtomic } from "../config/io.js";
import { home } from "../config/paths.js";
import type { ProviderSpec } from "../providers/registry.js";
import type { Protocol } from "./types.js";
import { fileExists, tryGetVersion, whichBinary } from "./detect-helpers.js";
import {
  addThomasTokenToPlist,
  launchAgentPlistPath,
  plistExists,
  reloadLaunchAgent,
  removeThomasTokenFromPlist,
} from "./openclaw-plist.js";
import { runRestartCommand } from "./restart.js";
import type {
  AgentSnapshot,
  AgentSpec,
  CredentialSource,
  DetectResult,
  ExtractedCredential,
  RestartOutcome,
  ShimContext,
} from "./types.js";

const TOKEN_ENV = "THOMAS_OPENCLAW_TOKEN";
const THOMAS_PROVIDER_ID = "thomas";
const THOMAS_MODEL_REF = "thomas/auto";

function stateDir(): string {
  return process.env.OPENCLAW_HOME ?? process.env.OPENCLAW_STATE_DIR ?? home(".openclaw");
}

function mainConfigPath(): string {
  return join(stateDir(), "openclaw.json");
}

type OpenclawConfig = {
  agents?: {
    defaults?: {
      models?: Record<string, unknown>;
      model?: { primary?: string };
    };
  };
  models?: {
    mode?: string;
    providers?: Record<string, OpenclawProviderConfig>;
  };
};

type OpenclawProviderConfig = {
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  models?: unknown[];
};

type OpenclawSnapshotData = {
  previousModelPrimary?: string;
  previousModelsEntry?: unknown;
  previousProvidersEntry?: OpenclawProviderConfig;
};

export const openclaw: AgentSpec = {
  id: "openclaw",
  displayName: "OpenClaw",
  binaries: ["openclaw"],
  protocol: "openai",
  shimEnv: {
    [TOKEN_ENV]: "${THOMAS_TOKEN}",
  },

  async detect(): Promise<DetectResult> {
    const binaryPath = await whichBinary("openclaw");
    if (!binaryPath) {
      return { installed: false, configPaths: [], credentialSources: [] };
    }

    const main = mainConfigPath();
    const agentsDir = join(stateDir(), "agents");

    const configPaths: string[] = [];
    const credentialSources: CredentialSource[] = [];

    if (await fileExists(main)) configPaths.push(main);

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

  async extractCredentials(): Promise<ExtractedCredential[]> {
    const main = await readJson<OpenclawConfig | null>(mainConfigPath(), null);
    const providerCatalog = main?.models?.providers ?? {};

    const agentsDir = join(stateDir(), "agents");
    if (!(await fileExists(agentsDir))) return [];
    const out: ExtractedCredential[] = [];
    const seen = new Set<string>();

    const ids = await readdir(agentsDir).catch(() => []);
    for (const id of ids) {
      const profilePath = join(agentsDir, id, "agent", "auth-profiles.json");
      const raw = await readFile(profilePath, "utf8").catch(() => undefined);
      if (!raw) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      const profiles = collectProfiles(parsed);

      for (const profile of profiles) {
        const providerId = profile?.provider;
        if (typeof providerId !== "string" || !providerId || providerId === THOMAS_PROVIDER_ID) continue;
        if (seen.has(providerId)) continue;
        const credential = profileToCredential(profile, providerId);
        if (!credential) continue;
        seen.add(providerId);
        const providerSpec = inferProviderSpec(providerId, providerCatalog[providerId]);
        out.push({ credential, provider: providerSpec });
      }
    }
    return out;
  },

  async applyConfig(ctx: ShimContext): Promise<AgentSnapshot> {
    const path = mainConfigPath();
    const config = (await readJson<OpenclawConfig | null>(path, null)) ?? {};

    const data: OpenclawSnapshotData = {
      previousModelPrimary: config.agents?.defaults?.model?.primary,
      previousModelsEntry: config.agents?.defaults?.models?.[THOMAS_MODEL_REF],
      previousProvidersEntry: config.models?.providers?.[THOMAS_PROVIDER_ID],
    };

    config.agents = config.agents ?? {};
    config.agents.defaults = config.agents.defaults ?? {};
    config.agents.defaults.models = config.agents.defaults.models ?? {};
    config.agents.defaults.model = config.agents.defaults.model ?? {};
    config.models = config.models ?? { mode: "merge", providers: {} };
    config.models.providers = config.models.providers ?? {};

    config.models.providers[THOMAS_PROVIDER_ID] = {
      baseUrl: `${ctx.thomasUrl}/v1`,
      api: "openai-completions",
      // ${VAR} template — openclaw's parseEnvTemplateSecretRef recognizes this and resolves
      // from process.env at request time. A bare "VARNAME" would be sent literally as the
      // bearer (only whitelisted built-in env names get auto-resolved).
      apiKey: `\${${TOKEN_ENV}}`,
      models: [
        {
          id: "auto",
          name: "auto",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    };
    config.agents.defaults.models[THOMAS_MODEL_REF] = {};
    config.agents.defaults.model.primary = THOMAS_MODEL_REF;

    await writeJsonAtomic(path, config);

    // launchd doesn't inherit shell env, so the shim's THOMAS_OPENCLAW_TOKEN
    // never reaches a LaunchAgent-managed openclaw daemon. Inject it directly
    // into the plist's EnvironmentVariables dict. This is additive only — we
    // touch exactly our key and (on revert) drop it again. Best-effort: a plist
    // mutation failure does not fail connect (the user might run openclaw
    // foreground, in which case the shim path already covers them).
    await addThomasTokenToPlist(ctx.thomasToken).catch(() => undefined);

    return {
      agentId: "openclaw",
      takenAt: new Date().toISOString(),
      configFile: path,
      data: data as unknown as Record<string, unknown>,
    };
  },

  async restart(): Promise<RestartOutcome> {
    // On darwin with a LaunchAgent install, prefer launchctl bootout+bootstrap
    // over `openclaw daemon restart`. The latter uses `launchctl kickstart -k`,
    // which only respawns the process — launchd keeps the previously-loaded
    // plist EnvironmentVariables in memory, so any plist mutation we made in
    // applyConfig (THOMAS_OPENCLAW_TOKEN) wouldn't take effect. bootout+
    // bootstrap forces launchd to re-read the plist before relaunching.
    if (process.platform === "darwin") {
      const plist = launchAgentPlistPath();
      if (await plistExists(plist)) {
        return reloadLaunchAgent(plist);
      }
    }
    const bin = await whichBinary("openclaw");
    if (!bin) {
      return {
        attempted: true,
        ok: false,
        method: "openclaw daemon restart",
        message: "openclaw binary not found on PATH",
      };
    }
    return runRestartCommand([bin, "daemon", "restart"], "openclaw daemon restart");
  },

  async revertConfig(snapshot: AgentSnapshot): Promise<void> {
    const path = snapshot.configFile;
    const config = await readJson<OpenclawConfig | null>(path, null);
    if (!config) return;
    const data = snapshot.data as unknown as OpenclawSnapshotData;

    if (config.models?.providers) {
      if (data.previousProvidersEntry === undefined) {
        delete config.models.providers[THOMAS_PROVIDER_ID];
      } else {
        config.models.providers[THOMAS_PROVIDER_ID] = data.previousProvidersEntry;
      }
    }

    if (config.agents?.defaults?.models) {
      if (data.previousModelsEntry === undefined) {
        delete config.agents.defaults.models[THOMAS_MODEL_REF];
      } else {
        config.agents.defaults.models[THOMAS_MODEL_REF] = data.previousModelsEntry;
      }
    }

    if (config.agents?.defaults?.model) {
      if (data.previousModelPrimary === undefined) {
        delete config.agents.defaults.model.primary;
      } else {
        config.agents.defaults.model.primary = data.previousModelPrimary;
      }
    }

    await writeJsonAtomic(path, config);

    // Mirror image of applyConfig: drop our token from the plist. We don't
    // need a plist snapshot because the mutation is single-key surgical —
    // removeThomasTokenFromPlist only touches THOMAS_OPENCLAW_TOKEN (and the
    // EnvironmentVariables dict if it ends up empty, which means we created it).
    await removeThomasTokenFromPlist().catch(() => undefined);
  },
};

function collectProfiles(parsed: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(parsed)) return parsed as Array<Record<string, unknown>>;
  if (parsed && typeof parsed === "object" && "profiles" in parsed) {
    const p = (parsed as { profiles: unknown }).profiles;
    if (Array.isArray(p)) return p as Array<Record<string, unknown>>;
    if (p && typeof p === "object") return Object.values(p as Record<string, unknown>) as Array<Record<string, unknown>>;
  }
  return [];
}

function profileToCredential(
  profile: Record<string, unknown>,
  provider: string,
): Credential | undefined {
  if (profile.type === "api_key" && typeof profile.key === "string") {
    return { provider, type: "api_key", key: profile.key };
  }
  if (profile.type === "oauth" && typeof profile.access === "string") {
    return {
      provider,
      type: "oauth",
      access: profile.access,
      refresh: typeof profile.refresh === "string" ? profile.refresh : undefined,
      expiresAt: typeof profile.expires === "number" ? profile.expires : undefined,
    };
  }
  return undefined;
}

function inferProviderSpec(
  id: string,
  config: OpenclawProviderConfig | undefined,
): ProviderSpec | undefined {
  if (!config?.baseUrl) return undefined;
  // Preserve the user's full baseUrl — the proxy decides at request time whether
  // to insert /v1. Old behavior stripped /v1 here, which silently dropped any
  // path segment after it (e.g. .../v1/gateway became .../) so the proxy could
  // never reach openclaw-style gateway endpoints.
  const origin = config.baseUrl.replace(/\/+$/, "");
  return { id, protocol: protocolFromApi(config.api), originBaseUrl: origin, custom: true };
}

function protocolFromApi(api: string | undefined): Protocol {
  if (api === "anthropic-messages") return "anthropic";
  return "openai";
}
