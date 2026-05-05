// Bridge: surface provider metadata from the cloud-cache so the proxy can
// route to providers configured ONLY on thomas-cloud (not yet registered
// locally via `thomas providers register`).
//
// Privacy boundary unchanged: this returns *metadata only* (origin URL,
// protocol). Credentials NEVER come from the cloud — they stay in the local
// `~/.thomas/credentials.json`. If the user binds an agent to a cloud
// provider for which they haven't `thomas providers add <id> <key>`'d a key
// locally, the proxy still returns a credential-missing error — just with a
// clearer remediation message than the legacy "unknown provider" 503.

import type { ProviderSpec } from "../providers/registry.js";
import { readCache } from "./cache.js";
import type { Protocol } from "../agents/types.js";

type WireProvider = {
  providerId: string;
  protocol: string;
  originBaseUrl?: string | null;
  isBuiltin?: boolean;
};

/**
 * Look up `providerId` in the cloud cache's `providers[]` and return a
 * ProviderSpec if found. Returns undefined when there's no cache, the
 * provider isn't in it, or its protocol is something we don't understand.
 *
 * Caller is expected to have already checked the local registry / store —
 * this is a fallback path, not a replacement.
 */
export async function loadProviderFromCloudCache(
  providerId: string,
): Promise<ProviderSpec | undefined> {
  const snapshot = await readCache();
  const wire = (snapshot.providers as WireProvider[]).find(
    (p) => p.providerId === providerId,
  );
  if (!wire) return undefined;
  if (wire.protocol !== "openai" && wire.protocol !== "anthropic") return undefined;
  if (!wire.originBaseUrl) return undefined;
  return {
    id: wire.providerId,
    protocol: wire.protocol as Protocol,
    originBaseUrl: wire.originBaseUrl,
    custom: !wire.isBuiltin,
  };
}
