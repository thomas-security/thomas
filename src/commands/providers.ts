import { readCredentials, upsertCredential, writeCredentials } from "../config/credentials.js";
import {
  getProvider,
  listProviders,
  registerCustom,
  unregisterCustom,
} from "../providers/registry.js";
import type { Protocol } from "../agents/types.js";

export async function providersList(): Promise<void> {
  const store = await readCredentials();
  const configured = new Set(store.providers.map((c) => c.provider));
  console.log("Providers");
  for (const p of await listProviders()) {
    const cred = store.providers.find((c) => c.provider === p.id);
    const status = cred
      ? cred.key
        ? `api_key (${maskKey(cred.key)})`
        : cred.access
          ? `oauth (${maskKey(cred.access)})`
          : cred.keyRef
            ? `${cred.keyRef.source}:${cred.keyRef.id}`
            : "unknown"
      : "—";
    const flag = configured.has(p.id) ? "✓" : " ";
    const tag = p.custom ? " (custom)" : "";
    console.log(`  ${flag} ${p.id.padEnd(12)} ${p.protocol.padEnd(10)} ${status}${tag}`);
  }
}

export async function providersAdd(id: string, key: string): Promise<number> {
  const provider = await getProvider(id);
  if (!provider) {
    console.error(`thomas: unknown provider '${id}'. Run \`thomas providers\` to see options.`);
    return 1;
  }
  await upsertCredential({ provider: id, type: "api_key", key });
  console.log(`Added api_key for ${id} (${maskKey(key)})`);
  return 0;
}

export async function providersRemove(id: string): Promise<number> {
  const store = await readCredentials();
  const before = store.providers.length;
  store.providers = store.providers.filter((c) => c.provider !== id);
  if (store.providers.length === before) {
    console.log(`No credentials for ${id}.`);
    return 0;
  }
  await writeCredentials(store);
  console.log(`Removed credentials for ${id}.`);
  return 0;
}

export async function providersRegister(
  id: string,
  protocol: string,
  baseUrl: string,
): Promise<number> {
  if (protocol !== "openai" && protocol !== "anthropic") {
    console.error(`thomas: --protocol must be 'openai' or 'anthropic' (got '${protocol}')`);
    return 1;
  }
  if (!/^https?:\/\//.test(baseUrl)) {
    console.error("thomas: --base-url must be an absolute http(s) URL");
    return 1;
  }
  const origin = baseUrl.replace(/\/+$/, "").replace(/\/v1(\/[^?]*)?$/, "");
  try {
    await registerCustom({
      id,
      protocol: protocol as Protocol,
      originBaseUrl: origin,
    });
  } catch (err) {
    console.error(`thomas: ${err}`);
    return 1;
  }
  console.log(`Registered custom provider '${id}' (${protocol}) at ${origin}`);
  console.log(`Add a key with:  thomas providers add ${id} <KEY>`);
  return 0;
}

export async function providersUnregister(id: string): Promise<number> {
  const removed = await unregisterCustom(id);
  if (!removed) {
    console.log(`No custom provider '${id}'.`);
    return 0;
  }
  console.log(`Unregistered custom provider '${id}'.`);
  return 0;
}

function maskKey(s: string): string {
  if (s.length <= 8) return "****";
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}
