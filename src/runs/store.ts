// Append-only JSONL store at ~/.thomas/runs.jsonl. POSIX appendFile of small
// records (< 4KB) is atomic, so concurrent proxy requests won't corrupt lines.
// Reads are O(file): naive for v1 — fine for solo single-host volume.

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentId } from "../agents/types.js";
import { paths } from "../config/paths.js";
import type { RunRecord } from "./types.js";

export async function appendRun(record: RunRecord): Promise<void> {
  await mkdir(dirname(paths.runs), { recursive: true });
  await appendFile(paths.runs, JSON.stringify(record) + "\n", { mode: 0o600 });
}

export type ReadRunsOptions = {
  agent?: AgentId;
  since?: Date;
  limit?: number;
};

export async function readRuns(opts: ReadRunsOptions = {}): Promise<RunRecord[]> {
  const text = await readFile(paths.runs, "utf8").catch(() => "");
  let records: RunRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as RunRecord);
    } catch {
      // skip malformed
    }
  }
  if (opts.agent) records = records.filter((r) => r.agent === opts.agent);
  if (opts.since) {
    const t = opts.since.getTime();
    records = records.filter((r) => Date.parse(r.endedAt) >= t);
  }
  // newest first
  records.sort((a, b) => (a.endedAt > b.endedAt ? -1 : 1));
  if (opts.limit !== undefined && opts.limit >= 0) records = records.slice(0, opts.limit);
  return records;
}

// Accepts either a full UUID or a unique prefix (e.g. first 8 chars). Newest first.
export async function findRun(runIdOrPrefix: string): Promise<RunRecord | undefined> {
  const all = await readRuns();
  return all.find((r) => r.runId === runIdOrPrefix || r.runId.startsWith(runIdOrPrefix));
}

// All records sharing a runId, matched by full id or prefix on any record's id.
// Returns chronological order (oldest first). Empty if no match.
export async function findRecordsForRun(runIdOrPrefix: string): Promise<RunRecord[]> {
  const all = await readRuns();
  const exact = all.find((r) => r.runId === runIdOrPrefix);
  const targetId =
    exact?.runId ??
    all.find((r) => r.runId.startsWith(runIdOrPrefix))?.runId;
  if (!targetId) return [];
  return all
    .filter((r) => r.runId === targetId)
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
}
