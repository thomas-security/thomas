import { randomUUID } from "node:crypto";
import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicRequest,
  AnthropicToolResultBlock,
  OpenAIContentPart,
  OpenAIRequest,
} from "./types.js";

/**
 * Translate an OpenAI chat.completion request body into an Anthropic
 * /v1/messages request body.
 */
export function translateRequest(req: OpenAIRequest, modelOverride: string): AnthropicRequest {
  const systemParts: string[] = [];
  const messages: AnthropicMessage[] = [];
  let pendingToolResults: AnthropicToolResultBlock[] = [];

  const flushTools = () => {
    if (pendingToolResults.length === 0) return;
    messages.push({ role: "user", content: pendingToolResults });
    pendingToolResults = [];
  };

  for (const msg of req.messages) {
    if (msg.role === "system") {
      if (typeof msg.content === "string" && msg.content.length > 0) {
        systemParts.push(msg.content);
      }
      continue;
    }
    if (msg.role === "tool") {
      pendingToolResults.push({
        type: "tool_result",
        tool_use_id: msg.tool_call_id,
        content: typeof msg.content === "string" ? msg.content : "",
      });
      continue;
    }
    flushTools();
    if (msg.role === "user") {
      const content =
        typeof msg.content === "string" ? msg.content : convertParts(msg.content);
      messages.push({ role: "user", content });
    } else {
      const blocks: AnthropicContentBlock[] = [];
      if (typeof msg.content === "string" && msg.content.length > 0) {
        blocks.push({ type: "text", text: msg.content });
      }
      for (const tc of msg.tool_calls ?? []) {
        let input: unknown = {};
        try {
          input = JSON.parse(tc.function.arguments || "{}");
        } catch {
          input = {};
        }
        blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
      }
      messages.push({
        role: "assistant",
        content: blocks.length === 0 ? "" : blocks,
      });
    }
  }
  flushTools();

  const out: AnthropicRequest = {
    model: modelOverride,
    max_tokens: req.max_tokens ?? 4096,
    messages,
  };
  if (systemParts.length > 0) out.system = systemParts.join("\n\n");
  if (req.temperature !== undefined) out.temperature = req.temperature;
  if (req.top_p !== undefined) out.top_p = req.top_p;
  if (req.stream !== undefined) out.stream = req.stream;
  if (req.stop) {
    out.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop];
  }
  if (req.tools && req.tools.length > 0) {
    out.tools = req.tools.map((t) => {
      const tool = { name: t.function.name, input_schema: t.function.parameters } as {
        name: string;
        description?: string;
        input_schema: unknown;
      };
      if (t.function.description !== undefined) tool.description = t.function.description;
      return tool;
    });
  }
  if (req.tool_choice !== undefined) {
    if (req.tool_choice === "auto") out.tool_choice = { type: "auto" };
    else if (req.tool_choice === "required") out.tool_choice = { type: "any" };
    else if (req.tool_choice === "none") out.tool_choice = { type: "none" };
    else if (typeof req.tool_choice === "object") {
      out.tool_choice = { type: "tool", name: req.tool_choice.function.name };
    }
  }
  return out;
}

function convertParts(parts: OpenAIContentPart[]): AnthropicContentBlock[] {
  return parts.map((p): AnthropicContentBlock => {
    if (p.type === "text") return { type: "text", text: p.text };
    if (p.type === "image_url") {
      const url = p.image_url.url;
      const dataMatch = url.match(/^data:([^;]+);base64,(.*)$/);
      if (dataMatch) {
        return {
          type: "image",
          source: { type: "base64", media_type: dataMatch[1]!, data: dataMatch[2]! },
        };
      }
      return { type: "image", source: { type: "url", url } };
    }
    return { type: "text", text: "" };
  });
}

/**
 * Translate a non-streaming OpenAI chat.completion response body into an
 * Anthropic /v1/messages response body.
 */
