// Read / write ~/.thomas/cloud-cache.json — the snapshot pulled from /v1/sync.

import { readJson, writeJsonAtomic } from "../config/io.js";
import { paths } from "../config/paths.js";
import type { CloudSnapshot } from "./types.js";

const EMPTY: CloudSnapshot = {
  schemaVersion: 1,
  policies: [],
  bundles: [],
  bindings: [],
  providers: [],
  redactRulesVersion: null,
  syncedAt: "",
};

export async function readCache(): Promise<CloudSnapshot> {
  return readJson<CloudSnapshot>(paths.cloudCache, EMPTY);
}

export async function writeCache(snapshot: CloudSnapshot): Promise<void> {
  await writeJsonAtomic(paths.cloudCache, snapshot);
}
