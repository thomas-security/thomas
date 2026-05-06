import { spawn } from "node:child_process";
import { access, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RestartOutcome } from "./types.js";

const TOKEN_ENV = "THOMAS_OPENCLAW_TOKEN";
const ENV_KEY = "EnvironmentVariables";

/** macOS LaunchAgent plist path. Override via env for tests so we never touch a
 *  real installation by accident. The default points at openclaw's documented
 *  service file (`ai.openclaw.gateway.plist`). */
export function launchAgentPlistPath(): string {
  return (
    process.env.THOMAS_OPENCLAW_LAUNCHD_PLIST ??
    join(homedir(), "Library", "LaunchAgents", "ai.openclaw.gateway.plist")
  );
}

async function fileExists(p: string): Promise<boolean> {
  return access(p).then(
    () => true,
    () => false,
  );
}

type PlutilResult = { code: number; stdout: string; stderr: string };

async function execPlutil(args: string[]): Promise<PlutilResult> {
  return execTool("plutil", args);
}

async function execTool(cmd: string, args: string[]): Promise<PlutilResult> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString();
    });
    proc.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    proc.on("error", (err) => {
      resolve({ code: 1, stdout, stderr: stderr + err.message });
    });
    proc.on("exit", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function readPlistAsJson(path: string): Promise<Record<string, unknown>> {
  const r = await execPlutil(["-convert", "json", "-o", "-", path]);
  if (r.code !== 0) {
    throw new Error(`plutil read '${path}' failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  }
  return JSON.parse(r.stdout) as Record<string, unknown>;
}

async function writePlistFromJson(path: string, contents: Record<string, unknown>): Promise<void> {
  // Round-trip via plutil so the on-disk format stays canonical XML plist.
  // Two temp files: one for the JSON input we feed plutil, one for the XML
  // plutil produces. We never overwrite `path` until the converted XML is
  // ready, so a crash mid-write can't corrupt the live LaunchAgent file.
  const tmpJson = `${path}.thomas-${process.pid}-${Date.now()}.in.json`;
  const tmpXml = `${path}.thomas-${process.pid}-${Date.now()}.out.plist`;
  try {
    await writeFile(tmpJson, JSON.stringify(contents));
    const r = await execPlutil(["-convert", "xml1", "-o", tmpXml, tmpJson]);
    if (r.code !== 0) {
      throw new Error(`plutil convert failed: ${r.stderr.trim() || `exit ${r.code}`}`);
    }
    await rename(tmpXml, path);
  } finally {
    await unlink(tmpJson).catch(() => undefined);
    await unlink(tmpXml).catch(() => undefined);
  }
}

export type PlistMutationResult = {
  /** True iff the plist file was actually rewritten. False when no plist exists
   *  (Linux, foreground-only openclaw) or the requested change was already in place. */
  touched: boolean;
  path: string;
};

/** Surgically add `THOMAS_OPENCLAW_TOKEN=<token>` to the LaunchAgent plist's
 *  `EnvironmentVariables` dict. Creates that dict if it doesn't exist. Never
 *  modifies any other key — sibling env vars the user added stay intact. */
export async function addThomasTokenToPlist(token: string): Promise<PlistMutationResult> {
  const path = launchAgentPlistPath();
  if (process.platform !== "darwin" || !(await fileExists(path))) {
    return { touched: false, path };
  }
  const contents = await readPlistAsJson(path);
  const env = readEnvDict(contents);
  if (env[TOKEN_ENV] === token) return { touched: false, path };
  env[TOKEN_ENV] = token;
  contents[ENV_KEY] = env;
  await writePlistFromJson(path, contents);
  return { touched: true, path };
}

/** Inverse of `addThomasTokenToPlist`: drop our key. If the dict ends up empty
 *  (i.e. we created it during connect), drop the dict too — leaves the plist
 *  byte-identical to "openclaw with no env vars set", which is the common
 *  pre-thomas state. Other entries the user had stay untouched. */
export async function removeThomasTokenFromPlist(): Promise<PlistMutationResult> {
  const path = launchAgentPlistPath();
  if (process.platform !== "darwin" || !(await fileExists(path))) {
    return { touched: false, path };
  }
  const contents = await readPlistAsJson(path);
  const env = readEnvDict(contents);
  if (!(TOKEN_ENV in env)) return { touched: false, path };
  delete env[TOKEN_ENV];
  if (Object.keys(env).length === 0) {
    delete contents[ENV_KEY];
  } else {
    contents[ENV_KEY] = env;
  }
  await writePlistFromJson(path, contents);
  return { touched: true, path };
}

/** Force launchd to re-read the LaunchAgent plist and respawn the daemon.
 *
 *  Why this and not `openclaw daemon restart`: openclaw's CLI uses
 *  `launchctl kickstart -k` which only restarts the process — launchd keeps
 *  the previously-loaded plist (including its EnvironmentVariables dict) in
 *  memory. After we mutate the plist, kickstart won't pick up the new env
 *  vars; only `bootout + bootstrap` (or the legacy `unload + load`) does. */
export async function reloadLaunchAgent(plistPath: string): Promise<RestartOutcome> {
  const startedAt = Date.now();
  const method = "launchctl bootout + bootstrap";
  if (process.platform !== "darwin") {
    return {
      attempted: false,
      ok: false,
      method,
      message: "launchctl reload is macOS-only",
    };
  }
  const uid = (process as unknown as { getuid?: () => number }).getuid?.() ?? 0;
  const target = `gui/${uid}`;
  // bootout is best-effort: the service may not currently be loaded (foreground
  // openclaw, prior failed connect, fresh install). We swallow that error and
  // proceed; if bootstrap then fails, the user gets the real failure.
  await execTool("launchctl", ["bootout", target, plistPath]).catch(() => undefined);
  const r = await execTool("launchctl", ["bootstrap", target, plistPath]);
  const durationMs = Date.now() - startedAt;
  if (r.code !== 0) {
    return {
      attempted: true,
      ok: false,
      method,
      message: `${method} failed: ${r.stderr.trim() || `exit ${r.code}`}`,
      exitCode: r.code,
      durationMs,
    };
  }
  return {
    attempted: true,
    ok: true,
    method,
    message: `${method} completed`,
    exitCode: 0,
    durationMs,
  };
}

export async function plistExists(path = launchAgentPlistPath()): Promise<boolean> {
  return fileExists(path);
}

function readEnvDict(contents: Record<string, unknown>): Record<string, string> {
  const raw = contents[ENV_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
