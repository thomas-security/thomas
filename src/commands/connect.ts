import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { getAgent } from "../agents/registry.js";
import type { AgentId, AgentSnapshot, AgentSpec, RestartOutcome } from "../agents/types.js";
import { ThomasError, runJson } from "../cli/json.js";
import type { ConnectData, ProviderProbe } from "../cli/output.js";
import { recordConnect } from "../config/agents.js";
import { readConfig } from "../config/config.js";
import { upsertCredential } from "../config/credentials.js";
import { paths } from "../config/paths.js";
import { setRoute } from "../config/routes.js";
import { deleteSnapshot, writeSnapshot } from "../config/snapshots.js";
import { ensureRunning } from "../daemon/lifecycle.js";
import { probeProviders, type ProbeResult } from "../providers/health.js";
import { getProvider, registerCustom } from "../providers/registry.js";
import { installShim, removeShim, verifyShimWins, type ShimVerification } from "../shim/install.js";
import { resolveThomasInvocation } from "../shim/quote.js";

export type ConnectOptions = {
  agentId: string;
  noImport?: boolean;
  noProxy?: boolean;
  restartAgent?: boolean;
  json: boolean;
};

export async function connect(opts: ConnectOptions): Promise<number> {
  return runJson({
    command: "connect",
    json: opts.json,
    fetch: () => doConnect(opts),
    printHuman: (d) => printConnect(d, opts),
  });
}

async function doConnect(opts: ConnectOptions): Promise<ConnectData> {
  const spec = getAgent(opts.agentId);
  if (!spec) {
    throw new ThomasError({
      code: "E_AGENT_NOT_FOUND",
      message: `unknown agent '${opts.agentId}'`,
      remediation: "Run `thomas doctor` to see installed agents",
      details: { requested: opts.agentId, known: ["claude-code", "codex", "openclaw", "hermes"] },
    });
  }

  const detect = await spec.detect();
  if (!detect.installed || !detect.binaryPath) {
    throw new ThomasError({
      code: "E_AGENT_NOT_INSTALLED",
      message: `${spec.displayName} is not installed on this machine`,
      remediation: `Install ${spec.displayName} first, then re-run \`thomas connect ${spec.id}\``,
      details: { agent: spec.id },
    });
  }

  const cfg = await readConfig();
  const importedProviders = !opts.noImport ? await importCredentials(spec) : [];

  if (importedProviders.length > 0) {
    const defaultProvider = importedProviders[0]!;
    await setRoute(spec.id, { provider: defaultProvider, model: "passthrough" });
  }

  // Probe each newly-imported provider in parallel. Surfaces wrong base URLs
  // immediately rather than waiting for the user's first real request to
  // 401/404 — the exact failure mode that motivated this in the first place.
  // We never fail connect on probe results: providers may be intentionally
  // offline (local vllm asleep, gated proxies, OAuth-only credentials). We
  // just record the result so the user/agent has the data.
  const probeResults =
    importedProviders.length > 0 ? await probeProviders(importedProviders) : [];
  const providerProbes: ProviderProbe[] = probeResults.map(toWireProbe);

  const notes = buildNotes(spec, importedProviders, !!opts.restartAgent);
  appendProbeNotes(notes, probeResults);

  if (opts.noProxy) {
    return {
      agent: spec.id,
      shimPath: null,
      credentialsImported: importedProviders,
      configMutated: false,
      snapshotPath: null,
      requiresShellReload: false,
      providerProbes,
      notes,
      // --no-proxy means we didn't touch the agent's runtime; restart would be meaningless.
      restart: null,
    };
  }

  if (detect.binaryPath === resolve(paths.bin, spec.binaries[0]!)) {
    throw new ThomasError({
      code: "E_CONFIG_CONFLICT",
      message: `detected binary at '${detect.binaryPath}' looks like an existing thomas shim`,
      remediation: "Run `thomas disconnect` first, or check your PATH",
      details: { agent: spec.id, path: detect.binaryPath },
    });
  }

  const token = `thomas-${spec.id}-${randomBytes(16).toString("hex")}`;
  const shimContext = { thomasUrl: `http://127.0.0.1:${cfg.port}`, thomasToken: token };

  let shimPath: string | undefined;
  if (spec.shimEnv && Object.keys(spec.shimEnv).length > 0) {
    shimPath = await installShim({
      agent: spec,
      thomasInvocation: resolveThomasInvocation(),
      originalBinary: detect.binaryPath,
      port: cfg.port,
      token,
    });
  }

  let snapshot: AgentSnapshot | undefined;
  let snapshotPath: string | null = null;
  if (spec.applyConfig) {
    snapshot = await spec.applyConfig(shimContext);
    snapshotPath = await writeSnapshot(snapshot);
  }

  // Static PATH check: did the shim actually take precedence over the original
  // binary? If not, every future agent invocation will hit the real binary
  // without our env vars set, and (for config-mode agents) the patched config
  // becomes a load-bearing reference to a token that's never present.
  if (shimPath) {
    const verification = verifyShimWins(detect.binaryPath);
    if (!verification.ok) {
      await rollbackConnect(spec, snapshot);
      throw shimNotOnPathError(spec, detect.binaryPath, verification);
    }
  }

  await recordConnect(spec.id, {
    shimPath: shimPath ?? "",
    originalBinary: detect.binaryPath,
    connectedAt: new Date().toISOString(),
    token,
  });

  await ensureRunning(cfg.port);

  const restart = await maybeRestart(spec, opts.restartAgent, notes);

  // Only ask the user to reload PATH if binDir was already on PATH (i.e. the
  // shim wins) — that's the case where a fresh shell will pick it up. If
  // binDir wasn't on PATH we'd have rejected above with E_SHIM_NOT_ON_PATH.
  return {
    agent: spec.id,
    shimPath: shimPath ?? null,
    credentialsImported: importedProviders,
    configMutated: !!spec.applyConfig,
    snapshotPath,
    requiresShellReload: false,
    providerProbes,
    notes,
    restart,
  };
}

