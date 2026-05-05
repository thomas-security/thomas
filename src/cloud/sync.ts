// One-shot pull from /v1/sync. Returns the snapshot AND writes it to the
// on-disk cache as a side effect — both reads and the write are part of
// `thomas cloud sync`.

import { ThomasError } from "../cli/json.js";
import { writeCache } from "./cache.js";
import { cloudGetJson, type CloudFetchOptions } from "./client.js";
import { readIdentity, updateLastSync } from "./identity.js";
import type { CloudSnapshot } from "./types.js";

type SyncWireResponse = {
  schemaVersion: number;
  policies: unknown[];
  bundles: unknown[];
  bindings: unknown[];
  providers: unknown[];
  redactRulesVersion: string | null;
};

export async function syncFromCloud(): Promise<CloudSnapshot> {
  const identity = await readIdentity();
  if (!identity) {
    throw new ThomasError({
      code: "E_CLOUD_NOT_LOGGED_IN",
      message: "no cloud login on this machine",
      remediation: "Run `thomas cloud login` first.",
    });
  }
  const opts: CloudFetchOptions = {
    baseUrl: identity.baseUrl,
    deviceToken: identity.deviceToken,
  };
  const wire = await cloudGetJson<SyncWireResponse>("/v1/sync", opts);
  const syncedAt = new Date().toISOString();
  const snapshot: CloudSnapshot = {
    schemaVersion: 1,
    policies: wire.policies ?? [],
    bundles: wire.bundles ?? [],
    bindings: wire.bindings ?? [],
    providers: wire.providers ?? [],
    redactRulesVersion: wire.redactRulesVersion ?? null,
    syncedAt,
  };
  await writeCache(snapshot);
  await updateLastSync(syncedAt);
  return snapshot;
}
