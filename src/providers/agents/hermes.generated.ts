// AUTO-GENERATED — do not edit by hand.
// Regenerate via: bun run scripts/sync-providers.ts
//
// Source: references/hermes-agent/hermes_cli/auth.py (PROVIDER_REGISTRY)
//         references/hermes-agent/hermes_cli/providers.py (HERMES_OVERLAYS)
//
// One entry per native hermes provider that thomas can import via env-var pickup.
// OAuth-only providers (nous, openai-codex, qwen-oauth, google-gemini-cli, minimax-oauth,
// copilot-acp) are intentionally excluded — they need flow-specific handling.

import type { Protocol } from "../../agents/types.js";

export type HermesProviderEntry = {
  /** Internal thomas provider id. Matches BUILTIN id when builtin=true; otherwise unique. */
  thomasId: string;
  /** Env-var aliases hermes recognizes for this provider's API key (in priority order). */
  envKeys: readonly string[];
  /** Default upstream origin (no /v1). Ignored when builtin=true. */
  originBaseUrl: string;
  protocol: Protocol;
  /** True when thomasId already exists in src/providers/registry.ts BUILTIN. */
  builtin?: boolean;
};

export const HERMES_PROVIDERS: readonly HermesProviderEntry[] = [
  // — built-in collisions: just import the credential, don't shadow the BUILTIN spec
  { thomasId: "openrouter", envKeys: ["OPENROUTER_API_KEY"], originBaseUrl: "https://openrouter.ai/api", protocol: "openai", builtin: true },
  { thomasId: "openai", envKeys: ["OPENAI_API_KEY"], originBaseUrl: "https://api.openai.com", protocol: "openai", builtin: true },
  { thomasId: "anthropic", envKeys: ["ANTHROPIC_API_KEY", "ANTHROPIC_TOKEN"], originBaseUrl: "https://api.anthropic.com", protocol: "anthropic", builtin: true },
  { thomasId: "deepseek", envKeys: ["DEEPSEEK_API_KEY"], originBaseUrl: "https://api.deepseek.com", protocol: "openai", builtin: true },
  { thomasId: "kimi", envKeys: ["KIMI_API_KEY", "KIMI_CODING_API_KEY"], originBaseUrl: "https://api.moonshot.cn", protocol: "openai", builtin: true },
  { thomasId: "groq", envKeys: ["GROQ_API_KEY"], originBaseUrl: "https://api.groq.com/openai", protocol: "openai", builtin: true },

  // — hermes-only providers (registered as custom in thomas)
  { thomasId: "xai", envKeys: ["XAI_API_KEY"], originBaseUrl: "https://api.x.ai", protocol: "openai" },
  { thomasId: "nvidia", envKeys: ["NVIDIA_API_KEY"], originBaseUrl: "https://integrate.api.nvidia.com", protocol: "openai" },
  { thomasId: "zai", envKeys: ["GLM_API_KEY", "ZAI_API_KEY", "Z_AI_API_KEY"], originBaseUrl: "https://api.z.ai/paas", protocol: "openai" },
  { thomasId: "kimi-coding", envKeys: ["KIMI_CODING_API_KEY", "KIMI_API_KEY"], originBaseUrl: "https://api.moonshot.ai", protocol: "openai" },
  { thomasId: "kimi-coding-cn", envKeys: ["KIMI_CN_API_KEY"], originBaseUrl: "https://api.moonshot.cn", protocol: "openai" },
  { thomasId: "alibaba", envKeys: ["DASHSCOPE_API_KEY"], originBaseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode", protocol: "openai" },
  { thomasId: "alibaba-coding-plan", envKeys: ["ALIBABA_CODING_PLAN_API_KEY", "DASHSCOPE_API_KEY"], originBaseUrl: "https://coding-intl.dashscope.aliyuncs.com", protocol: "openai" },
  { thomasId: "stepfun", envKeys: ["STEPFUN_API_KEY"], originBaseUrl: "https://api.stepfun.ai/step_plan", protocol: "openai" },
  { thomasId: "minimax", envKeys: ["MINIMAX_API_KEY"], originBaseUrl: "https://api.minimax.io/anthropic", protocol: "anthropic" },
  { thomasId: "minimax-cn", envKeys: ["MINIMAX_CN_API_KEY"], originBaseUrl: "https://api.minimaxi.com/anthropic", protocol: "anthropic" },
  { thomasId: "ollama-cloud", envKeys: ["OLLAMA_API_KEY"], originBaseUrl: "https://ollama.com", protocol: "openai" },
  { thomasId: "arcee", envKeys: ["ARCEEAI_API_KEY"], originBaseUrl: "https://api.arcee.ai/api", protocol: "openai" },
  { thomasId: "gmi", envKeys: ["GMI_API_KEY"], originBaseUrl: "https://api.gmi-serving.com", protocol: "openai" },
  { thomasId: "huggingface", envKeys: ["HF_TOKEN"], originBaseUrl: "https://router.huggingface.co", protocol: "openai" },
  { thomasId: "xiaomi", envKeys: ["XIAOMI_API_KEY"], originBaseUrl: "https://api.xiaomimimo.com", protocol: "openai" },
  { thomasId: "tencent-tokenhub", envKeys: ["TOKENHUB_API_KEY"], originBaseUrl: "https://tokenhub.tencentmaas.com", protocol: "openai" },
  { thomasId: "ai-gateway", envKeys: ["AI_GATEWAY_API_KEY"], originBaseUrl: "https://ai-gateway.vercel.sh", protocol: "openai" },
  { thomasId: "opencode-zen", envKeys: ["OPENCODE_ZEN_API_KEY", "OPENCODE_API_KEY"], originBaseUrl: "https://opencode.ai/zen", protocol: "openai" },
  { thomasId: "opencode-go", envKeys: ["OPENCODE_GO_API_KEY"], originBaseUrl: "https://opencode.ai/zen/go", protocol: "openai" },
  { thomasId: "kilocode", envKeys: ["KILOCODE_API_KEY"], originBaseUrl: "https://api.kilo.ai/api/gateway", protocol: "openai" },
  { thomasId: "lmstudio", envKeys: ["LM_API_KEY"], originBaseUrl: "http://127.0.0.1:1234", protocol: "openai" },
  { thomasId: "copilot", envKeys: ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"], originBaseUrl: "https://models.github.com", protocol: "openai" },
  { thomasId: "gemini", envKeys: ["GOOGLE_API_KEY", "GEMINI_API_KEY"], originBaseUrl: "https://generativelanguage.googleapis.com", protocol: "openai" },
] as const;
