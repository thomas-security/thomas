// HTTP client for thomas-cloud — single concern: assemble URLs, attach the
// device token (when present), and surface failures as ThomasErrors with
// stable codes the calling command can interpret.
//
// Stays small on purpose. No retry / backoff for v1 — if the cloud is down
// or slow, fail loud so the user knows. Background sync (PR4 candidate) can
// add retry around this.

import { ThomasError } from "../cli/json.js";
import type { ErrorCode } from "../cli/output.js";

export type CloudFetchOptions = {
  baseUrl: string;
  /** When set, sent as Authorization: Bearer ${deviceToken}. */
  deviceToken?: string;
  /** Per-request timeout in ms. Default 10s. */
  timeoutMs?: number;
};

export async function cloudFetch(
  path: string,
  init: RequestInit,
  opts: CloudFetchOptions,
): Promise<Response> {
  const url = `${opts.baseUrl.replace(/\/+$/, "")}${path}`;
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (opts.deviceToken) {
    headers.set("authorization", `Bearer ${opts.deviceToken}`);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 10_000);
  try {
    return await fetch(url, { ...init, headers, signal: ctrl.signal });
  } catch (err) {
    throw asThomasError(err, url);
  } finally {
    clearTimeout(timer);
  }
}

/** GET <path> + parse JSON, with the auth/timeout treatment above. */
export async function cloudGetJson<T>(
  path: string,
  opts: CloudFetchOptions,
): Promise<T> {
  const resp = await cloudFetch(path, { method: "GET" }, opts);
  return await readJsonOrThrow<T>(resp, path);
}

export async function cloudPostJson<T>(
  path: string,
  body: unknown,
  opts: CloudFetchOptions,
): Promise<T> {
  const resp = await cloudFetch(
    path,
    { method: "POST", body: JSON.stringify(body) },
    opts,
  );
  return await readJsonOrThrow<T>(resp, path);
}

async function readJsonOrThrow<T>(resp: Response, path: string): Promise<T> {
  if (resp.ok) return (await resp.json()) as T;
  const code = mapStatusToCode(resp.status);
  let detail: unknown;
  try {
    detail = await resp.json();
  } catch {
    detail = await resp.text().catch(() => "");
  }
  throw new ThomasError({
    code,
    message: `${resp.status} ${resp.statusText} from ${path}`,
    details: detail,
  });
}

function mapStatusToCode(status: number): ErrorCode {
  if (status === 401 || status === 403) return "E_CLOUD_UNAUTHORIZED";
  return "E_CLOUD_UNREACHABLE";
}

function asThomasError(err: unknown, url: string): ThomasError {
  const isAbort = err instanceof Error && err.name === "AbortError";
  return new ThomasError({
    code: isAbort ? "E_CLOUD_TIMEOUT" : "E_CLOUD_UNREACHABLE",
    message: isAbort
      ? `request to ${url} timed out`
      : `could not reach ${url}: ${err instanceof Error ? err.message : String(err)}`,
    remediation: isAbort
      ? "Check your network or set THOMAS_CLOUD_BASE_URL to a reachable host."
      : "Verify thomas-cloud is up. For local dev, set THOMAS_CLOUD_BASE_URL=http://localhost:8000.",
  });
}
