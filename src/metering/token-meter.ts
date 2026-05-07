// Token-based meter: aggregates calls, tokens, and dollar spend from runs.jsonl.
// Cost is whatever the proxy stamped on the run record at request time (via
// src/runs/pricing.ts). This meter does not re-price; it just sums.
//
// spend goes null if any run in the window had cost: null. That's the honest
// answer — partial visibility shouldn't masquerade as a complete number.

import type { AgentId } from "../agents/types.js";
import { readRuns } from "../runs/store.js";
import { type Meter, type Usage, type UsageWindow, windowStart } from "./types.js";

export class TokenMeter implements Meter {
  async usageInWindow(agentId: AgentId, window: UsageWindow): Promise<Usage> {
    const since = windowStart(window);
    const records = await readRuns({ agent: agentId, since });
    let calls = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let spend = 0;
    let allCostsKnown = true;
    for (const r of records) {
      calls += 1;
      inputTokens += r.inputTokens;
      outputTokens += r.outputTokens;
      if (r.cost === null) allCostsKnown = false;
      else spend += r.cost;
    }
    return { calls, inputTokens, outputTokens, spend: allCostsKnown ? spend : null };
  }
}
