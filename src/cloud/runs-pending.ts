// Local queue for runs whose cloud uplink failed.
//
// Failure path: enqueueRun → fetch throws → appendPending(record). The CLI
// command `thomas cloud sync-runs` later reads the file, batches the records
// to POST /v1/runs (idempotent server-side on device_id+run_id+started_at),
// and rewrites the file with whatever didn't make it.
//
// Concurrency: the proxy's appendRun runs many times per second; sync-runs
// runs occasionally. We use an atomic-rename "drain" pattern so a concurrent
// appendPending during a drain doesn't get clobbered:
//
//   1. rename runs-pending.jsonl -> runs-pending.draining (atomic on POSIX)
//   2. while we're processing .draining, fresh failures append to a brand-new
//      runs-pending.jsonl
//   3. records that couldn't be drained are merged back into runs-pending.jsonl
//      via append (preserves ordering of fresh failures relative to leftovers)
//   4. .draining is removed
//
// If the process dies between (1) and (4), the .draining file stays put. The
// next sync-runs sees both files and merges them on the read side.

import { appendFile, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import { paths } from "../config/paths.js";
import type { RunRecord } from "../runs/types.js";

const DRAIN_SUFFIX = ".draining";

function drainingPath(): string {
  return paths.runsPending + DRAIN_SUFFIX;
}

/** Append one failed record to the pending file. Never throws. */
export async function appendPending(record: RunRecord): Promise<void> {
  try {
    await ensureDir();
    await appendFile(paths.runsPending, JSON.stringify(record) + "\n", { mode: 0o600 });
  } catch {
    // Best-effort. If we can't even persist the failure, the run is lost —
    // the local jsonl still has the truth; cloud will just be missing a row.
  }
}

/**
 * Move runs-pending.jsonl aside for processing. Returns the records that need
 * uploading. Concurrent failures during this call land in a fresh
 * runs-pending.jsonl that this drain will not touch.
 *
 * Also picks up any leftover .draining file from a prior crashed drain.
 */
export async function checkoutPending(): Promise<RunRecord[]> {
  await ensureDir();
  // 1. Capture anything queued for processing now: rename atomically.
  try {
    await rename(paths.runsPending, drainingPath());
  } catch (err) {
    // ENOENT = nothing to drain right now. Other errors propagate.
    if (!isNotFound(err)) throw err;
  }
  // 2. Load whatever's in .draining (this run's batch + any prior crashed run's leftovers).
  const text = await readFile(drainingPath(), "utf8").catch(() => "");
  const records: RunRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as RunRecord);
    } catch {
      // skip malformed
    }
  }
  return records;
}

/**
 * Finish a drain. `leftover` is the records the caller could not upload
 * (server failure mid-batch, etc.). They get appended back to the live
 * runs-pending.jsonl so the next drain retries them. The .draining file
 * is removed once leftovers are safely persisted.
 */
export async function commitDrain(leftover: RunRecord[]): Promise<void> {
  if (leftover.length > 0) {
    await ensureDir();
    const text = leftover.map((r) => JSON.stringify(r)).join("\n") + "\n";
    await appendFile(paths.runsPending, text, { mode: 0o600 });
  }
  await unlink(drainingPath()).catch(() => {});
}

async function ensureDir(): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dirname(paths.runsPending), { recursive: true });
}

function isNotFound(err: unknown): boolean {
  return (
    err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}
