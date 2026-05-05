import { ThomasError, runJson } from "../cli/json.js";
import type {
  ProviderInfo,
  ProvidersAddData,
  ProvidersData,
  ProvidersRegisterData,
  ProvidersRemoveData,
  ProvidersUnregisterData,
} from "../cli/output.js";
import { credentialSourceOf } from "../cli/state.js";
import { readCredentials, upsertCredential, writeCredentials } from "../config/credentials.js";
import {
  getProvider,
  listProviders,
  registerCustom,
  unregisterCustom,
} from "../providers/registry.js";
import type { Protocol } from "../agents/types.js";

export async function providersList(opts: { json: boolean }): Promise<number> {
  return runJson({
    command: "providers",
    json: opts.json,
    fetch: fetchProvidersData,
    printHuman: printProviders,
  });
}

async function fetchProvidersData(): Promise<ProvidersData> {
  const [providersAll, store] = await Promise.all([listProviders(), readCredentials()]);
  const credByProvider = new Map(store.providers.map((c) => [c.provider, c]));
  const providers: ProviderInfo[] = providersAll.map((p) => {
    const cred = credByProvider.get(p.id);
    return {
      id: p.id,
      protocol: p.protocol,
      baseUrl: p.originBaseUrl,
      isBuiltin: !p.custom,
      isCustom: !!p.custom,
      hasCredentials: !!cred,
      credentialSource: credentialSourceOf(cred),
      knownModels: null,
    };
  });
  return { providers };
}

function printProviders(data: ProvidersData): void {
  console.log("Providers");
  for (const p of data.providers) {
    const flag = p.hasCredentials ? "✓" : " ";
    const status = p.credentialSource ?? "—";
    const tag = p.isCustom ? " (custom)" : "";
    console.log(`  ${flag} ${p.id.padEnd(12)} ${p.protocol.padEnd(10)} ${status}${tag}`);
  }
}

export async function providersAdd(
  id: string,
  key: string,
  opts: { json: boolean },
): Promise<number> {
  return runJson({
    command: "providers.add",
    json: opts.json,
    fetch: () => doProvidersAdd(id, key),
    printHuman: (d) =>
      console.log(
        `${d.replacedExisting ? "Updated" : "Added"} api_key for ${d.provider} (${maskKey(key)})`,
      ),
  });
}

async function doProvidersAdd(id: string, key: string): Promise<ProvidersAddData> {
  const provider = await getProvider(id);
  if (!provider) {
    throw new ThomasError({
      code: "E_PROVIDER_NOT_FOUND",
      message: `unknown provider '${id}'`,
      remediation: "Run `thomas providers --json` to see available providers",
      details: { requested: id },
    });
  }
  const before = await readCredentials();
  const replacedExisting = before.providers.some((c) => c.provider === id);
  await upsertCredential({ provider: id, type: "api_key", key });
  return { provider: id, replacedExisting };
}

export async function providersRemove(
  id: string,
  opts: { json: boolean },
): Promise<number> {
  return runJson({
    command: "providers.remove",
    json: opts.json,
    fetch: () => doProvidersRemove(id),
    printHuman: (d) => {
      if (d.removed) console.log(`Removed credentials for ${d.provider}.`);
      else console.log(`No credentials for ${d.provider}.`);
    },
  });
}

async function doProvidersRemove(id: string): Promise<ProvidersRemoveData> {
  const store = await readCredentials();
  const before = store.providers.length;
  store.providers = store.providers.filter((c) => c.provider !== id);
  if (store.providers.length === before) return { provider: id, removed: false };
  await writeCredentials(store);
  return { provider: id, removed: true };
}

export async function providersRegister(
  id: string,
  protocol: string,
  baseUrl: string,
  opts: { json: boolean },
): Promise<number> {
  return runJson({
    command: "providers.register",
    json: opts.json,
    fetch: () => doProvidersRegister(id, protocol, baseUrl),
    printHuman: (d) => {
      const verb = d.replacedExisting ? "Updated" : "Registered";
      console.log(`${verb} custom provider '${d.provider}' (${d.protocol}) at ${d.baseUrl}`);
      console.log(`Add a key with:  thomas providers add ${d.provider} <KEY>`);
    },
  });
}

async function doProvidersRegister(
  id: string,
  protocol: string,
  baseUrl: string,
): Promise<ProvidersRegisterData> {
  if (protocol !== "openai" && protocol !== "anthropic") {
    throw new ThomasError({
      code: "E_INVALID_ARG",
      message: `--protocol must be 'openai' or 'anthropic' (got '${protocol}')`,
      details: { arg: "--protocol", value: protocol },
    });
  }
  if (!/^https?:\/\//.test(baseUrl)) {
    throw new ThomasError({
      code: "E_INVALID_ARG",
      message: "--base-url must be an absolute http(s) URL",
      details: { arg: "--base-url", value: baseUrl },
    });
  }
  // Trim trailing slashes only — preserve any /v1 (or other) path segments the
  // user typed. The proxy decides at request time whether to add /v1 (it does
  // so adaptively when the registered URL has none). Stripping /v1 here would
  // lose path-after-/v1 prefixes like .../v1/gateway.
  const origin = baseUrl.replace(/\/+$/, "");
  const existing = await getProvider(id);
  try {
    await registerCustom({ id, protocol: protocol as Protocol, originBaseUrl: origin });
  } catch (err) {
    throw new ThomasError({
      code: "E_INVALID_ARG",
      message: err instanceof Error ? err.message : String(err),
    });
  }
  return {
    provider: id,
    protocol: protocol as Protocol,
    baseUrl: origin,
    replacedExisting: !!existing,
  };
}

export async function providersUnregister(
  id: string,
  opts: { json: boolean },
): Promise<number> {
  return runJson({
    command: "providers.unregister",
    json: opts.json,
    fetch: () => doProvidersUnregister(id),
    printHuman: (d) => {
      if (d.removed) console.log(`Unregistered custom provider '${d.provider}'.`);
      else console.log(`No custom provider '${d.provider}'.`);
    },
  });
}

async function doProvidersUnregister(id: string): Promise<ProvidersUnregisterData> {
  const removed = await unregisterCustom(id);
  return { provider: id, removed };
}

function maskKey(s: string): string {
  if (s.length <= 8) return "****";
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}
