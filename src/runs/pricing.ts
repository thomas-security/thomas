// Hardcoded model catalog: USD per 1M tokens (input, output) + protocol + a
// rough quality tier used by `thomas recommend`. Returning null from
// computeCost is the honest answer when we don't have a price entry — the
// caller surfaces "unknown" rather than pretending the model was free.
//
// User overlay: ~/.thomas/prices.json overrides any builtin entry by key
// "<provider>/<model>" and adds entries for unknown models. Read via
// `prices-store.readOverlay()` on every cost computation — solo-host volume
// makes the file IO negligible. Add caching if it ever becomes hot.

import type { Protocol } from "../agents/types.js";
import type { PriceEntry, ProviderId } from "../cli/output.js";
import { priceKey, readOverlay } from "./prices-store.js";

export type ModelTier = "premium" | "balanced" | "cheap";

export type ModelMeta = {
  provider: ProviderId;
  model: string;
  protocol: Protocol;
  pricePerMillion: { input: number; output: number };
  tier: ModelTier;
};

export const MODELS: ModelMeta[] = [
  // Anthropic
  {
    provider: "anthropic",
    model: "claude-opus-4-7",
    protocol: "anthropic",
    pricePerMillion: { input: 15.0, output: 75.0 },
    tier: "premium",
  },
  {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    protocol: "anthropic",
    pricePerMillion: { input: 3.0, output: 15.0 },
    tier: "balanced",
  },
  {
    provider: "anthropic",
    model: "claude-haiku-4-5",
    protocol: "anthropic",
    pricePerMillion: { input: 1.0, output: 5.0 },
    tier: "cheap",
  },

  // OpenAI
  {
    provider: "openai",
    model: "gpt-4o",
    protocol: "openai",
    pricePerMillion: { input: 2.5, output: 10.0 },
    tier: "premium",
  },
  {
    provider: "openai",
    model: "o1",
    protocol: "openai",
    pricePerMillion: { input: 15.0, output: 60.0 },
    tier: "premium",
  },
  {
    provider: "openai",
    model: "o1-mini",
    protocol: "openai",
    pricePerMillion: { input: 3.0, output: 12.0 },
    tier: "balanced",
  },
  {
    provider: "openai",
    model: "gpt-4o-mini",
    protocol: "openai",
    pricePerMillion: { input: 0.15, output: 0.6 },
    tier: "cheap",
  },

  // DeepSeek
  {
    provider: "deepseek",
    model: "deepseek-reasoner",
    protocol: "openai",
    pricePerMillion: { input: 0.55, output: 2.19 },
    tier: "balanced",
  },
  {
    provider: "deepseek",
    model: "deepseek-chat",
    protocol: "openai",
    pricePerMillion: { input: 0.27, output: 1.1 },
    tier: "cheap",
  },

  // Groq
  {
    provider: "groq",
    model: "llama-3.3-70b-versatile",
    protocol: "openai",
    pricePerMillion: { input: 0.59, output: 0.79 },
    tier: "cheap",
  },

  // Kimi
  {
    provider: "kimi",
    model: "moonshot-v1-128k",
    protocol: "openai",
    pricePerMillion: { input: 0.84, output: 0.84 },
    tier: "cheap",
  },
];

const BY_KEY = new Map<string, ModelMeta>(MODELS.map((m) => [`${m.provider}/${m.model}`, m]));

export async function computeCost(
  provider: ProviderId,
  model: string,
  inputTokens: number,
  outputTokens: number,
): Promise<number | null> {
  const key = priceKey(provider, model);
  const overlay = await readOverlay();
  const overrideEntry = overlay.prices[key];
  if (overrideEntry) {
    return (
      (inputTokens * overrideEntry.input + outputTokens * overrideEntry.output) / 1_000_000
    );
  }
  const builtin = BY_KEY.get(key);
  if (!builtin) return null;
  return (
    (inputTokens * builtin.pricePerMillion.input +
      outputTokens * builtin.pricePerMillion.output) /
    1_000_000
  );
}

export function listModels(protocol?: Protocol): ModelMeta[] {
  return protocol ? MODELS.filter((m) => m.protocol === protocol) : [...MODELS];
}

export function getModelMeta(provider: ProviderId, model: string): ModelMeta | undefined {
  return BY_KEY.get(`${provider}/${model}`);
}

// Builtin + overlay merged for `thomas prices` display. Overlay entries that
// shadow a builtin show source: "overlay" with overlay's price; tier/protocol
// fall back to the builtin's values unless overlay explicitly sets them.
// Overlay-only entries show source: "overlay" with tier/protocol null unless
// the user passed --tier / --protocol when running `prices set`.
export async function listAllPrices(): Promise<PriceEntry[]> {
  const overlay = await readOverlay();
  const entries: PriceEntry[] = [];

  for (const m of MODELS) {
    const key = priceKey(m.provider, m.model);
    const overlayPrice = overlay.prices[key];
    if (overlayPrice) {
      entries.push({
        provider: m.provider,
        model: m.model,
        pricePerMillion: { input: overlayPrice.input, output: overlayPrice.output },
        source: "overlay",
        tier: overlayPrice.tier ?? m.tier,
        protocol: overlayPrice.protocol ?? m.protocol,
      });
    } else {
      entries.push({
        provider: m.provider,
        model: m.model,
        pricePerMillion: m.pricePerMillion,
        source: "builtin",
        tier: m.tier,
        protocol: m.protocol,
      });
    }
  }

  for (const [key, price] of Object.entries(overlay.prices)) {
    if (BY_KEY.has(key)) continue;
    const slash = key.indexOf("/");
    if (slash <= 0) continue;
    entries.push({
      provider: key.slice(0, slash),
      model: key.slice(slash + 1),
      pricePerMillion: { input: price.input, output: price.output },
      source: "overlay",
      tier: price.tier ?? null,
      protocol: price.protocol ?? null,
    });
  }

  return entries;
}

// Recommender candidate pool: builtin models + overlay entries that have BOTH
// tier and protocol set. Filtered by protocol if given. Returns ModelMeta-shaped
// objects so the recommender doesn't care where they came from.
export async function listCandidateModels(protocol?: Protocol): Promise<ModelMeta[]> {
  const all = await listAllPrices();
  return all
    .filter((e) => e.tier !== null && e.protocol !== null)
    .filter((e) => !protocol || e.protocol === protocol)
    .map((e) => ({
      provider: e.provider,
      model: e.model,
      protocol: e.protocol as Protocol,
      pricePerMillion: e.pricePerMillion,
      tier: e.tier as ModelTier,
    }));
}
