import type { CostCascadePolicy } from "./types.js";

// Status codes worth retrying on. Excludes 4xx auth/client errors (400/401/403/404)
// — those won't get better on a different provider.
//   0     network failure (fetch threw)
//   408   request timeout
//   429   rate limited
//   500+  upstream/server errors
export function isRetryableStatus(status: number): boolean {
  if (status === 0) return true;
  if (status === 408 || status === 429) return true;
  return status >= 500;
}

export function shouldFailover(
  upstreamStatus: number,
  policy: CostCascadePolicy | undefined,
): { yes: true; target: { provider: string; model: string } } | { yes: false } {
  if (!policy?.failoverTo) return { yes: false };
  if (!isRetryableStatus(upstreamStatus)) return { yes: false };
  return { yes: true, target: policy.failoverTo };
}
