import { unlink } from "node:fs/promises";
import { join } from "node:path";
import type { AgentId, AgentSnapshot } from "../agents/types.js";
import { readJson, writeJsonAtomic } from "./io.js";
import { paths } from "./paths.js";

function snapshotPath(agentId: AgentId): string {
  return join(paths.snapshots, `${agentId}.json`);
}

export async function readSnapshot(agentId: AgentId): Promise<AgentSnapshot | undefined> {
  const value = await readJson<AgentSnapshot | null>(snapshotPath(agentId), null);
  return value ?? undefined;
}

export async function writeSnapshot(snapshot: AgentSnapshot): Promise<string> {
  const path = snapshotPath(snapshot.agentId);
  await writeJsonAtomic(path, snapshot);
  return path;
}

export async function deleteSnapshot(agentId: AgentId): Promise<void> {
  await unlink(snapshotPath(agentId)).catch(() => undefined);
}
