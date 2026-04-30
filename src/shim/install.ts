import { chmod, mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../config/paths.js";
import type { AgentSpec } from "../agents/types.js";
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
  const baseUrlPath = params.agent.baseUrlPath; // "" or "/v1"
  const body = tpl
    .replaceAll("__AGENT_ID__", params.agent.id)
    .replaceAll("__THOMAS_INVOCATION__", params.thomasInvocation)
    .replaceAll("__ORIGINAL__", params.originalBinary)
    .replaceAll("__PORT__", String(params.port))
    .replaceAll("__BASE_URL_VAR__", params.agent.shimEnv.baseUrl)
    .replaceAll("__API_KEY_VAR__", params.agent.shimEnv.apiKey)
    .replaceAll("__BASE_URL_PATH__", baseUrlPath)
    .replaceAll("__TOKEN__", params.token);
  await writeFile(shimPath, body);
  if (kind === "sh") await chmod(shimPath, 0o755);
  return shimPath;
}

export async function removeShim(agent: AgentSpec): Promise<void> {
  const ext = process.platform === "win32" ? ".cmd" : "";
  const shimPath = join(paths.bin, `${agent.binaries[0]}${ext}`);
  await unlink(shimPath).catch(() => undefined);
}
