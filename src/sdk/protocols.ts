// Public SDK surface for the request / response / message shapes of the
// model protocols thomas understands. Translator authors (L2) consume these
// to produce/accept the canonical shapes.
//
// Add a new protocol => add a new file here re-exporting its types, then
// extend src/sdk/translator.ts so TranslatorPair can describe the new pair.

export type {
  AnthropicTextBlock,
  AnthropicImageBlock,
  AnthropicToolUseBlock,
  AnthropicToolResultBlock,
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicTool,
  AnthropicToolChoice,
  AnthropicRequest,
  OpenAIContentPart,
  OpenAIMessage,
  OpenAITool,
  OpenAIToolChoice,
  OpenAIRequest,
} from "../proxy/translate/types.js";
