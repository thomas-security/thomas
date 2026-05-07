// Best-effort uplink of run records to thomas-cloud.
//
// Local jsonl is the system of record. Uplink is a fire-and-forget side effect
// after appendRun: if the user is logged in to cloud and the POST succeeds,
// the cloud dashboard sees the run. Failures are logged (when THOMAS_DEBUG)
// and dropped — we don't retry indefinitely or buffer to disk in v1, because
// the local jsonl always has the truth and a future "drain" command can
// reconcile gaps.
//
// Auth: device token from ~/.thomas/cloud.json. No login → silent no-op.

import { cloudPostJson } from "./client.js";
import { defaultBaseUrl, readIdentity } from "./identity.js";
import type { RunRecord } from "../runs/types.js";

type WireRunIn = {
  runId: string;
  agentId: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: "ok" | "error";
  inboundProtocol: "anthropic" | "openai";
  outboundProvider: string;
  outboundModel: string;
  inputTokens: number;
  outputTokens: number;
  cost: number | null;
  streamed: boolean;
  httpStatus: number;
  errorMessage: string | null;
  failovers: number;
  failoverNote: string | null;
};

type WireRunBatchRequest = { runs: WireRunIn[] };
type WireRunBatchResponse = { accepted: number; duplicates: number };

/**
 * Hand a freshly-appended record to the cloud uplink. Returns immediately;
 * the actual POST happens in the background. Never throws.
 */
export function enqueueRun(record: RunRecord): void {
  void uploadOne(record).catch((err) => {
    if (process.env.THOMAS_DEBUG) {
      // eslint-disable-next-line no-console
      console.error("[runs-uplink]", err instanceof Error ? err.message : String(err));
    }
  });
}

async function uploadOne(record: RunRecord): Promise<void> {
  const id = await readIdentity();
  if (!id) return; // not logged in — no-op
  const baseUrl = id.baseUrl ?? defaultBaseUrl();
  const body: WireRunBatchRequest = { runs: [toWireRun(record)] };
  await cloudPostJson<WireRunBatchResponse>("/v1/runs", body, {
    baseUrl,
    deviceToken: id.deviceToken,
    timeoutMs: 5_000,
  });
}

export function toWireRun(record: RunRecord): WireRunIn {
  return {
    runId: record.runId,
    agentId: record.agent,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    durationMs: record.durationMs,
    status: record.status,
    inboundProtocol: record.inboundProtocol,
    outboundProvider: record.outboundProvider,
    outboundModel: record.outboundModel,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    cost: record.cost,
    streamed: record.streamed,
    httpStatus: record.httpStatus,
    errorMessage: record.errorMessage,
    failovers: record.failovers,
    failoverNote: record.failoverNote,
  };
}
