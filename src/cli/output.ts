// Public output schema for thomas CLI commands. Stable across versions; bump
// `schemaVersion` only on breaking changes. Agents (Claude Code, Codex, …)
// driving thomas via `--json` depend on this exact shape — see CLAUDE.md
// "Operating model" and SKILL.md.

import type { AgentId, Protocol, RestartOutcome } from "../agents/types.js";

export type { RestartOutcome };

export type ProviderId = string;

export type ModelRef = {
  provider: ProviderId;
  model: string;
};

export type Envelope<C extends CommandName> =
  | {
      schemaVersion: 1;
      command: C;
      generatedAt: string;
      data: CommandOutput[C];
      error?: never;
    }
  | {
      schemaVersion: 1;
      command: C;
      generatedAt: string;
      data?: never;
      error: ErrorPayload;
    };

export type ErrorPayload = {
  code: ErrorCode;
  message: string;
  remediation?: string;
  details?: unknown;
};

export type ErrorCode =
  | "E_INVALID_ARG"
  | "E_AGENT_NOT_FOUND"
  | "E_AGENT_NOT_INSTALLED"
  | "E_AGENT_NOT_CONNECTED"
  | "E_PROVIDER_NOT_FOUND"
  | "E_PROVIDER_AUTH"
  | "E_PROVIDER_UNREACHABLE"
  | "E_CREDENTIAL_MISSING"
  | "E_PROXY_NOT_RUNNING"
  | "E_PORT_IN_USE"
  | "E_CONFIG_CONFLICT"
  | "E_SHIM_NOT_ON_PATH"
  | "E_SNAPSHOT_MISSING"
  | "E_CLOUD_NOT_LOGGED_IN"
  | "E_CLOUD_UNREACHABLE"
  | "E_CLOUD_UNAUTHORIZED"
  | "E_CLOUD_TIMEOUT"
  | "E_INTERNAL";

export type ProxyState = {
  running: boolean;
  pid: number | null;
  port: number | null;
  url: string | null;
  startedAt: string | null;
  uptimeSeconds: number | null;
};

export type DaemonState = {
  installed: boolean;
  platform: "launchd" | "systemd" | "scheduled-task" | "unsupported";
  label: string | null;
  // null when installed = false
  running: boolean | null;
};

export type CredentialSourceKind = "keychain" | "file" | "env" | "dotenv";

export type CredentialFinding = {
  source: CredentialSourceKind;
  location: string;
  providerHint: ProviderId | null;
  imported: boolean;
};

export type DoctorData = {
  host: { os: string; arch: string; user: string };
  agents: Array<{
    id: AgentId;
    installed: boolean;
    binaryPath: string | null;
    configPath: string | null;
    connectMode: "shim-env" | "config-file";
    connected: boolean;
    shimPath: string | null;
    credentials: CredentialFinding[];
    // null when the agent isn't installed or doesn't support skills
    skillInstalled: boolean | null;
  }>;
  proxy: ProxyState;
  daemon: DaemonState;
  // null when --check was not passed; populated only on explicit opt-in because
  // probes do real network calls (one per known-credentialed provider).
  providerHealth: ProviderProbe[] | null;
};

export type AgentRecent = {
  // null until run-tracking lands
  requests24h: number | null;
  errors24h: number | null;
  spendDay: number | null;
  lastRequestAt: string | null;
  lastError: { code: string; message: string; at: string } | null;
};

export type StatusData = {
  proxy: ProxyState;
  spend: { day: number | null; month: number | null; currency: "USD" };
  agents: Array<{
    id: AgentId;
    connected: boolean;
    route: ModelRef | null;
    // post-cascade decision; equals route until L3 lands
    effective: ModelRef | null;
    // null until L3 lands
    policy: { id: string; reason: string } | null;
    recent: AgentRecent;
  }>;
};

export type ProviderInfo = {
  id: ProviderId;
  protocol: Protocol;
  baseUrl: string;
  isBuiltin: boolean;
  isCustom: boolean;
  hasCredentials: boolean;
  credentialSource: "thomas-store" | "env" | "keychain" | null;
  knownModels: string[] | null;
};

export type ListData = {
  proxy: ProxyState;
  daemon: DaemonState;
  agents: Array<{ id: AgentId; connected: boolean; shimPath: string | null }>;
  providers: ProviderInfo[];
  routes: Array<{ agent: AgentId; target: ModelRef }>;
};

export type ProvidersData = {
  providers: ProviderInfo[];
};

export type DaemonStatusData = DaemonState & { proxy: ProxyState | null };