/** Run spec.restart() if requested, append a human-readable note when relevant.
 *  Failure here NEVER fails the parent command — the main path already succeeded;
 *  restart is best-effort. The agent driving thomas reads the structured `restart`
 *  field and decides what to do. */
async function maybeRestart(
  spec: AgentSpec,
  requested: boolean | undefined,
  notes: string[],
): Promise<RestartOutcome | null> {
  if (!requested) return null;
  if (!spec.restart) {
    const note = `--restart-agent ignored: ${spec.displayName} has no automated restart hook (shim-env agents are picked up on next process spawn — open a fresh shell or restart the agent manually).`;
    notes.push(note);
    return {
      attempted: false,
      ok: false,
      method: "n/a",
      message: note,
    };
  }
  const outcome = await spec.restart();
  if (!outcome.ok) {
    notes.push(
      `--restart-agent: ${outcome.message}. Connect itself succeeded; the daemon may already have restarted (timeouts in particular don't necessarily mean failure). If the agent still uses old config, run \`${spec.binaries[0]} daemon restart\` manually.`,
    );
  }
  return outcome;
}

function toWireProbe(p: ProbeResult): ProviderProbe {
  if (p.ok) {
    return { provider: p.provider, ok: true, status: p.status, url: p.url, latencyMs: p.latencyMs };
  }
  return {
    provider: p.provider,
    ok: false,
    reason: p.reason,
    status: p.status,
    url: p.url,
    latencyMs: p.latencyMs,
    message: p.message,
  };
}

function appendProbeNotes(notes: string[], probes: ProbeResult[]): void {
  for (const p of probes) {
    if (p.ok) continue;
    if (p.reason === "wrong_path") {
      notes.push(
        `Provider '${p.provider}' looks misconfigured: 404 at ${p.url}. The base URL probably doesn't exist on this server. Verify with \`curl -I ${p.url}\`, then re-register: \`thomas providers register ${p.provider} --protocol <openai|anthropic> --base-url <correct-url>\`.`,
      );
    } else if (p.reason === "unreachable") {
      notes.push(
        `Provider '${p.provider}' was unreachable when probing ${p.url} (${p.message}). If it's an offline/local endpoint that's fine — start it before routing traffic. Otherwise check the base URL.`,
      );
    } else if (p.reason === "auth_failed") {
      notes.push(
        `Provider '${p.provider}' rejected the imported credential (HTTP ${p.status} at ${p.url}). The base URL is reachable, so this is likely a key/token issue. For OAuth-only providers (e.g. Claude Code), this is expected — replace with an API key via \`thomas providers add ${p.provider} <key>\`.`,
      );
    } else if (p.reason === "models_unavailable") {
      notes.push(
        `Provider '${p.provider}' could not be conclusively probed at ${p.url} (HTTP ${p.status}). The base URL may be correct (some servers reject probe requests like anthropic does) or it may be wrong — confirm by routing a real request through thomas.`,
      );
    } else {
      notes.push(
        `Provider '${p.provider}' probe at ${p.url} returned HTTP ${p.status}. Server is reachable but in an unexpected state.`,
      );
    }
  }
}

async function rollbackConnect(spec: AgentSpec, snapshot: AgentSnapshot | undefined): Promise<void> {
  if (snapshot && spec.revertConfig) {
    await spec.revertConfig(snapshot).catch(() => undefined);
    await deleteSnapshot(spec.id);
  }
  await removeShim(spec).catch(() => undefined);
}

