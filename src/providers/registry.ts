import { readJson, writeJsonAtomic } from "../config/io.js";
import { paths } from "../config/paths.js";
import type { Protocol } from "../agents/types.js";

export type ProviderSpec = {
  id: string;
  protocol: Protocol;
  /**
   * Base URL up to (but not including) the verb segment (`/chat/completions`,
   * `/messages`). May end at the origin (e.g. `https://api.openai.com`) OR
   * include any path prefix the user wants — including a `/v1` segment. Both
   * styles are supported:
   *   - `https://api.openai.com`            (legacy: proxy adds `/v1` adaptively)
   *   - `https://api.openai.com/v1`         (preferred: proxy uses as-is)
   *   - `https://api.xiangxinai.cn/v1/gateway`  (path-after-/v1 prefixes are preserved)
   *   - `https://api.groq.com/openai`       (path-before-/v1 prefixes — proxy adds /v1)
   * The proxy's adaptive resolver (see buildOutboundCandidates in proxy/server.ts)
   * tries the URL as-typed first, falling back to inserting /v1 only if the
   * upstream returns 404.
   */
  originBaseUrl: string;
  custom?: boolean;
};

const BUILTIN: Record<string, ProviderSpec> = {
  anthropic: { id: "anthropic", protocol: "anthropic", originBaseUrl: "https://api.anthropic.com" },
  openai: { id: "openai", protocol: "openai", originBaseUrl: "https://api.openai.com" },
  openrouter: { id: "openrouter", protocol: "openai", originBaseUrl: "https://openrouter.ai/api" },
  kimi: { id: "kimi", protocol: "openai", originBaseUrl: "https://api.moonshot.cn" },
  deepseek: { id: "deepseek", protocol: "openai", originBaseUrl: "https://api.deepseek.com" },
  groq: { id: "groq", protocol: "openai", originBaseUrl: "https://api.groq.com/openai" },
};

type CustomStore = { providers: ProviderSpec[] };

export async function getProvider(id: string): Promise<ProviderSpec | undefined> {
  if (BUILTIN[id]) return BUILTIN[id];
  const custom = await readCustom();
  return custom.providers.find((p) => p.id === id);
}

export async function listProviders(): Promise<ProviderSpec[]> {
  const custom = await readCustom();
  return [...Object.values(BUILTIN), ...custom.providers.map((p) => ({ ...p, custom: true }))];
}

export async function registerCustom(spec: ProviderSpec): Promise<void> {
  if (BUILTIN[spec.id]) {
    throw new Error(`'${spec.id}' is a built-in provider; pick a different id`);
  }
  const store = await readCustom();
  const idx = store.providers.findIndex((p) => p.id === spec.id);
  if (idx >= 0) store.providers[idx] = spec;
  else store.providers.push(spec);
  await writeJsonAtomic(paths.providers, store);
}

export async function unregisterCustom(id: string): Promise<boolean> {
  const store = await readCustom();
  const before = store.providers.length;
  store.providers = store.providers.filter((p) => p.id !== id);
  if (store.providers.length === before) return false;
  await writeJsonAtomic(paths.providers, store);
  return true;
}

async function readCustom(): Promise<CustomStore> {
  return readJson<CustomStore>(paths.providers, { providers: [] });
}
