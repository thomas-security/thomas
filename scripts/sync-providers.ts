#!/usr/bin/env bun
/**
 * Drift detector for thomas's per-agent provider mirrors.
 *
 * Reads:
 *   references/hermes-agent/hermes_cli/{auth.py, providers.py}
 *   references/openclaw/extensions/<ext>/openclaw.plugin.json
 * Compares against:
 *   src/providers/agents/hermes.generated.ts
 *
 * Prints additions / removals / unrecognized entries so we know when upstream evolves.
 * Does NOT auto-edit the generated files — review the diff and hand-apply.
 *
 * Usage:  bun run scripts/sync-providers.ts
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { HERMES_PROVIDERS } from "../src/providers/agents/hermes.generated.js";

const ROOT = resolve(import.meta.dirname, "..");
const HERMES_DIR = join(ROOT, "references", "hermes-agent");
const OPENCLAW_DIR = join(ROOT, "references", "openclaw");

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function scanHermes(): Promise<{ providerIds: Set<string>; envKeys: Map<string, string[]> }> {
  // Source of truth: PROVIDER_REGISTRY in auth.py. providers.py overlays use renamed
  // canonical IDs (e.g. vercel ↔ ai-gateway) that are display-layer aliases, not creds.
  const providerIds = new Set<string>();
  const envKeys = new Map<string, string[]>();
  const path = join(HERMES_DIR, "hermes_cli/auth.py");
  if (!(await exists(path))) return { providerIds, envKeys };
  const src = await readFile(path, "utf8");
  const idRe = /^    "([a-z][a-z0-9_-]*)": ProviderConfig\(/gm;
  for (const m of src.matchAll(idRe)) providerIds.add(m[1]!);
  const envBlockRe = /"([a-z][a-z0-9_-]*)": ProviderConfig\([\s\S]*?api_key_env_vars=\(([\s\S]*?)\)/g;
  for (const m of src.matchAll(envBlockRe)) {
    const id = m[1]!;
    const envs = Array.from(m[2]!.matchAll(/"([A-Z_]+)"/g)).map((mm) => mm[1]!);
    if (envs.length > 0) envKeys.set(id, envs);
  }
  return { providerIds, envKeys };
}

async function scanOpenclaw(): Promise<Set<string>> {
  const out = new Set<string>();
  const extensions = join(OPENCLAW_DIR, "extensions");
  if (!(await exists(extensions))) return out;
  for (const dir of await readdir(extensions)) {
    const manifest = join(extensions, dir, "openclaw.plugin.json");
    if (!(await exists(manifest))) continue;
    try {
      const json = JSON.parse(await readFile(manifest, "utf8"));
      const providers = json.providers ?? [];
      if (Array.isArray(providers)) {
        for (const p of providers) {
          if (typeof p === "string") out.add(p);
          else if (p?.id) out.add(p.id);
        }
      } else if (typeof providers === "object") {
        for (const id of Object.keys(providers)) out.add(id);
      }
    } catch {
      // skip malformed manifest
    }
  }
  return out;
}

function diff(label: string, upstream: Set<string>, ours: Set<string>): boolean {
  const missing = [...upstream].filter((x) => !ours.has(x)).sort();
  const stale = [...ours].filter((x) => !upstream.has(x)).sort();
  console.log(`\n[${label}]`);
  console.log(`  upstream: ${upstream.size}   thomas: ${ours.size}`);
  if (missing.length === 0 && stale.length === 0) {
    console.log("  ✓ in sync");
    return true;
  }
  if (missing.length > 0) console.log(`  + add (upstream-only):    ${missing.join(", ")}`);
  if (stale.length > 0) console.log(`  - remove (thomas-only):   ${stale.join(", ")}`);
  return false;
}

async function main(): Promise<void> {
  if (!(await exists(HERMES_DIR)) && !(await exists(OPENCLAW_DIR))) {
    console.error("references/hermes-agent or references/openclaw not found.");
    console.error("Clone them under references/ to run drift detection.");
    process.exit(2);
  }

  let ok = true;

  if (await exists(HERMES_DIR)) {
    const { providerIds, envKeys } = await scanHermes();
    const ours = new Set(HERMES_PROVIDERS.map((p) => p.thomasId));
    const upstream = new Set(providerIds);
    // OAuth-only and special-auth (AWS SDK / Azure with user-supplied baseUrl) providers
    // are intentionally excluded from thomas's env-var pickup mirror.
    for (const id of [
      "nous", "openai-codex", "qwen-oauth", "google-gemini-cli", "minimax-oauth", "copilot-acp",
      "bedrock", "azure-foundry",
    ]) {
      upstream.delete(id);
    }
    // BUILTINs in thomas that hermes resolves via models.dev catalog rather than auth.py
    // PROVIDER_REGISTRY (or via the openrouter-aggregator fallback path).
    for (const id of ["openai", "groq", "openrouter", "kimi"]) {
      ours.add(id);
      upstream.add(id);
    }
    ok = diff("hermes", upstream, ours) && ok;

    // Surface env-key drift for the providers we do mirror
    const envDrift: string[] = [];
    for (const entry of HERMES_PROVIDERS) {
      const upstreamEnvs = envKeys.get(entry.thomasId);
      if (!upstreamEnvs) continue;
      const oursEnvs = new Set(entry.envKeys);
      const missing = upstreamEnvs.filter((e) => !oursEnvs.has(e));
      if (missing.length > 0) envDrift.push(`  ${entry.thomasId}: missing env aliases ${missing.join(", ")}`);
    }
    if (envDrift.length > 0) {
      console.log("\n  env-alias drift:");
      for (const line of envDrift) console.log(line);
      ok = false;
    }
  }

  if (await exists(OPENCLAW_DIR)) {
    const upstream = await scanOpenclaw();
    // For openclaw we don't mirror provider IDs at runtime — the spec reads ~/.openclaw/openclaw.json
    // for each user's installed providers. Just print the upstream catalog so we know what to expect.
    console.log(`\n[openclaw]`);
    console.log(`  upstream provider IDs (informational, ${upstream.size}): ${[...upstream].sort().join(", ")}`);
  }

  if (!ok) {
    console.error("\nDrift detected. Update src/providers/agents/hermes.generated.ts to match.");
    process.exit(1);
  }
  console.log("\nAll generated mirrors are in sync.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
