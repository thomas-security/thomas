// User-managed pricing overlay at ~/.thomas/prices.json.
// Keyed by "<provider>/<model>" (same shape as the hardcoded MODELS table).
// Overrides any builtin entry with the same key, and adds entries for models
// the builtin table doesn't know about (custom OpenRouter routes, vLLM, etc.).
//
// Optional `protocol` + `tier` metadata makes overlay entries eligible for
// `thomas recommend` candidate selection. Without them, the entry only powers
// cost computation; recommend won't suggest it.

import type { Protocol } from "../agents/types.js";
import { readJson, writeJsonAtomic } from "../config/io.js";
import { paths } from "../config/paths.js";

export type Price = {
  input: number;
  output: number;
  protocol?: Protocol;
  tier?: "premium" | "balanced" | "cheap";
};

export type PricesOverlay = {
  prices: Record<string, Price>;
};

export async function readOverlay(): Promise<PricesOverlay> {
  // fresh default each call — readJson returns the default by reference,
  // and setOverlayPrice mutates the store, so a shared module-level default would leak.
  return readJson<PricesOverlay>(paths.prices, { prices: {} });
}

export async function setOverlayPrice(
  key: string,
  price: Price,
): Promise<{ replacedExisting: boolean }> {
  const overlay = await readOverlay();
  const replacedExisting = key in overlay.prices;
  overlay.prices[key] = price;
  await writeJsonAtomic(paths.prices, overlay);
  return { replacedExisting };
}

export async function removeOverlayPrice(key: string): Promise<boolean> {
  const overlay = await readOverlay();
  if (!(key in overlay.prices)) return false;
  delete overlay.prices[key];
  await writeJsonAtomic(paths.prices, overlay);
  return true;
}

export function priceKey(provider: string, model: string): string {
  return `${provider}/${model}`;
}
