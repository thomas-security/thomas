// Provider reachability probe — a quick, two-phase check that classifies the
// response so we can warn early when an imported provider's base URL is wrong,
// rather than waiting for the user's first real model call to 401/404.
//
// Why two phases: GET /v1/models is the canonical "list models" endpoint and
// gives the cleanest signal (200/401/403/etc.) when supported — but plenty of
// real OpenAI-compatible servers (e.g. xiangxinai's /v1 endpoint) don't expose
// /models at all and return 404. To avoid false-positive "wrong_path" warnings
// on those, when /v1/models returns 404 we fall back to an OPTIONS preflight at
// the verb endpoint (/v1/chat/completions or /v1/messages). A reachable URL
// almost always answers OPTIONS with 2xx (CORS preflight); a nonexistent URL
// answers 404. The 405 case (anthropic does this) is ambiguous and reported as
// `models_unavailable` so the agent/user knows to verify with a real request.
//
// The probe deliberately reuses the proxy's adaptive URL resolver (see
// buildOutboundCandidates in ../proxy/server.ts), so a provider whose
// originBaseUrl lacks /v1 is given the same try-without-then-with treatment as
// real traffic.

import { findCredential, resolveSecret } from "../config/credentials.js";
import { buildOutboundCandidates } from "../proxy/server.js";
import { getProvider, type ProviderSpec } from "./registry.js";

export type ProbeReason =
  // Network failure (DNS, ECONNREFUSED, timeout, TLS error, etc.)
  | "unreachable"
  // 404 on every candidate URL — the path almost certainly doesn't exist on this server
  | "wrong_path"
  // 401 / 403 — server is reachable and the path probably exists, but the credential is rejected
  | "auth_failed"
  // /v1/models 404 + OPTIONS at verb endpoint returned a non-2xx, non-404 (typically 405).
  // Ambiguous: either URL is wrong OR server is strict about probe requests.
  | "models_unavailable"
  // 5xx, or any other non-2xx that doesn't fit the categories above
  | "other";

export type ProbeResult =
  | { ok: true; provider: string; status: number; url: string; latencyMs: number }
  | {
      ok: false;
      provider: string;
      reason: ProbeReason;
      status: number | null;
      url: string;
      latencyMs: number;
      message: string;
    };

export type ProbeOptions = {
  /** Per-attempt timeout. Default 4000ms. */
  timeoutMs?: number;
};

export async function probeProvider(
  spec: ProviderSpec,
  opts: ProbeOptions = {},
): Promise<ProbeResult> {
  const cred = await findCredential(spec.id);
  const secret = cred ? resolveSecret(cred) ?? null : null;
  const authHeaders = buildAuthHeaders(spec, secret);
  const timeoutMs = opts.timeoutMs ?? 4000;

  // Phase 1: GET /v1/models with auth — best signal when supported.
  const phase1 = await tryRequest({
    spec,
    method: "GET",
    verbPath: "/v1/models",
    headers: { accept: "application/json", ...authHeaders },
    timeoutMs,
  });

  // 2xx, 401/403, 5xx, network errors all flow back unchanged.
  if (phase1.ok || phase1.reason !== "wrong_path") return phase1;

  // Phase 2: /v1/models 404 on every candidate — fall back to OPTIONS at the
  // verb endpoint so we don't false-flag servers that just don't expose /models.
  const verbPath = spec.protocol === "anthropic" ? "/v1/messages" : "/v1/chat/completions";
  const phase2 = await tryRequest({
    spec,
    method: "OPTIONS",
    verbPath,
    // OPTIONS is a CORS preflight; auth headers normally aren't needed and may be
    // rejected by some load balancers. Send unauthenticated for cleanest signal.
    headers: { accept: "application/json" },
    timeoutMs,
  });

  if (phase2.ok) {
    // URL is reachable at the verb endpoint — the /models 404 was just "not exposed."
    return {
      ok: true,
      provider: spec.id,
      status: phase2.status,
      url: phase2.url,
      latencyMs: phase2.latencyMs,
    };
  }
  if (phase2.reason === "unreachable") return phase2;
  if (phase2.reason === "wrong_path") {
    // 404 on both /v1/models and OPTIONS at the verb — confident the URL is wrong.
    return {
      ok: false,
      provider: spec.id,
      reason: "wrong_path",
      status: 404,
      url: phase2.url,
      latencyMs: phase2.latencyMs,
      message: "HTTP 404 on both /v1/models and OPTIONS at the verb endpoint",
    };
  }
  // 4xx (typically 405) or 5xx on OPTIONS — ambiguous. anthropic real API
  // returns 405 here; so does xiangxinai's openresty default for unknown paths.
  // Cannot discriminate by status alone — surface so the agent/user can verify.
  return {
    ok: false,
    provider: spec.id,
    reason: "models_unavailable",
    status: phase2.status,
    url: phase2.url,
    latencyMs: phase2.latencyMs,
    message: `inconclusive: GET /v1/models returned 404 and OPTIONS at the verb endpoint returned HTTP ${phase2.status}. The base URL might be wrong, or the server is strict about probe requests. Confirm with a real chat request.`,
  };
}

