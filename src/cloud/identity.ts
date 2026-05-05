// Read / write ~/.thomas/cloud.json — the device token + workspace binding.
//
// The device token is a bearer secret. It's stored at 0600 (already enforced by
// io.writeJsonAtomic) and never leaves this file at runtime — clients pass it
// to fetch() via Authorization headers.

import { unlink } from "node:fs/promises";

import { readJson, writeJsonAtomic } from "../config/io.js";
import { paths } from "../config/paths.js";
import type { CloudIdentity } from "./types.js";

export async function readIdentity(): Promise<CloudIdentity | undefined> {
  const value = await readJson<CloudIdentity | null>(paths.cloud, null);
  return value ?? undefined;
}

export async function writeIdentity(identity: CloudIdentity): Promise<void> {
  await writeJsonAtomic(paths.cloud, identity);
}

export async function clearIdentity(): Promise<boolean> {
  try {
    await unlink(paths.cloud);
    return true;
  } catch {
    return false;
  }
}

export async function updateLastSync(syncedAt: string): Promise<void> {
  const identity = await readIdentity();
  if (!identity) return;
  await writeIdentity({ ...identity, lastSyncAt: syncedAt });
}

/**
 * Default base URL for the SaaS. Override with THOMAS_CLOUD_BASE_URL for
 * local dev (e.g. http://localhost:8000) or a private deployment.
 */
export function defaultBaseUrl(): string {
  return process.env.THOMAS_CLOUD_BASE_URL?.replace(/\/+$/, "") ?? "https://thomas.trustunknown.com";
}
