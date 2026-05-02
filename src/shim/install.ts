import { chmod, mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../config/paths.js";
import type { AgentSpec, ShimContext } from "../agents/types.js";
import { CMD_TEMPLATE, SH_TEMPLATE } from "./templates.js";

type ShimParams = {
  agent: AgentSpec;
  /** Already shell-quoted command line that invokes thomas (e.g., `/path/to/node /path/to/cli.js` or `/usr/local/bin/thomas`). */
  thomasInvocation: string;
  originalBinary: string;
  port: number;
  token: string;
};

export async function installShim(params: ShimParams): Promise<string> {
  await mkdir(paths.bin, { recursive: true });
  if (process.platform === "win32") {
    return writeShim(params, "cmd");
  }
  return writeShim(params, "sh");
}

async function writeShim(params: ShimParams, kind: "sh" | "cmd"): Promise<string> {
  const tpl = kind === "sh" ? SH_TEMPLATE : CMD_TEMPLATE;
  const ext = kind === "sh" ? "" : ".cmd";
  const shimPath = join(paths.bin, `${params.agent.binaries[0]}${ext}`);
  const ctx: ShimContext = {
    thomasUrl: `http://127.0.0.1:${params.port}`,
    thomasToken: params.token,
  };
  const block = renderEnvBlock(params.agent.shimEnv ?? {}, ctx, kind);
  const body = tpl
    .replaceAll("__AGENT_ID__", params.agent.id)
    .replaceAll("__THOMAS_INVOCATION__", params.thomasInvocation)
    .replaceAll("__ORIGINAL__", params.originalBinary)
    .replaceAll("__PORT__", String(params.port))
    .replaceAll("__SHIM_ENV_BLOCK__", block);
  await writeFile(shimPath, body);
  if (kind === "sh") await chmod(shimPath, 0o755);
  return shimPath;
}

function expand(value: string, ctx: ShimContext): string {
  return value.replaceAll("${THOMAS_URL}", ctx.thomasUrl).replaceAll("${THOMAS_TOKEN}", ctx.thomasToken);
}

export function renderEnvBlock(
  envVars: Record<string, string>,
  ctx: ShimContext,
  kind: "sh" | "cmd",
): string {
  const lines: string[] = [];
  for (const [name, raw] of Object.entries(envVars)) {
    const value = expand(raw, ctx);
    lines.push(kind === "sh" ? `export ${name}=${shQuote(value)}` : `set "${name}=${cmdEscape(value)}"`);
  }
  return lines.join("\n");
}

function shQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

function cmdEscape(s: string): string {
  return s.replaceAll("%", "%%").replaceAll('"', '""');
}

export async function removeShim(agent: AgentSpec): Promise<void> {
  const ext = process.platform === "win32" ? ".cmd" : "";
  const shimPath = join(paths.bin, `${agent.binaries[0]}${ext}`);
  await unlink(shimPath).catch(() => undefined);
}
