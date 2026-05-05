// Internal run-record shape, persisted one-per-line in ~/.thomas/runs.jsonl.
// Richer than the public RunSummary in src/cli/output.ts — the command
// translates this to that shape on read.

import type { AgentId, Protocol } from "../agents/types.js";
import type { ProviderId } from "../cli/output.js";

export type RunRecord = {
  runId: string;
  agent: AgentId;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: "ok" | "error";
  inboundProtocol: Protocol;
  outboundProvider: ProviderId;
  outboundModel: string;
  inputTokens: number;
  outputTokens: number;
  // null when no price entry is known for outboundProvider/outboundModel
  cost: number | null;
  streamed: boolean;
  httpStatus: number;
  errorMessage: string | null;
  // 0 normally; 1 when this run was a failover attempt after the primary failed.
  // outboundProvider/outboundModel reflect the FINAL target (failover target if used).
  failovers: number;
  // populated when failovers > 0: describes what we tried first and why it failed.
  failoverNote: string | null;
};
