// `thomas cloud login` — interactive device-code grant.
//
// Login is the only `thomas cloud …` command that's intrinsically interactive
// (it long-polls the API while the user authorizes in a browser). We don't
// support `--json` here because there's no clean structured representation
// of "I'm waiting for you, refresh". The other cloud verbs (whoami / sync)
// support `--json` normally.

import { hostname, platform } from "node:os";

import { beginDeviceLogin, pollDeviceLogin } from "../../cloud/device.js";
import { defaultBaseUrl, readIdentity, writeIdentity } from "../../cloud/identity.js";
import type { CloudIdentity } from "../../cloud/types.js";

export type LoginOptions = {
  /** Override the default base URL (useful for local dev or private deploy). */
  baseUrl?: string;
  /** Label for this device shown in the cloud UI. Defaults to hostname. */
  label?: string;
};

export async function cloudLogin(opts: LoginOptions = {}): Promise<number> {
  const baseUrl = opts.baseUrl ?? defaultBaseUrl();
  const label = opts.label ?? hostname();

  const existing = await readIdentity();
  if (existing) {
    process.stderr.write(
      `Already logged in as device ${existing.deviceId} on ${existing.baseUrl}.\n` +
        `Run \`thomas cloud logout\` first if you want to switch accounts.\n`,
    );
    return 1;
  }

  const begin = await beginDeviceLogin(
    {
      label,
      platform: platform(),
      thomas_version: getThomasVersion(),
    },
    { baseUrl },
  );

  process.stderr.write(
    `\nTo finish signing in, open this URL in your browser:\n` +
      `  ${begin.verification_uri_complete}\n\n` +
      `Or visit ${begin.verification_uri} and enter:\n` +
      `  ${begin.user_code}\n\n` +
      `Waiting for approval (expires in ${Math.floor(begin.expires_in / 60)} min)…\n`,
  );

  const expiresAt = Date.now() + begin.expires_in * 1000;
  const result = await pollDeviceLogin({
    baseUrl,
    deviceCode: begin.device_code,
    intervalMs: begin.interval * 1000,
    expiresAt,
  });

  const identity: CloudIdentity = {
    baseUrl,
    deviceToken: result.device_token,
    deviceId: result.device_id,
    workspaceId: result.workspace_id,
    loggedInAt: new Date().toISOString(),
  };
  await writeIdentity(identity);

  process.stderr.write(
    `\n✓ Logged in. Device ${result.device_id} attached to workspace ${result.workspace_id}.\n` +
      `   Token stored at ~/.thomas/cloud.json\n` +
      `   Run \`thomas cloud sync\` to pull policy + bundle config.\n`,
  );
  return 0;
}

function getThomasVersion(): string {
  // package.json#version is bundled at build; in dev we read from process.env or fall back.
  return process.env.THOMAS_VERSION ?? "dev";
}
