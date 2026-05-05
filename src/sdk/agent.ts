// Public SDK surface for thomas agent adapters (L1).
//
// These types describe the contract an agent adapter must satisfy. They live
// in src/agents/types.ts today; this module re-exports them under a stable
// surface so future plugin runtimes (or out-of-tree adapters) can depend on a
// single import path that never moves, even if internal layout changes.
//
// Adapter implementations that ship in this repo (claude-code / codex /
// openclaw / hermes) currently import from src/agents/types.ts directly; that
// path remains supported for backward compatibility.

export type {
  AgentId,
  Protocol,
  CredentialSource,
  DetectResult,
  ShimContext,
  AgentSnapshot,
  ExtractedCredential,
  AgentSpec,
} from "../agents/types.js";
