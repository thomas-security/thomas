import type { Protocol } from "../agents/types.js";
import { ThomasError, runJson } from "../cli/json.js";
import type { PricesData, PricesSetData, PricesUnsetData } from "../cli/output.js";
import { listAllPrices } from "../runs/pricing.js";
import {
  priceKey,
  removeOverlayPrice,
  setOverlayPrice,
  type Price,
} from "../runs/prices-store.js";
import { parseRouteSpec } from "../config/routes.js";

export async function pricesShow(opts: { json: boolean }): Promise<number> {
  return runJson({
    command: "prices",
    json: opts.json,
    fetch: async () => ({ prices: await listAllPrices() }) as PricesData,
    printHuman: printPrices,
  });
}

function printPrices(data: PricesData): void {
  console.log(`Provider/Model${" ".repeat(36)} Proto       Tier      Source    Input/M    Output/M`);
  console.log(`${"-".repeat(95)}`);
  for (const p of data.prices) {
    const key = `${p.provider}/${p.model}`.padEnd(50);
    const proto = (p.protocol ?? "—").padEnd(11);
    const tier = (p.tier ?? "—").padEnd(9);
    const src = p.source.padEnd(9);
    const input = `$${p.pricePerMillion.input.toFixed(2)}`.padStart(9);
    const output = `$${p.pricePerMillion.output.toFixed(2)}`.padStart(9);
    console.log(`${key} ${proto} ${tier} ${src} ${input}  ${output}`);
  }
}

export type PricesSetOptions = {
  json: boolean;
  modelSpec: string;
  inputUsd: number;
  outputUsd: number;
  protocol?: string;
  tier?: string;
};

export async function pricesSet(opts: PricesSetOptions): Promise<number> {
  return runJson({
    command: "prices.set",
    json: opts.json,
    fetch: () => doPricesSet(opts),
    printHuman: (d) => {
      const verb = d.replacedExisting ? "Updated" : "Added";
      const note = d.overridesBuiltin ? " (overrides builtin)" : "";
      const meta: string[] = [];
      if (d.protocol) meta.push(`protocol=${d.protocol}`);
      if (d.tier) meta.push(`tier=${d.tier}`);
      const metaStr = meta.length ? ` [${meta.join(", ")}]` : "";
      console.log(
        `${verb} overlay price for ${d.provider}/${d.model}${note}: $${d.pricePerMillion.input.toFixed(2)}/M in, $${d.pricePerMillion.output.toFixed(2)}/M out${metaStr}`,
      );
    },
  });
}

async function doPricesSet(opts: PricesSetOptions): Promise<PricesSetData> {
  const parsed = parseRouteSpec(opts.modelSpec);
  if (!parsed) {
    throw new ThomasError({
      code: "E_INVALID_ARG",
      message: `model spec must be in 'provider/model' form (got '${opts.modelSpec}')`,
      details: { arg: "<provider/model>", value: opts.modelSpec },
    });
  }
  if (!Number.isFinite(opts.inputUsd) || opts.inputUsd < 0) {
    throw new ThomasError({
      code: "E_INVALID_ARG",
      message: `--input must be a non-negative number`,
      details: { arg: "--input", value: opts.inputUsd },
    });
  }
  if (!Number.isFinite(opts.outputUsd) || opts.outputUsd < 0) {
    throw new ThomasError({
      code: "E_INVALID_ARG",
      message: `--output must be a non-negative number`,
      details: { arg: "--output", value: opts.outputUsd },
    });
  }
  const protocol = parseProtocol(opts.protocol);
  const tier = parseTier(opts.tier);
  const key = priceKey(parsed.provider, parsed.model);
  const all = await listAllPrices();
  const overridesBuiltin = all.some(
    (e) =>
      e.source === "builtin" && e.provider === parsed.provider && e.model === parsed.model,
  );
  const entry: Price = { input: opts.inputUsd, output: opts.outputUsd };
  if (protocol) entry.protocol = protocol;
  if (tier) entry.tier = tier;
  const result = await setOverlayPrice(key, entry);
  return {
    provider: parsed.provider,
    model: parsed.model,
    pricePerMillion: { input: opts.inputUsd, output: opts.outputUsd },
    protocol: protocol ?? null,
    tier: tier ?? null,
    replacedExisting: result.replacedExisting,
    overridesBuiltin,
  };
}

function parseProtocol(raw: string | undefined): Protocol | undefined {
  if (raw === undefined) return undefined;
  if (raw === "openai" || raw === "anthropic") return raw;
  throw new ThomasError({
    code: "E_INVALID_ARG",
    message: `--protocol must be 'openai' or 'anthropic' (got '${raw}')`,
    details: { arg: "--protocol", value: raw },
  });
}

function parseTier(raw: string | undefined): "premium" | "balanced" | "cheap" | undefined {
  if (raw === undefined) return undefined;
  if (raw === "premium" || raw === "balanced" || raw === "cheap") return raw;
  throw new ThomasError({
    code: "E_INVALID_ARG",
    message: `--tier must be 'premium', 'balanced', or 'cheap' (got '${raw}')`,
    details: { arg: "--tier", value: raw },
  });
}

export async function pricesUnset(
  modelSpec: string,
  opts: { json: boolean },
): Promise<number> {
  return runJson({
    command: "prices.unset",
    json: opts.json,
    fetch: () => doPricesUnset(modelSpec),
    printHuman: (d) => {
      if (d.removed) console.log(`Removed overlay price for ${d.provider}/${d.model}.`);
      else console.log(`No overlay price for ${d.provider}/${d.model} (builtin entries can't be removed).`);
    },
  });
}

async function doPricesUnset(modelSpec: string): Promise<PricesUnsetData> {
  const parsed = parseRouteSpec(modelSpec);
  if (!parsed) {
    throw new ThomasError({
      code: "E_INVALID_ARG",
      message: `model spec must be in 'provider/model' form (got '${modelSpec}')`,
      details: { arg: "<provider/model>", value: modelSpec },
    });
  }
  const key = priceKey(parsed.provider, parsed.model);
  const removed = await removeOverlayPrice(key);
  return { provider: parsed.provider, model: parsed.model, removed };
}
