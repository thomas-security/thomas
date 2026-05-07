// `thomas cloud sync-runs` — drain runs-pending.jsonl by re-uploading to
// thomas-cloud. Idempotent server-side: re-uploading rows the cloud already
// has is counted as `duplicates` and is harmless.
//
// Behavior:
//   - reads runs-pending.jsonl atomically (rename to .draining first)
//   - posts in batches of BATCH_SIZE
//   - first failed batch stops the run; that batch + the rest go back into
//     runs-pending.jsonl for the next sync-runs invocation
//   - reports {scanned, uploaded, duplicates, remaining}
//
// Not logged in → returns 1 with E_CLOUD_NOT_LOGGED_IN. Pending file empty
// → returns 0 with all counts 0 (no-op, not an error).

import { runJson, ThomasError } from "../../cli/json.js";
import type { CloudSyncRunsData } from "../../cli/output.js";
import { readIdentity } from "../../cloud/identity.js";
import { checkoutPending, commitDrain } from "../../cloud/runs-pending.js";
import { uploadBatch } from "../../cloud/runs-uplink.js";

const BATCH_SIZE = 100; // server caps at 200; conservative leaves headroom for retries

export async function cloudSyncRuns(opts: { json: boolean }): Promise<number> {
  return runJson({
    command: "cloud.sync-runs",
    json: opts.json,
    fetch: doSyncRuns,
    printHuman: (d) => {
      if (d.scanned === 0) {
        console.log("No pending runs to upload.");
        return;
      }
      console.log(
        `Scanned ${d.scanned} pending run(s): ${d.uploaded} uploaded, ` +
          `${d.duplicates} already present, ${d.remaining} remaining.`,
      );
    },
  });
}

async function doSyncRuns(): Promise<CloudSyncRunsData> {
  const identity = await readIdentity();
  if (!identity) {
    throw new ThomasError({
      code: "E_CLOUD_NOT_LOGGED_IN",
      message: "Not logged in to thomas-cloud.",
      remediation: "Run `thomas cloud login` first.",
    });
  }

  const pending = await checkoutPending();
  const scanned = pending.length;
  if (scanned === 0) {
    await commitDrain([]); // nothing to do, but clear .draining if it existed
    return { scanned: 0, uploaded: 0, duplicates: 0, remaining: 0 };
  }

  let uploaded = 0;
  let duplicates = 0;
  let cursor = 0;
  let stoppedAt: number | null = null;

  while (cursor < pending.length) {
    const batch = pending.slice(cursor, cursor + BATCH_SIZE);
    try {
      const resp = await uploadBatch(batch);
      uploaded += resp.accepted;
      duplicates += resp.duplicates;
      cursor += batch.length;
    } catch {
      // Stop here — leave this batch + the rest in pending for next time.
      stoppedAt = cursor;
      break;
    }
  }

  const leftover = stoppedAt === null ? [] : pending.slice(stoppedAt);
  await commitDrain(leftover);

  return {
    scanned,
    uploaded,
    duplicates,
    remaining: leftover.length,
  };
}
