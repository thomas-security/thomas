// Resolve the right Meter for an agent. v0.1.0 always returns TokenMeter
// because every connected provider bills by tokens. The registry is the
// extension point for subscription2api: when a provider's spec carries
// `metering: "call"` (or "window"), this is where the dispatch happens.

import type { AgentId } from "../agents/types.js";
import { TokenMeter } from "./token-meter.js";
import type { Meter } from "./types.js";

const tokenMeter = new TokenMeter();

export function getMeter(_agent: AgentId): Meter {
  return tokenMeter;
}
