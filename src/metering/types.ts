// Read-side abstraction over recorded agent usage. Each Meter knows how to
// aggregate runs.jsonl entries into a Usage shape that cascade triggers can
// be evaluated against.
//
// v0.1.0 ships TokenMeter only (calls + tokens + dollar spend). Subscription2api
// will introduce a CallMeter that returns spend: null because $ doesn't apply
// — cascade rules using triggerSpendDay become inert; only triggerCallsDay /
// future window-based triggers fire.
//
// The decide layer (src/policy/decide.ts) consumes Meter at decision time;
// the meter is a pure reader and never mutates state.

import type { AgentId } from "../agents/types.js";

// Time bucket cascade triggers operate over. Future values: "5h" (rolling
// 5-hour window — anthropic/codex subscription windows), "session" (single
// agent task). Decoupled from policy schema so window choices stay open.
export type UsageWindow = "day";

export type Usage = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  // null when at least one run in the window had cost: null (unknown pricing
  // OR subscription provider). Spend-based cascade gating must treat null as
  // "unavailable" and either skip the spend rule or fall back to calls.
  spend: number | null;
};

export interface Meter {
  usageInWindow(agentId: AgentId, window: UsageWindow): Promise<Usage>;
}

export function windowStart(window: UsageWindow, now: Date = new Date()): Date {
  if (window === "day") {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }
  const _exhaustive: never = window;
  throw new Error(`unknown usage window: ${String(_exhaustive)}`);
}
