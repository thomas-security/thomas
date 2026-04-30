import { describe, expect, it } from "bun:test";
import * as AtoO from "../src/proxy/translate/anthropic-to-openai.js";
import * as OtoA from "../src/proxy/translate/openai-to-anthropic.js";
import type { AnthropicRequest, OpenAIRequest } from "../src/proxy/translate/types.js";

describe("anthropic→openai request", () => {
  it("hoists system prompt to a system message", () => {
    const req: AnthropicRequest = {
      model: "claude-sonnet-4-5",
      max_tokens: 100,
      system: "You are helpful.",
      messages: [{ role: "user", content: "hi" }],
    };
    const out = AtoO.translateRequest(req, "openai/gpt-5");
    expect(out.model).toBe("openai/gpt-5");
    expect(out.messages[0]).toEqual({ role: "system", content: "You are helpful." });
    expect(out.messages[1]).toEqual({ role: "user", content: "hi" });
    expect(out.max_tokens).toBe(100);
  });

  it("flattens system as content blocks", () => {
    const req: AnthropicRequest = {
      model: "x",
      system: [
        { type: "text", text: "Part 1." },
        { type: "text", text: "Part 2." },
      ],
      messages: [{ role: "user", content: "hi" }],
    };
    const out = AtoO.translateRequest(req, "x");
    expect(out.messages[0]).toEqual({ role: "system", content: "Part 1.\n\nPart 2." });
  });

  it("converts assistant tool_use to tool_calls", () => {
    const req: AnthropicRequest = {
      model: "x",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me check." },
            { type: "tool_use", id: "toolu_1", name: "lookup", input: { q: "x" } },
          ],
        },
      ],
    };
    const out = AtoO.translateRequest(req, "x");
    expect(out.messages[0]).toMatchObject({
      role: "assistant",
      content: "Let me check.",
      tool_calls: [
        { id: "toolu_1", type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } },
      ],
    });
  });

  it("splits user tool_result into role:tool messages", () => {
    const req: AnthropicRequest = {
      model: "x",
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "42" },
            { type: "text", text: "what now?" },
          ],
        },
      ],
    };
    const out = AtoO.translateRequest(req, "x");
    expect(out.messages).toEqual([
      { role: "tool", tool_call_id: "toolu_1", content: "42" },
      { role: "user", content: "what now?" },
    ]);
  });

  it("translates tools and tool_choice", () => {
    const req: AnthropicRequest = {
      model: "x",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "f", description: "d", input_schema: { type: "object" } }],
      tool_choice: { type: "tool", name: "f" },
    };
    const out = AtoO.translateRequest(req, "x");
    expect(out.tools).toEqual([
      { type: "function", function: { name: "f", description: "d", parameters: { type: "object" } } },
    ]);
    expect(out.tool_choice).toEqual({ type: "function", function: { name: "f" } });
  });
});

describe("openai→anthropic non-streaming response", () => {
  it("maps text content and stop reason", () => {
    const openai = JSON.stringify({
      id: "chatcmpl-1",
      choices: [
        {
          message: { role: "assistant", content: "Hello!" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    });
    const result = JSON.parse(OtoA.translateResponseBody(openai, "claude-sonnet-4-5"));
    expect(result.type).toBe("message");
    expect(result.role).toBe("assistant");
    expect(result.model).toBe("claude-sonnet-4-5");
    expect(result.content).toEqual([{ type: "text", text: "Hello!" }]);
    expect(result.stop_reason).toBe("end_turn");
    expect(result.usage).toEqual({ input_tokens: 5, output_tokens: 2 });
  });

  it("maps tool_calls to tool_use blocks", () => {
    const openai = JSON.stringify({
      id: "x",
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "lookup", arguments: '{"q":"x"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
    const result = JSON.parse(OtoA.translateResponseBody(openai, "x"));
    expect(result.content).toEqual([
      { type: "tool_use", id: "call_1", name: "lookup", input: { q: "x" } },
    ]);
    expect(result.stop_reason).toBe("tool_use");
  });
});

describe("openai→anthropic streaming", () => {
  it("emits message_start, text deltas, message_stop", () => {
    const t = new OtoA.StreamTranslator("claude-sonnet-4-5");
    const enc = (s: string) => new TextEncoder().encode(s);

    const part1 = t.feed(
      enc(
        `data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n` +
          `data: {"choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}\n\n`,
      ),
    );
    const part2 = t.feed(
      enc(
        `data: {"choices":[{"index":0,"delta":{"content":" there"},"finish_reason":null}]}\n\n` +
          `data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`,
      ),
    );
    const tail = t.flush();

    const all = part1 + part2 + tail;
    expect(all).toContain("event: message_start");
    expect(all).toContain('"type":"text"');
    expect(all).toContain('"text":"Hi"');
    expect(all).toContain('"text":" there"');
    expect(all).toContain("event: content_block_stop");
    expect(all).toContain('"stop_reason":"end_turn"');
    expect(all).toContain("event: message_stop");
  });

  it("emits tool_use block and input_json_delta", () => {
    const t = new OtoA.StreamTranslator("x");
    const enc = (s: string) => new TextEncoder().encode(s);
    const out = t.feed(
      enc(
        `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"lookup","arguments":""}}]},"finish_reason":null}]}\n\n` +
          `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"q\\":"}}]},"finish_reason":null}]}\n\n` +
          `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"x\\"}"}}]},"finish_reason":null}]}\n\n` +
          `data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n`,
      ),
    );
    expect(out).toContain('"type":"tool_use"');
    expect(out).toContain('"name":"lookup"');
    expect(out).toContain("input_json_delta");
    expect(out).toContain('"stop_reason":"tool_use"');
  });
});

describe("openai→anthropic request", () => {
  it("hoists system message into top-level system field", () => {
    const req: OpenAIRequest = {
      model: "gpt-5",
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "hi" },
      ],
    };
    const out = OtoA.translateRequest(req, "claude-sonnet-4-5");
    expect(out.model).toBe("claude-sonnet-4-5");
    expect(out.system).toBe("Be brief.");
    expect(out.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(out.max_tokens).toBe(4096);
  });

  it("merges multiple system messages", () => {
    const req: OpenAIRequest = {
      model: "x",
      messages: [
        { role: "system", content: "A." },
        { role: "system", content: "B." },
        { role: "user", content: "hi" },
      ],
    };
    const out = OtoA.translateRequest(req, "x");
    expect(out.system).toBe("A.\n\nB.");
  });

  it("converts assistant tool_calls to tool_use blocks", () => {
    const req: OpenAIRequest = {
      model: "x",
      messages: [
        {
          role: "assistant",
          content: "Let me check.",
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } },
          ],
        },
      ],
    };
    const out = OtoA.translateRequest(req, "x");
    expect(out.messages[0]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "Let me check." },
        { type: "tool_use", id: "call_1", name: "lookup", input: { q: "x" } },
      ],
    });
  });

  it("collapses tool messages into a user tool_result message", () => {
    const req: OpenAIRequest = {
      model: "x",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "f", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "42" },
        { role: "user", content: "thanks" },
      ],
    };
    const out = OtoA.translateRequest(req, "x");
    expect(out.messages).toEqual([
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", name: "f", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_1", content: "42" }],
      },
      { role: "user", content: "thanks" },
    ]);
  });

  it("translates stop string and array, tool_choice variants", () => {
    expect(
      OtoA.translateRequest(
        { model: "x", messages: [{ role: "user", content: "hi" }], stop: "STOP" },
        "x",
      ).stop_sequences,
    ).toEqual(["STOP"]);
    expect(
      OtoA.translateRequest(
        { model: "x", messages: [{ role: "user", content: "hi" }], tool_choice: "required" },
        "x",
      ).tool_choice,
    ).toEqual({ type: "any" });
    expect(
      OtoA.translateRequest(
        {
          model: "x",
          messages: [{ role: "user", content: "hi" }],
          tool_choice: { type: "function", function: { name: "f" } },
        },
        "x",
      ).tool_choice,
    ).toEqual({ type: "tool", name: "f" });
  });
});

