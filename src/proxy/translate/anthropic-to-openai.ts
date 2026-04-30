import { randomUUID } from "node:crypto";
import type {
  AnthropicContentBlock,
  AnthropicImageBlock,
  AnthropicMessage,
  AnthropicRequest,
  AnthropicTextBlock,
  AnthropicTool,
  AnthropicToolChoice,
  AnthropicToolResultBlock,
  OpenAIContentPart,
  OpenAIMessage,
  OpenAIRequest,
  OpenAITool,
  OpenAIToolChoice,
} from "./types.js";

export function translateRequest(req: AnthropicRequest, modelOverride: string): OpenAIRequest {
  const messages: OpenAIMessage[] = [];

  if (req.system !== undefined) {
    const text =
      typeof req.system === "string"
        ? req.system
        : req.system.map((b) => b.text).join("\n\n");
    if (text.length > 0) {
      messages.push({ role: "system", content: text });
    }
  }

  for (const msg of req.messages) {
    messages.push(...translateMessage(msg));
  }

  const out: OpenAIRequest = {
    model: modelOverride,
    messages,
  };
  if (req.max_tokens !== undefined) out.max_tokens = req.max_tokens;
  if (req.temperature !== undefined) out.temperature = req.temperature;
  if (req.top_p !== undefined) out.top_p = req.top_p;
  if (req.stop_sequences && req.stop_sequences.length > 0) out.stop = req.stop_sequences;
  if (req.stream !== undefined) out.stream = req.stream;
  if (req.tools && req.tools.length > 0) out.tools = req.tools.map(translateTool);
  const tc = translateToolChoice(req.tool_choice);
  if (tc !== undefined) out.tool_choice = tc;
  return out;
}

function translateMessage(msg: AnthropicMessage): OpenAIMessage[] {
  if (typeof msg.content === "string") {
    if (msg.role === "user") return [{ role: "user", content: msg.content }];
    return [{ role: "assistant", content: msg.content }];
  }
  if (msg.role === "user") return translateUserBlocks(msg.content);
  return translateAssistantBlocks(msg.content);
}

function translateUserBlocks(blocks: AnthropicContentBlock[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  const parts: OpenAIContentPart[] = [];
  for (const b of blocks) {
    if (b.type === "tool_result") {
      out.push(toolResultToMessage(b));
    } else if (b.type === "text") {
      parts.push({ type: "text", text: b.text });
    } else if (b.type === "image") {
      parts.push({ type: "image_url", image_url: { url: imageUrl(b) } });
    }
  }
  if (parts.length > 0) {
    if (parts.length === 1 && parts[0]!.type === "text") {
      out.push({ role: "user", content: parts[0]!.text });
    } else {
      out.push({ role: "user", content: parts });
    }
  }
  return out;
}

function translateAssistantBlocks(blocks: AnthropicContentBlock[]): OpenAIMessage[] {
  const text: string[] = [];
  const toolCalls: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }> = [];
  for (const b of blocks) {
    if (b.type === "text") text.push(b.text);
    else if (b.type === "tool_use") {
      toolCalls.push({
        id: b.id,
        type: "function",
        function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
      });
    }
  }
  const msg: OpenAIMessage = {
    role: "assistant",
    content: text.length > 0 ? text.join("") : null,
  };
  if (toolCalls.length > 0) {
    (msg as { tool_calls?: typeof toolCalls }).tool_calls = toolCalls;
  }
  return [msg];
}

function toolResultToMessage(b: AnthropicToolResultBlock): OpenAIMessage {
  const text =
    typeof b.content === "string"
      ? b.content
      : b.content
          .filter((c): c is AnthropicTextBlock => c.type === "text")
          .map((c) => c.text)
          .join("\n");
  return { role: "tool", tool_call_id: b.tool_use_id, content: text };
}

function imageUrl(b: AnthropicImageBlock): string {
  if (b.source.type === "base64") {
    return `data:${b.source.media_type};base64,${b.source.data}`;
  }
  return b.source.url;
}

function translateTool(t: AnthropicTool): OpenAITool {
  const fn: OpenAITool["function"] = { name: t.name, parameters: t.input_schema };
  if (t.description !== undefined) fn.description = t.description;
  return { type: "function", function: fn };
}

function translateToolChoice(tc: AnthropicToolChoice | undefined): OpenAIToolChoice | undefined {
  if (!tc) return undefined;
  if (tc.type === "auto") return "auto";
  if (tc.type === "any") return "required";
  if (tc.type === "none") return "none";
  if (tc.type === "tool") return { type: "function", function: { name: tc.name } };
  return undefined;
}

/**
 * Translate a non-streaming Anthropic /v1/messages response into an
 * OpenAI chat.completion response body.
 */
