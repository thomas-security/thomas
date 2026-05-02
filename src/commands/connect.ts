import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { recordConnect } from "../config/agents.js";
import { readConfig } from "../config/config.js";
import { upsertCredential } from "../config/credentials.js";
import { paths } from "../config/paths.js";
import { setRoute } from "../config/routes.js";
import { writeSnapshot } from "../config/snapshots.js";
import { getAgent } from "../agents/registry.js";
import type { AgentSpec } from "../agents/types.js";
import { ensureRunning } from "../daemon/lifecycle.js";
import { getProvider, registerCustom } from "../providers/registry.js";
import { installShim } from "../shim/install.js";
import { resolveThomasInvocation } from "../shim/quote.js";

export type ConnectOptions = {
  agentId: string;
  noImport?: boolean;
  noProxy?: boolean;
};

export async function connect(opts: ConnectOptions): Promise<number> {
  const spec = getAgent(opts.agentId);
  if (!spec) {
    console.error(`thomas: unknown agent '${opts.agentId}'`);
    console.error("Supported: claude-code, codex, openclaw, hermes");
    return 1;
  }

  const detect = await spec.detect();
  if (!detect.installed || !detect.binaryPath) {
    console.error(`thomas: ${spec.displayName} is not installed on this machine.`);
    return 1;
  }

  const cfg = await readConfig();
  const importedProviders = !opts.noImport ? await importCredentials(spec) : [];

  if (importedProviders.length > 0) {
    const defaultProvider = importedProviders[0]!;
    await setRoute(spec.id, { provider: defaultProvider, model: "passthrough" });
  }

  if (opts.noProxy) {
    console.log(
      `Imported ${importedProviders.length} credential(s) from ${spec.displayName}: ${
        importedProviders.join(", ") || "(none)"
      }`,
    );
    console.log("No shim installed (--no-proxy).");
    return 0;
  }

  if (detect.binaryPath === resolve(paths.bin, spec.binaries[0]!)) {
    console.error(
      `thomas: detected binary at '${detect.binaryPath}' looks like an existing thomas shim.`,
    );
    console.error("Run `thomas disconnect` first, or check your PATH.");
    return 1;
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

  if (spec.applyConfig) {
    const snapshot = await spec.applyConfig(shimContext);
    await writeSnapshot(snapshot);
  }

  await recordConnect(spec.id, {
    shimPath: shimPath ?? "",
    originalBinary: detect.binaryPath,
    connectedAt: new Date().toISOString(),
    token,
  });

  await ensureRunning(cfg.port);

  console.log(`Connected ${spec.displayName}.`);
  if (shimPath) {
    console.log(`  shim:     ${shimPath}`);
    console.log(`  original: ${detect.binaryPath}`);
  } else {
    console.log(`  binary:   ${detect.binaryPath}`);
  }
  if (spec.applyConfig) {
    console.log(`  config:   patched (snapshot stored, \`thomas disconnect\` reverts)`);
  }
  if (importedProviders.length > 0) {
    console.log(`  imported: ${importedProviders.join(", ")}`);
  }
  console.log("");
  if (spec.id === "claude-code" && importedProviders.includes("anthropic")) {
    console.log(
      "Note: Claude Code stores an OAuth token, which Anthropic's public API does not accept.",
    );
    console.log(
      "      To actually proxy traffic, add an Anthropic API key or pick another provider:",
    );
    console.log(`        thomas providers add anthropic <sk-ant-...>`);
    console.log(`        thomas route ${spec.id} <provider/model>`);
    console.log("");
  }
  if (shimPath) {
    console.log("Add this to your shell rc so the shim takes priority:");
    console.log(`  export PATH="${paths.bin}:$PATH"`);
    console.log("Then start a new shell session, or:  source ~/.zshrc  (or ~/.bashrc)");
  }
  return 0;
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
