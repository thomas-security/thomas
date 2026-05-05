// `thomas cloud sync` — pull /v1/sync from thomas-cloud, write the snapshot
// to ~/.thomas/cloud-cache.json. v1 the snapshot is empty (the cloud doesn't
// hold any policy data yet); the local proxy already reads from this cache
// path so the wiring is exercised end-to-end even with empty results.

import { runJson } from "../../cli/json.js";
import type { CloudSyncData } from "../../cli/output.js";
import { syncFromCloud } from "../../cloud/sync.js";

export async function cloudSync(opts: { json: boolean }): Promise<number> {
  return runJson({
    command: "cloud.sync",
    json: opts.json,
    fetch: async (): Promise<CloudSyncData> => {
      const snap = await syncFromCloud();
      return {
        schemaVersion: snap.schemaVersion,
        policiesCount: snap.policies.length,
        bundlesCount: snap.bundles.length,
        bindingsCount: snap.bindings.length,
        providersCount: snap.providers.length,
        redactRulesVersion: snap.redactRulesVersion,
        syncedAt: snap.syncedAt,
      };
    },
    printHuman: (d) => {
      console.log(
        `Synced at ${d.syncedAt}: ${d.policiesCount} policies, ${d.bundlesCount} bundles, ` +
          `${d.bindingsCount} bindings, ${d.providersCount} providers.`,
      );
    },
  });
}