describe("anthropic→openai non-streaming response", () => {
  it("maps text content and stop reason", () => {
    const anthropic = JSON.stringify({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude",
      content: [{ type: "text", text: "Hello!" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 2 },
    });
    const result = JSON.parse(AtoO.translateResponseBody(anthropic, "gpt-5"));
    expect(result.object).toBe("chat.completion");
    expect(result.model).toBe("gpt-5");
    expect(result.choices[0].message).toEqual({ role: "assistant", content: "Hello!" });
    expect(result.choices[0].finish_reason).toBe("stop");
    expect(result.usage).toEqual({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
  });

  it("maps tool_use blocks to tool_calls", () => {
    const anthropic = JSON.stringify({
      content: [
        { type: "tool_use", id: "toolu_1", name: "lookup", input: { q: "x" } },
      ],
      stop_reason: "tool_use",
    });
    const result = JSON.parse(AtoO.translateResponseBody(anthropic, "x"));
    expect(result.choices[0].message.content).toBeNull();
    expect(result.choices[0].message.tool_calls).toEqual([
      { id: "toolu_1", type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } },
    ]);
    expect(result.choices[0].finish_reason).toBe("tool_calls");
  });
});

describe("anthropic→openai streaming", () => {
  it("emits OpenAI chunks for text deltas and finishes with [DONE]", () => {
    const t = new AtoO.StreamTranslator("gpt-5");
    const enc = (s: string) => new TextEncoder().encode(s);
    const out =
      t.feed(
        enc(
          `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude","content":[]}}\n\n`,
        ),
      ) +
      t.feed(
        enc(
          `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`,
        ),
      ) +
      t.feed(
        enc(
          `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n`,
        ),
      ) +
      t.feed(
        enc(
          `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`,
        ),
      ) +
      t.feed(
        enc(
          `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n`,
        ),
      ) +
      t.feed(enc(`event: message_stop\ndata: {"type":"message_stop"}\n\n`));
    expect(out).toContain('"role":"assistant"');
    expect(out).toContain('"content":"Hi"');
    expect(out).toContain('"finish_reason":"stop"');
    expect(out).toContain("data: [DONE]");
  });

  it("translates tool_use block streaming into tool_calls deltas", () => {
    const t = new AtoO.StreamTranslator("x");
    const enc = (s: string) => new TextEncoder().encode(s);
    const out =
      t.feed(
        enc(`event: message_start\ndata: {"type":"message_start","message":{"id":"m"}}\n\n`),
      ) +
      t.feed(
        enc(
          `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"lookup","input":{}}}\n\n`,
        ),
      ) +
      t.feed(
        enc(
          `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":"}}\n\n`,
        ),
      ) +
      t.feed(
        enc(
          `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"x\\"}"}}\n\n`,
        ),
      ) +
      t.feed(
        enc(
          `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`,
        ),
      );
    expect(out).toContain('"id":"toolu_1"');
    expect(out).toContain('"name":"lookup"');
    expect(out).toContain('"arguments":"{\\"q\\":"');
    expect(out).toContain('"finish_reason":"tool_calls"');
    expect(out).toContain("data: [DONE]");
  });
});