function shimNotOnPathError(
  spec: AgentSpec,
  originalBinary: string,
  v: Extract<ShimVerification, { ok: false }>,
): ThomasError {
  const exportLine = `export PATH="${v.binDir}:$PATH"`;
  const rcHint = guessShellRc();
  const reasonText =
    v.reason === "missing"
      ? `the thomas shim directory (${v.binDir}) is not on your $PATH`
      : `the thomas shim directory (${v.binDir}) is on $PATH but appears AFTER ${v.originalDir}, so the original ${spec.binaries[0]} still wins`;
  return new ThomasError({
    code: "E_SHIM_NOT_ON_PATH",
    message: `cannot connect ${spec.displayName}: ${reasonText}. Reverted all changes.`,
    remediation: `Add this line to ${rcHint}, start a new shell, then re-run \`thomas connect ${spec.id}\`:\n  ${exportLine}`,
    details: {
      agent: spec.id,
      reason: v.reason,
      binDir: v.binDir,
      originalBinary,
      originalDir: v.originalDir,
      pathEntries: v.pathEntries,
    },
  });
}

function guessShellRc(): string {
  const shell = process.env.SHELL ?? "";
  if (shell.endsWith("/zsh")) return "~/.zshrc";
  if (shell.endsWith("/bash")) return "~/.bashrc (or ~/.bash_profile on macOS login shells)";
  if (shell.endsWith("/fish")) return "~/.config/fish/config.fish";
  return "your shell's rc file (~/.zshrc, ~/.bashrc, etc.)";
}

function buildNotes(
  spec: AgentSpec,
  importedProviders: string[],
  restartAgentFlag: boolean,
): string[] {
  const notes: string[] = [];
  if (spec.id === "claude-code" && importedProviders.includes("anthropic")) {
    notes.push(
      "Claude Code stores an OAuth token, which Anthropic's public API does not accept. To actually proxy traffic, add an Anthropic API key with `thomas providers add anthropic <sk-ant-...>` then `thomas route claude-code <provider/model>`.",
    );
  }
  // openclaw on macOS: plist was mutated to inject THOMAS_OPENCLAW_TOKEN.
  // launchd caches EnvironmentVariables at service-load time, so a running
  // LaunchAgent-managed daemon won't see the new var until the service is
  // bootstrap'd. Without --restart-agent (which does that for them), the user
  // is in a "config edited but daemon ignores it" limbo — flag it loudly.
  if (spec.id === "openclaw" && process.platform === "darwin" && !restartAgentFlag) {
    notes.push(
      "OpenClaw daemon is still running with its previously-loaded environment. Pass `--restart-agent` (or run `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/ai.openclaw.gateway.plist && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.openclaw.gateway.plist`) so it picks up THOMAS_OPENCLAW_TOKEN — otherwise every openclaw request will 401.",
    );
  }
  return notes;
}

function printConnect(d: ConnectData, opts: ConnectOptions): void {
  const spec = getAgent(d.agent);
  const display = spec?.displayName ?? d.agent;

  if (opts.noProxy) {
    console.log(
      `Imported ${d.credentialsImported.length} credential(s) from ${display}: ${
        d.credentialsImported.join(", ") || "(none)"
      }`,
    );
    console.log("No shim installed (--no-proxy).");
    return;
  }

  console.log(`Connected ${display}.`);
  if (d.shimPath) {
    console.log(`  shim:     ${d.shimPath}`);
  }
  if (d.configMutated) {
    console.log(`  config:   patched (snapshot stored, \`thomas disconnect\` reverts)`);
  }
  if (d.credentialsImported.length > 0) {
    console.log(`  imported: ${d.credentialsImported.join(", ")}`);
  }
  if (d.restart && d.restart.attempted) {
    console.log(`  restart:  ${d.restart.ok ? "ok" : "FAILED"} (${d.restart.method})`);
  }
  console.log("");
  for (const note of d.notes) {
    console.log(`Note: ${note}`);
    console.log("");
  }
}

async function importCredentials(spec: AgentSpec): Promise<string[]> {
  if (!spec.extractCredentials) return [];
  const extracted = await spec.extractCredentials();
  const imported: string[] = [];
  for (const item of extracted) {
    await upsertCredential(item.credential);
    imported.push(item.credential.provider);
    if (item.provider) {
      const existing = await getProvider(item.provider.id);
      if (!existing) {
        try {
          await registerCustom(item.provider);
        } catch {
          // race with built-in or duplicate write — safe to ignore
        }
      }
    }
  }
  return imported;
}