export function translateResponseBody(openaiBody: string, model: string): string {
  let parsed: any;
  try {
    parsed = JSON.parse(openaiBody);
  } catch {
    return openaiBody;
  }
  if (parsed?.error) return openaiBody;
  const choice = parsed?.choices?.[0];
  const message = choice?.message;
  if (!message) return openaiBody;

  const content: any[] = [];
  if (typeof message.content === "string" && message.content.length > 0) {
    content.push({ type: "text", text: message.content });
  }
  if (Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      content.push({
        type: "tool_use",
        id: tc.id ?? `toolu_${randomId()}`,
        name: tc.function?.name ?? "",
        input: parseJson(tc.function?.arguments) ?? {},
      });
    }
  }

  const stopReason = mapStopReason(choice.finish_reason ?? "stop");
  return JSON.stringify({
    id: parsed.id ? `msg_${parsed.id}` : `msg_${randomId()}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: parsed.usage?.prompt_tokens ?? 0,
      output_tokens: parsed.usage?.completion_tokens ?? 0,
    },
  });
}

/**
 * Stateful translator from OpenAI SSE chunks (chat.completion.chunk) to
 * Anthropic SSE events (message_start, content_block_*, message_delta, message_stop).
 */
export class StreamTranslator {
  private buffer = "";
  private startedMessage = false;
  private finished = false;
  private currentBlock?: { kind: "text" | "tool_use"; index: number };
  private toolCallIdxToBlockIdx = new Map<number, number>();
  private toolCallIds = new Map<number, string>();
  private nextBlockIndex = 0;
  private outputTokens = 0;
  private inputTokens = 0;
  private readonly messageId = `msg_${randomId()}`;
  private readonly decoder = new TextDecoder();

  constructor(private readonly model: string) {}

  feed(chunk: Uint8Array): string {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    const out: string[] = [];
    let nlnl: number;
    while ((nlnl = this.buffer.indexOf("\n\n")) >= 0) {
      const event = this.buffer.slice(0, nlnl);
      this.buffer = this.buffer.slice(nlnl + 2);
      out.push(...this.processEvent(event));
    }
    return out.join("");
  }

  flush(): string {
    if (this.finished) return "";
    const out: string[] = [];
    if (this.currentBlock) {
      out.push(format("content_block_stop", {
        type: "content_block_stop",
        index: this.currentBlock.index,
      }));
      this.currentBlock = undefined;
    }
    out.push(format("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: this.outputTokens },
    }));
    out.push(format("message_stop", { type: "message_stop" }));
    this.finished = true;
    return out.join("");
  }

  private processEvent(raw: string): string[] {
    const dataLine = raw.split("\n").find((l) => l.startsWith("data:"));
    if (!dataLine) return [];
    const data = dataLine.slice(5).trim();
    if (data === "[DONE]") return [];
    let chunk: any;
    try {
      chunk = JSON.parse(data);
    } catch {
      return [];
    }
    return this.processChunk(chunk);
  }

  private processChunk(chunk: any): string[] {
    const out: string[] = [];

    if (!this.startedMessage) {
      this.startedMessage = true;
      out.push(format("message_start", {
        type: "message_start",
        message: {
          id: this.messageId,
          type: "message",
          role: "assistant",
          content: [],
          model: this.model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }));
    }

    if (chunk.usage) {
      this.inputTokens = chunk.usage.prompt_tokens ?? this.inputTokens;
      this.outputTokens = chunk.usage.completion_tokens ?? this.outputTokens;
    }

    const choice = chunk.choices?.[0];
    if (!choice) return out;
    const delta = choice.delta ?? {};

    if (typeof delta.content === "string" && delta.content.length > 0) {
      if (this.currentBlock?.kind !== "text") {
        if (this.currentBlock) {
          out.push(format("content_block_stop", {
            type: "content_block_stop",
            index: this.currentBlock.index,
          }));
        }
        const index = this.nextBlockIndex++;
        this.currentBlock = { kind: "text", index };
        out.push(format("content_block_start", {
          type: "content_block_start",
          index,
          content_block: { type: "text", text: "" },
        }));
      }
      out.push(format("content_block_delta", {
        type: "content_block_delta",
        index: this.currentBlock.index,
        delta: { type: "text_delta", text: delta.content },
      }));
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const oaiIdx = typeof tc.index === "number" ? tc.index : 0;
        let blockIndex = this.toolCallIdxToBlockIdx.get(oaiIdx);
        if (blockIndex === undefined) {
          if (this.currentBlock) {
            out.push(format("content_block_stop", {
              type: "content_block_stop",
              index: this.currentBlock.index,
            }));
          }
          blockIndex = this.nextBlockIndex++;
          this.toolCallIdxToBlockIdx.set(oaiIdx, blockIndex);
          const toolId = tc.id ?? `toolu_${randomId()}`;
          this.toolCallIds.set(oaiIdx, toolId);
          this.currentBlock = { kind: "tool_use", index: blockIndex };
          out.push(format("content_block_start", {
            type: "content_block_start",
            index: blockIndex,
            content_block: {
              type: "tool_use",
              id: toolId,
              name: tc.function?.name ?? "",
              input: {},
            },
          }));
        }
        const args = tc.function?.arguments;
        if (typeof args === "string" && args.length > 0) {
          out.push(format("content_block_delta", {
            type: "content_block_delta",
            index: blockIndex,
            delta: { type: "input_json_delta", partial_json: args },
          }));
        }
      }
    }

    if (choice.finish_reason) {
      if (this.currentBlock) {
        out.push(format("content_block_stop", {
          type: "content_block_stop",
          index: this.currentBlock.index,
        }));
        this.currentBlock = undefined;
      }
      out.push(format("message_delta", {
        type: "message_delta",
        delta: {
          stop_reason: mapStopReason(choice.finish_reason),
          stop_sequence: null,
        },
        usage: { output_tokens: this.outputTokens },
      }));
      out.push(format("message_stop", { type: "message_stop" }));
      this.finished = true;
    }

    return out;
  }
}

function mapStopReason(r: string): string {
  switch (r) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    case "content_filter":
      return "stop_sequence";
    default:
      return "end_turn";
  }
}

function parseJson(s: string | undefined): unknown {
  if (!s) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function randomId(): string {
  return randomUUID().replace(/-/g, "");
}

function format(eventName: string, data: unknown): string {
  return `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
}