function buildAuthHeaders(spec: ProviderSpec, secret: string | null): Record<string, string> {
  if (!secret) return {};
  if (spec.protocol === "anthropic") {
    return { "x-api-key": secret, "anthropic-version": "2023-06-01" };
  }
  return { authorization: `Bearer ${secret}` };
}

async function tryRequest(args: {
  spec: ProviderSpec;
  method: "GET" | "OPTIONS";
  verbPath: string;
  headers: Record<string, string>;
  timeoutMs: number;
}): Promise<ProbeResult> {
  const candidates = buildOutboundCandidates(args.spec.originBaseUrl, args.verbPath);
  let lastFail: Extract<ProbeResult, { ok: false }> | undefined;

  for (let i = 0; i < candidates.length; i++) {
    const url = candidates[i]!;
    const start = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), args.timeoutMs);
    let resp: Response;
    try {
      resp = await fetch(url, { method: args.method, headers: args.headers, signal: ctrl.signal });
      clearTimeout(timer);
    } catch (err) {
      clearTimeout(timer);
      lastFail = {
        ok: false,
        provider: args.spec.id,
        reason: "unreachable",
        status: null,
        url,
        latencyMs: Date.now() - start,
        message: err instanceof Error ? err.message : String(err),
      };
      continue;
    }
    const latencyMs = Date.now() - start;
    await resp.body?.cancel().catch(() => undefined);

    if (resp.ok) {
      return { ok: true, provider: args.spec.id, status: resp.status, url, latencyMs };
    }
    if (resp.status === 401 || resp.status === 403) {
      return {
        ok: false,
        provider: args.spec.id,
        reason: "auth_failed",
        status: resp.status,
        url,
        latencyMs,
        message: `HTTP ${resp.status}`,
      };
    }
    if (resp.status === 404) {
      lastFail = {
        ok: false,
        provider: args.spec.id,
        reason: "wrong_path",
        status: 404,
        url,
        latencyMs,
        message: `HTTP 404 at ${args.verbPath}`,
      };
      continue;
    }
    return {
      ok: false,
      provider: args.spec.id,
      reason: "other",
      status: resp.status,
      url,
      latencyMs,
      message: `HTTP ${resp.status}`,
    };
  }

  return (
    lastFail ?? {
      ok: false,
      provider: args.spec.id,
      reason: "unreachable",
      status: null,
      url: args.spec.originBaseUrl,
      latencyMs: 0,
      message: "no candidate URLs",
    }
  );
}

/** Probe a list of provider IDs in parallel. Unknown IDs are silently skipped. */
export async function probeProviders(
  providerIds: readonly string[],
  opts: ProbeOptions = {},
): Promise<ProbeResult[]> {
  const specs = await Promise.all(providerIds.map((id) => getProvider(id)));
  const tasks = specs
    .map((s) => (s ? probeProvider(s, opts) : null))
    .filter((p): p is Promise<ProbeResult> => p !== null);
  return Promise.all(tasks);
}
