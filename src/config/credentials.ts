import { paths } from "./paths.js";
import { readJson, writeJsonAtomic } from "./io.js";

export type SecretRef = {
  source: "env" | "file" | "exec";
  id: string;
};

export type Credential = {
  provider: string;
  type: "api_key" | "oauth" | "token";
  key?: string;
  keyRef?: SecretRef;
  access?: string;
  refresh?: string;
  expiresAt?: number;
  metadata?: Record<string, string>;
};

type CredentialStore = { providers: Credential[] };

export async function readCredentials(): Promise<CredentialStore> {
  return readJson<CredentialStore>(paths.credentials, { providers: [] });
}

export async function writeCredentials(store: CredentialStore): Promise<void> {
  await writeJsonAtomic(paths.credentials, store);
}

export async function upsertCredential(cred: Credential): Promise<void> {
  const store = await readCredentials();
  const idx = store.providers.findIndex((c) => c.provider === cred.provider);
  if (idx >= 0) {
    store.providers[idx] = cred;
  } else {
    store.providers.push(cred);
  }
  await writeCredentials(store);
}

export async function findCredential(provider: string): Promise<Credential | undefined> {
  const store = await readCredentials();
  return store.providers.find((c) => c.provider === provider);
}

export function resolveSecret(cred: Credential): string | undefined {
  if (cred.key) return cred.key;
  if (cred.access) return cred.access;
  if (cred.keyRef?.source === "env") return process.env[cred.keyRef.id];
  return undefined;
}
