// Device-code grant flow on the client side.
//
// Mirrors RFC 8628 polling shape, matched 1:1 to apps/api/app/api/devices.py:
//   1. POST /v1/devices/begin            → { device_code, user_code, verification_uri, interval, expires_in }
//   2. user opens the URL, signs in, approves
//   3. POST /v1/devices/poll              → 400 authorization_pending (loop) | 200 { device_token, ... }
//
// The polling loop is the only place this CLI does an interactive long-poll.
// We respect the server-provided interval; on 400 authorization_pending we
// keep going; on any other 4xx/5xx we surface immediately.

import { ThomasError } from "../cli/json.js";
import { cloudFetch, cloudPostJson, type CloudFetchOptions } from "./client.js";
import type { DeviceBeginRequest, DeviceBeginResponse, DevicePollResponse } from "./types.js";

export type LoginProgress =
  | { kind: "begun"; userCode: string; verificationUri: string; verificationUriComplete: string; intervalMs: number; expiresInMs: number }
  | { kind: "still_pending" }
  | { kind: "approved"; result: DevicePollResponse };

export async function beginDeviceLogin(
  req: DeviceBeginRequest,
  opts: CloudFetchOptions,
): Promise<DeviceBeginResponse> {
  return cloudPostJson<DeviceBeginResponse>("/v1/devices/begin", req, opts);
}

export type PollDeviceLoginOptions = CloudFetchOptions & {
  deviceCode: string;
  /** ms; defaults to begin response's interval. Floored at 1s. */
  intervalMs: number;
  /** Total wall-clock budget; loop exits once exceeded. */
  expiresAt: number;
  /** Called once per poll iteration so the caller can render a spinner / abort. */
  onTick?: () => boolean | void;
};

/** Loops until approved, expired, or onTick returns false. */
export async function pollDeviceLogin(
  opts: PollDeviceLoginOptions,
): Promise<DevicePollResponse> {
  const interval = Math.max(1000, opts.intervalMs);
  // Tiny initial delay so the user sees the URL before we start hammering.
  await sleep(interval);
  while (Date.now() < opts.expiresAt) {
    if (opts.onTick && opts.onTick() === false) {
      throw new ThomasError({
        code: "E_INTERNAL",
        message: "login aborted by caller",
      });
    }
    const resp = await cloudFetch(
      "/v1/devices/poll",
      { method: "POST", body: JSON.stringify({ device_code: opts.deviceCode }) },
      opts,
    );
    if (resp.ok) {
      return (await resp.json()) as DevicePollResponse;
    }
    // 400 with detail.error == "authorization_pending" → keep waiting.
    // Any other status → surface immediately.
    let detail: { error?: string } | undefined;
    try {
      const body = (await resp.json()) as { detail?: { error?: string } };
      detail = body.detail;
    } catch {
      // ignore parse errors; fall through to the generic-error path
    }
    if (resp.status === 400 && detail?.error === "authorization_pending") {
      await sleep(interval);
      continue;
    }
    if (resp.status === 400 && detail?.error === "expired_token") {
      throw new ThomasError({
        code: "E_CLOUD_TIMEOUT",
        message: "device code expired before approval",
        remediation: "Run `thomas cloud login` again.",
      });
    }
    throw new ThomasError({
      code: "E_CLOUD_UNAUTHORIZED",
      message: `unexpected ${resp.status} from /v1/devices/poll`,
      details: detail ?? null,
    });
  }
  throw new ThomasError({
    code: "E_CLOUD_TIMEOUT",
    message: "login timed out before approval",
    remediation: "Run `thomas cloud login` again and approve in the browser within the time limit.",
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