export type ProxyStatusData = ProxyState;

export type ProbeReason =
  | "unreachable"
  | "wrong_path"
  | "auth_failed"
  // Ambiguous: /v1/models returned 404 AND the OPTIONS fallback was non-2xx/non-404
  // (typically 405). Server might be strict (anthropic does this) OR the URL might be
  // wrong — the probe can't tell. The agent/user should confirm with a real request.
  | "models_unavailable"
  | "other";

export type ProviderProbe =
  | { provider: ProviderId; ok: true; status: number; url: string; latencyMs: number }
  | {
      provider: ProviderId;
      ok: false;
      reason: ProbeReason;
      status: number | null;
      url: string;
      latencyMs: number;
      message: string;
    };

export type ConnectData = {
  agent: AgentId;
  shimPath: string | null;
  credentialsImported: ProviderId[];
  configMutated: boolean;
  snapshotPath: string | null;
  // Retained for schema stability. Always false now — connect rejects upfront with
  // E_SHIM_NOT_ON_PATH when ~/.thomas/bin isn't ahead of the original binary on $PATH,
  // so a successful connect implies the shim is already live in the current shell.
  requiresShellReload: boolean;
  // Reachability probes for each newly-imported provider. Empty when --no-import or
  // no credentials were imported. ok=false entries also surface in `notes` as
  // human-readable warnings; agents acting programmatically should prefer this field.
  providerProbes: ProviderProbe[];
  // human-relayable warnings (e.g. OAuth-token-only, provider unreachable); always present, may be empty
  notes: string[];
  // Populated only when --restart-agent was requested. null otherwise. attempted=false means
  // the agent has no restart() implementation (e.g. shim-env-only agents like codex/hermes).
  restart: RestartOutcome | null;
};

export type DisconnectData = {
  agent: AgentId;
  // false when the agent wasn't connected to begin with
  wasConnected: boolean;
  shimRemoved: boolean;
  configReverted: boolean;
  // Same shape and semantics as ConnectData.restart.
  restart: RestartOutcome | null;
  // Human-relayable warnings (same convention as ConnectData.notes). Always present, may be empty.
  notes: string[];
};

export type RouteData = {
  agent: AgentId;
  previous: ModelRef | null;
  current: ModelRef;
};

export type ProvidersAddData = {
  provider: ProviderId;
  replacedExisting: boolean;
};

export type ProvidersRemoveData = {
  provider: ProviderId;
  removed: boolean;
};

export type ProvidersRegisterData = {
  provider: ProviderId;
  protocol: Protocol;
  baseUrl: string;
  replacedExisting: boolean;
};

export type ProvidersUnregisterData = {
  provider: ProviderId;
  removed: boolean;
};

export type DaemonInstallData = {
  platform: DaemonState["platform"];
  label: string;
  running: boolean;
};

export type DaemonUninstallData = {
  removed: boolean;
};

export type SkillInstallData = {
  agent: AgentId;
  path: string;
};

export type SkillRemoveData = {
  agent: AgentId;
  path: string;
  removed: boolean;
};

export type RunSummary = {
  runId: string;
  agent: AgentId;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  status: "running" | "ok" | "error" | "aborted";
  modelCalls: number;
  tokens: { input: number; output: number };
  // null when no price is known for the model used; agent should treat as "unknown" not "free"
  spend: number | null;
  failovers: number;
  modelsUsed: Array<{ ref: ModelRef; calls: number; spend: number | null }>;
};

export type RunsData = {
  runs: RunSummary[];
};

export type ExplainData = {
  subject: { type: "agent" | "run"; id: string };
  narrative: string;
  facts: Array<{
    kind: "route" | "policy-applied" | "cascade" | "fallback" | "cost" | "error";
    detail: string;
    at: string | null;
  }>;
};

export type RecommendData = {
  suggestions: Array<{
    rationale: string;
    policy: {
      primary: ModelRef;
      fallback: ModelRef | null;
      cascade: { triggerSpendDay: number; cheaper: ModelRef } | null;
    };
    estimatedSpendDay: number | null;
    // executable shell command, e.g. "thomas route claude-code anthropic/claude-opus-4-7"
    applyCommand: string;
  }>;
};

// Exactly one of triggerSpendDay / triggerCallsDay is non-null on each rule
// (validated at policy-set time). Spend rules gate on $/day; calls rules
// gate on call count/day — needed for usage-based providers (subscription2api)
// where dollar cost is unknown.
export type CostCascadeRule = {
  triggerSpendDay: number | null;
  triggerCallsDay: number | null;
  fallback: ModelRef;
};

