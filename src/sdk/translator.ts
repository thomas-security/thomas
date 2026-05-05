// Public SDK surface for thomas protocol translators (L2).
//
// A translator pair converts request / response / streaming-SSE bodies in one
// direction between two model protocols. Today the in-tree translator modules
// (src/proxy/translate/anthropic-to-openai.ts, openai-to-anthropic.ts) export
// the three symbols below as named module exports; this file codifies the
// shape so out-of-tree authors and tests can target a stable contract.
//
// The shapes here are intentionally generic (`unknown` for request types) so
// implementations can use stricter local types (AnthropicRequest, OpenAIRequest,
// etc.) without satisfying clauses on every translator. Treat this as the
// documentary contract; the strict types live in protocols.ts.

import type { Protocol } from "./agent.js";

/**
 * A stateful translator instance for a single in-flight SSE stream.
 *
 * Construct one per request (`new T(model)`), feed it raw upstream chunks as
 * they arrive, and return its `flush()` output once the upstream stream ends.
 *
 * Implementations buffer partial events between `feed` calls; both methods
 * may emit zero or more SSE events back to the agent client as a string.
 */
export interface StreamTranslator {
  /** Append upstream bytes; return any complete SSE events ready to forward. */
  feed(chunk: Uint8Array): string;
  /** Flush any pending state at end-of-stream; emit a final terminator chunk. */
  flush(): string;
}

/** Constructor shape for a per-request StreamTranslator. */
export interface StreamTranslatorCtor {
  new (model: string): StreamTranslator;
}

/**
 * One-direction translator pair: source protocol → target protocol.
 *
 * Implementations are expected to be pure for `translateRequest` and
 * `translateResponseBody` (no I/O, no time, no randomness beyond the chat-id
 * generation). The StreamTranslator may be stateful across `feed` calls but
 * each instance is single-use (one request).
 */
export interface TranslatorPair {
  /** Translate a fully-parsed request body. `modelOverride` is the upstream model id. */
  translateRequest(req: unknown, modelOverride: string): unknown;
  /** Translate a complete (non-streaming) response. Both arg + return are JSON strings. */
  translateResponseBody(responseBody: string, model: string): string;
  /** Per-request stateful streaming translator. */
  StreamTranslator: StreamTranslatorCtor;
}

/** Pair description used by a translator registry / catalog. */
export interface TranslatorRegistration {
  from: Protocol;
  to: Protocol;
  pair: TranslatorPair;
}
