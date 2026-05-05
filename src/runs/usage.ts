// Token-usage extraction from upstream LLM responses. Two paths:
//   - extractUsageFromBody: full non-streaming JSON body
//   - StreamUsageWatcher: feeds raw SSE chunks; finalize() returns accumulated usage
// Watcher is protocol-aware — pass the OUTBOUND provider's protocol since the
// watcher inspects upstream bytes, not what the agent sees.

import type { Protocol } from "../agents/types.js";

export type Usage = { input: number; output: number };

export const ZERO_USAGE: Usage = { input: 0, output: 0 };

export function extractUsageFromBody(body: string, protocol: Protocol): Usage {
  if (!body) return { ...ZERO_USAGE };
  try {
    const parsed = JSON.parse(body);
    if (protocol === "anthropic") {
      return {
        input: numberOf(parsed?.usage?.input_tokens),
        output: numberOf(parsed?.usage?.output_tokens),
      };
    }
    return {
      input: numberOf(parsed?.usage?.prompt_tokens),
      output: numberOf(parsed?.usage?.completion_tokens),
    };
  } catch {
    return { ...ZERO_USAGE };
  }
}

export class StreamUsageWatcher {
  private input = 0;
  private output = 0;
  private buf = "";
  private decoder = new TextDecoder();

  constructor(private readonly protocol: Protocol) {}

  feed(chunk: Uint8Array): void {
    this.buf += this.decoder.decode(chunk, { stream: true });
    const events = this.buf.split("\n\n");
    this.buf = events.pop() ?? "";
    for (const evt of events) this.parseEvent(evt);
  }

  finalize(): Usage {
    const tail = this.buf + this.decoder.decode();
    if (tail.trim()) this.parseEvent(tail);
    this.buf = "";
    return { input: this.input, output: this.output };
  }

  private parseEvent(raw: string): void {
    if (this.protocol === "anthropic") this.parseAnthropic(raw);
    else this.parseOpenAI(raw);
  }

  private parseAnthropic(raw: string): void {
    const dataLine = raw.split("\n").find((l) => l.startsWith("data:"));
    if (!dataLine) return;
    const data = dataLine.slice(5).trim();
    if (!data || data === "[DONE]") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const obj = parsed as Record<string, unknown>;
    // message_start carries initial input_tokens
    if (obj.type === "message_start") {
      const msg = obj.message as { usage?: { input_tokens?: number; output_tokens?: number } };
      if (msg?.usage) {
        this.input = numberOf(msg.usage.input_tokens, this.input);
        this.output = numberOf(msg.usage.output_tokens, this.output);
      }
    }
    // message_delta carries final cumulative output_tokens (and sometimes input_tokens)
    if (obj.type === "message_delta") {
      const usage = obj.usage as { input_tokens?: number; output_tokens?: number } | undefined;
      if (usage) {
        if (usage.input_tokens !== undefined) this.input = Number(usage.input_tokens);
        if (usage.output_tokens !== undefined) this.output = Number(usage.output_tokens);
      }
    }
  }

  private parseOpenAI(raw: string): void {
    for (const line of raw.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      const usage = (parsed as { usage?: { prompt_tokens?: number; completion_tokens?: number } })
        .usage;
      // OpenAI sends usage only on the final chunk when stream_options.include_usage = true
      if (usage) {
        if (usage.prompt_tokens !== undefined) this.input = Number(usage.prompt_tokens);
        if (usage.completion_tokens !== undefined) this.output = Number(usage.completion_tokens);
      }
    }
  }
}

function numberOf(v: unknown, fallback = 0): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}