export type PolicySnapshot = {
  agent: AgentId;
  id: "cost-cascade";
  primary: ModelRef;
  cascade: CostCascadeRule[];
  // optional in-run failover target (used when primary returns retryable error)
  failoverTo: ModelRef | null;
  // computed from runs.jsonl for "today" UTC; null when no priced run yet
  currentSpendDay: number | null;
  // call count for "today" UTC — drives triggerCallsDay rules
  currentCallsDay: number;
  // post-decision target after applying usage to cascade
  currentEffective: ModelRef;
  currentReason: string;
};

export type PolicyData = {
  policies: PolicySnapshot[];
};

export type PolicySetData = {
  agent: AgentId;
  policy: {
    id: "cost-cascade";
    primary: ModelRef;
    cascade: CostCascadeRule[];
    failoverTo: ModelRef | null;
  };
};

export type PolicyClearData = {
  agent: AgentId;
  removed: boolean;
};

export type PriceEntry = {
  provider: ProviderId;
  model: string;
  pricePerMillion: { input: number; output: number };
  // builtin: from the hardcoded MODELS table
  // overlay: read from ~/.thomas/prices.json (overrides builtin if same key)
  source: "builtin" | "overlay";
  // builtin entries always have a tier; overlay entries are null unless `prices set --tier` was used
  tier: "premium" | "balanced" | "cheap" | null;
  // builtin entries always have a protocol; overlay entries are null unless `prices set --protocol` was used
  protocol: Protocol | null;
};

export type PricesData = {
  prices: PriceEntry[];
};

export type PricesSetData = {
  provider: ProviderId;
  model: string;
  pricePerMillion: { input: number; output: number };
  protocol: Protocol | null;
  tier: "premium" | "balanced" | "cheap" | null;
  // true when the overlay already had this key (replaced the prior overlay value)
  replacedExisting: boolean;
  // true when this overrides a builtin entry (the user has chosen to override)
  overridesBuiltin: boolean;
};

export type PricesUnsetData = {
  provider: ProviderId;
  model: string;
  removed: boolean;
};

// command name → data shape. Adding a new --json command requires extending this map.
// Subcommand writes use dotted names, e.g. "providers.add", to disambiguate from list.
export type CommandOutput = {
  // reads
  doctor: DoctorData;
  status: StatusData;
  list: ListData;
  providers: ProvidersData;
  daemon: DaemonStatusData;
  proxy: ProxyStatusData;
  // writes
  connect: ConnectData;
  disconnect: DisconnectData;
  route: RouteData;
  "providers.add": ProvidersAddData;
  "providers.remove": ProvidersRemoveData;
  "providers.register": ProvidersRegisterData;
  "providers.unregister": ProvidersUnregisterData;
  "daemon.install": DaemonInstallData;
  "daemon.uninstall": DaemonUninstallData;
  "skill.install": SkillInstallData;
  "skill.remove": SkillRemoveData;
  policy: PolicyData;
  "policy.set": PolicySetData;
  "policy.clear": PolicyClearData;
  prices: PricesData;
  "prices.set": PricesSetData;
  "prices.unset": PricesUnsetData;
  // L3 planned
  runs: RunsData;
  explain: ExplainData;
  recommend: RecommendData;
  // thomas cloud
  "cloud.whoami": CloudWhoamiData;
  "cloud.sync": CloudSyncData;
  "cloud.sync-runs": CloudSyncRunsData;
  "cloud.logout": CloudLogoutData;
};

export type CloudWhoamiData = {
  loggedIn: boolean;
  baseUrl: string | null;
  workspaceId: string | null;
  deviceId: string | null;
  loggedInAt: string | null;
  lastSyncAt: string | null;
};

export type CloudSyncData = {
  schemaVersion: number;
  policiesCount: number;
  bundlesCount: number;
  bindingsCount: number;
  providersCount: number;
  redactRulesVersion: string | null;
  syncedAt: string;
};

export type CloudLogoutData = {
  wasLoggedIn: boolean;
};

export type CloudSyncRunsData = {
  // Total records pulled from runs-pending.jsonl this invocation.
  scanned: number;
  // Server accepted (newly inserted on cloud).
  uploaded: number;
  // Server already had these — idempotent re-uploads count here.
  duplicates: number;
  // Records left in runs-pending.jsonl after this run (failed batches +
  // anything queued mid-drain).
  remaining: number;
};

export type CommandName = keyof CommandOutput;