export function translateResponseBody(anthropicBody: string, model: string): string {
  let parsed: any;
  try {
    parsed = JSON.parse(anthropicBody);
  } catch {
    return anthropicBody;
  }
  if (parsed?.type === "error") {
    return JSON.stringify({
      error: {
        message: parsed.error?.message ?? "unknown error",
        type: parsed.error?.type ?? "api_error",
      },
    });
  }
  const textParts: string[] = [];
  const toolCalls: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }> = [];
  for (const block of (parsed.content ?? []) as any[]) {
    if (block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      });
    }
  }
  const message: any = {
    role: "assistant",
    content: textParts.length > 0 ? textParts.join("") : null,
  };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  return JSON.stringify({
    id: parsed.id ?? `chatcmpl-${randomId()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: mapStopReasonToFinish(parsed.stop_reason ?? "end_turn"),
      },
    ],
    usage: {
      prompt_tokens: parsed.usage?.input_tokens ?? 0,
      completion_tokens: parsed.usage?.output_tokens ?? 0,
      total_tokens:
        (parsed.usage?.input_tokens ?? 0) + (parsed.usage?.output_tokens ?? 0),
    },
  });
}

/**
 * Stateful translator from Anthropic /v1/messages SSE events to
 * OpenAI chat.completion.chunk SSE chunks.
 */
export class StreamTranslator {
  private buffer = "";
  private startedMessage = false;
  private finished = false;
  private currentBlockType?: "text" | "tool_use";
  private blockIdxToToolCallIdx = new Map<number, number>();
  private nextToolCallIdx = 0;
  private stopReason: string | undefined;
  private readonly chatId = `chatcmpl-${randomId()}`;
  private readonly created = Math.floor(Date.now() / 1000);
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
    out.push(this.formatChunk({
      choices: [{
        index: 0,
        delta: {},
        finish_reason: mapStopReasonToFinish(this.stopReason ?? "end_turn"),
      }],
    }));
    out.push("data: [DONE]\n\n");
    this.finished = true;
    return out.join("");
  }

  private processEvent(raw: string): string[] {
    let eventName: string | undefined;
    let dataLine: string | undefined;
    for (const line of raw.split("\n")) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLine = line.slice(5).trim();
    }
    if (!dataLine) return [];
    let data: any;
    try {
      data = JSON.parse(dataLine);
    } catch {
      return [];
    }
    return this.dispatch(eventName ?? data.type, data);
  }

  private dispatch(type: string, data: any): string[] {
    switch (type) {
      case "message_start":
        return this.onMessageStart();
      case "content_block_start":
        return this.onBlockStart(data);
      case "content_block_delta":
        return this.onBlockDelta(data);
      case "content_block_stop":
        return [];
      case "message_delta":
        if (data.delta?.stop_reason) this.stopReason = data.delta.stop_reason;
        return [];
      case "message_stop":
        return this.emitFinal();
      default:
        return [];
    }
  }

  private onMessageStart(): string[] {
    if (this.startedMessage) return [];
    this.startedMessage = true;
    return [this.formatChunk({
      id: this.chatId,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      choices: [{
        index: 0,
        delta: { role: "assistant", content: "" },
        finish_reason: null,
      }],
    })];
  }

  private onBlockStart(d: any): string[] {
    const block = d.content_block;
    if (block?.type === "text") {
      this.currentBlockType = "text";
      return [];
    }
    if (block?.type === "tool_use") {
      this.currentBlockType = "tool_use";
      const toolCallIdx = this.nextToolCallIdx++;
      this.blockIdxToToolCallIdx.set(d.index, toolCallIdx);
      return [this.formatChunk({
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: toolCallIdx,
              id: block.id,
              type: "function",
              function: { name: block.name, arguments: "" },
            }],
          },
          finish_reason: null,
        }],
      })];
    }
    return [];
  }

  private onBlockDelta(d: any): string[] {
    const delta = d.delta;
    if (delta?.type === "text_delta") {
      return [this.formatChunk({
        choices: [{
          index: 0,
          delta: { content: delta.text },
          finish_reason: null,
        }],
      })];
    }
    if (delta?.type === "input_json_delta") {
      const toolCallIdx = this.blockIdxToToolCallIdx.get(d.index) ?? 0;
      return [this.formatChunk({
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: toolCallIdx,
              function: { arguments: delta.partial_json ?? "" },
            }],
          },
          finish_reason: null,
        }],
      })];
    }
    return [];
  }

  private emitFinal(): string[] {
    if (this.finished) return [];
    const out = [
      this.formatChunk({
        choices: [{
          index: 0,
          delta: {},
          finish_reason: mapStopReasonToFinish(this.stopReason ?? "end_turn"),
        }],
      }),
      "data: [DONE]\n\n",
    ];
    this.finished = true;
    return out;
  }

  private formatChunk(obj: unknown): string {
    return `data: ${JSON.stringify(obj)}\n\n`;
  }
}

function mapStopReasonToFinish(r: string): string {
  switch (r) {
    case "end_turn":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "stop_sequence":
      return "stop";
    default:
      return "stop";
  }
}

function randomId(): string {
  return randomUUID().replace(/-/g, "");
}
