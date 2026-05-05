// thomas SDK — single import surface for adapter and translator authors.
//
//   import type { AgentSpec, ShimContext, ExtractedCredential } from "thomas/sdk";
//   import type { TranslatorPair, AnthropicRequest } from "thomas/sdk";
//
// In-repo adapters may continue to import from src/agents/types.ts etc.; the
// SDK re-exports the same symbols so the import path is stable across
// refactors. The eventual plugin runtime will publish this directory as
// `@thomas/sdk` to npm.

export type * from "./agent.js";
export type * from "./credential.js";
export type * from "./provider.js";
export type * from "./protocols.js";
export type * from "./translator.js";
