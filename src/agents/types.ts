export type AgentId = "claude-code" | "codex" | "openclaw" | "hermes";

export type Protocol = "anthropic" | "openai";

export type CredentialSource =
  | { kind: "keychain"; service: string; account: string }
  | { kind: "file"; path: string }
  | { kind: "env"; name: string };

export type DetectResult = {
  installed: boolean;
  binaryPath?: string;
  version?: string;
  configPaths: string[];
  credentialSources: CredentialSource[];
  skillDir?: string;
};

import type { Credential } from "../config/credentials.js";
import type { ProviderSpec } from "../providers/registry.js";

/** Template values usable inside shimEnv values: ${THOMAS_URL}, ${THOMAS_TOKEN}. */
export type ShimContext = {
  thomasUrl: string;
  thomasToken: string;
};

/** Captured prior state needed to revert applyConfig(). Persisted at ~/.thomas/snapshots/<agent>.json. */
export type AgentSnapshot = {
  agentId: AgentId;
  takenAt: string;
  configFile: string;
  /** Opaque per-agent payload: the values overwritten by applyConfig. */
  data: Record<string, unknown>;
};

export type ExtractedCredential = {
  credential: Credential;
  /** Optional ProviderSpec to register/upsert alongside the credential. Lets us bring in
   *  user-specific endpoints (e.g. openclaw's vllm baseUrl) without manual `thomas providers register`. */
  provider?: ProviderSpec;
};

/** Result of asking an agent to restart its long-running process(es) so config edits
 *  made by connect/disconnect take effect. Always present in JSON output when the
 *  caller asked for a restart; absent (null) when they didn't. */
export type RestartOutcome = {
  /** false when the agent has no restart() — i.e. nothing was tried. */
  attempted: boolean;
  /** true only when attempted && the restart command exited 0. */
  ok: boolean;
  /** The exact mechanism, e.g. "openclaw daemon restart". "n/a" when not attempted. */
  method: string;
  /** Human-readable summary; safe to relay verbatim. */
  message: string;
  /** Exit code of the restart subprocess, when applicable. */
  exitCode?: number | null;
  durationMs?: number;
};

export type AgentSpec = {
  id: AgentId;
  displayName: string;
  binaries: string[];
  protocol: Protocol;
  /** Env vars set by the PATH shim. Values may reference ${THOMAS_URL} (e.g. http://127.0.0.1:51168)
   *  and ${THOMAS_TOKEN}. Resolved at install time. Optional — agents that only do config writes can omit. */
  shimEnv?: Record<string, string>;
  /** Mutate the agent's own config so it points at thomas. Returns a snapshot revertConfig() can use.
   *  Must be additive — preserve existing user data. Optional — env-only agents omit. */
  applyConfig?: (ctx: ShimContext) => Promise<AgentSnapshot>;
  /** Restore everything applyConfig() touched. */
  revertConfig?: (snapshot: AgentSnapshot) => Promise<void>;
  /** Restart the agent's running process(es) so config edits take effect. Optional —
   *  only agents with long-running daemons (e.g. openclaw's GatewayService) need this.
   *  Implementations MUST prefer the agent's own canonical restart API (e.g. its CLI
   *  subcommand) over signal/PID hacks; thomas does not own the agent's process tree. */
  restart?: () => Promise<RestartOutcome>;
  detect(): Promise<DetectResult>;
  extractCredentials?: () => Promise<ExtractedCredential[]>;
};
