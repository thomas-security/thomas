import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { findByToken } from "../config/agents.js";
import { findCredential, resolveSecret } from "../config/credentials.js";
import { paths } from "../config/paths.js";
import { getRoute } from "../config/routes.js";
import { getAgent } from "../agents/registry.js";
import { loadProviderFromCloudCache } from "../cloud/providers.js";
import { getProvider, type ProviderSpec } from "../providers/registry.js";
import type { AgentId, AgentSpec, Protocol } from "../agents/types.js";
import { decideForAgent } from "../policy/decide.js";
import { shouldFailover } from "../policy/failover.js";
import { computeCost } from "../runs/pricing.js";
import { appendRun } from "../runs/store.js";
import { StreamUsageWatcher, ZERO_USAGE, extractUsageFromBody, type Usage } from "../runs/usage.js";
import * as AtoO from "./translate/anthropic-to-openai.js";
import * as OtoA from "./translate/openai-to-anthropic.js";
import { ensureOpenAIIncludeUsage } from "./usage-injection.js";

export async function startServer(port: number, host = "127.0.0.1"): Promise<Server> {
  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      log("error", `unhandled: ${err}`);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(`thomas proxy error: ${err}`);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  await writeFile(paths.proxyPid, String(process.pid));
  log("info", `listening on http://${host}:${port}`);
  return server;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}\n');
    return;
  }

  const token =
    headerString(req.headers["x-api-key"]) ??
    headerString(req.headers.authorization)?.replace(/^Bearer\s+/i, "");
  if (!token) return reply(res, 401, "Missing auth header");

  const found = await findByToken(token);
  if (!found) return reply(res, 401, "Unknown thomas token");

  const agent = getAgent(found.agentId);
  if (!agent) return reply(res, 500, `Agent registry missing entry for ${found.agentId}`);

  const route = await getRoute(found.agentId);
  if (!route) {
    return reply(
      res,
      503,
      `No route for agent ${found.agentId}. Run \`thomas route ${found.agentId} <provider/model>\`.`,
    );
  }

  // Apply policy (cost cascade, etc.) — may rewrite provider+model.
  // Cloud-backed cache takes precedence over local ~/.thomas/policies.json
  // when the user is logged in to thomas-cloud; see src/policy/decide.ts.
  const decision = await decideForAgent(found.agentId as AgentId, {
    provider: route.provider,
    model: route.model,
  });
  const effective = decision.target;
  const policyConfig = decision.policy ?? undefined;

  const inboundBody = await readBody(req);
  const inboundPath = req.url ?? "";

  const runStart = Date.now();
  const startedAt = new Date(runStart).toISOString();
  // Caller-provided run-id groups multiple model calls into one logical task.
  // Optional — older agents that don't send it get a generated UUID per request,
  // which still works (each call aggregates to itself with modelCalls=1).
  const runId = headerString(req.headers["x-thomas-run-id"]) || randomUUID();

  // Try the cascade-determined effective target. On retryable error + configured failover,
  // retry once on the failover target. Only pre-stream errors are retryable; once we start
  // writing 200 bytes to res, we're committed to the current upstream.
  let outcome = await attempt({ agent, target: effective, inboundBody, inboundPath, req });
  let actualTarget = effective;
  let failoverNote: string | null = null;
  let failovers = 0;

  const triggerStatus = outcome.ok ? outcome.upstream.status : outcome.status;
  const failoverDecision = shouldFailover(triggerStatus, policyConfig);
  if (failoverDecision.yes) {
    const reasonStr = outcome.ok
      ? `HTTP ${outcome.upstream.status}`
      : (outcome.reply || "fetch error");
    failoverNote = `primary ${effective.provider}/${effective.model} ${reasonStr}; failed over to ${failoverDecision.target.provider}/${failoverDecision.target.model}`;
    log("info", `[failover] ${found.agentId} ${failoverNote}`);
    if (outcome.ok) {
      await outcome.upstream.body?.cancel().catch(() => undefined);
    }
    const retried = await attempt({
      agent,
      target: failoverDecision.target,
      inboundBody,
      inboundPath,
      req,
    });
    if (retried.ok) {
      outcome = retried;
      actualTarget = failoverDecision.target;
      failovers = 1;
    } else {
      // failover also failed; surface both reasons
      failoverNote = `${failoverNote}; failover also failed: ${retried.reply}`;
    }
  }

  const tracker: RunTracker = {
    runId,
    agent: found.agentId as AgentId,
    inboundProtocol: agent.protocol,
    provider: actualTarget.provider,
    model: actualTarget.model,
    streamed: outcome.ok ? outcome.isStream : false,
    failovers,
    failoverNote,
  };

  if (!outcome.ok) {
    await persistRun({
      tracker,
      startedAt,
      durationMs: Date.now() - runStart,
      usage: ZERO_USAGE,
      httpStatus: outcome.status,
      errorMessage: outcome.reply,
    });
    return reply(res, 502, outcome.reply);
  }

  const { upstream, provider, direction, isStream } = outcome;

  log(
    "info",
    `${found.agentId} → ${provider.id}/${actualTarget.model}${decision.policyId ? ` [policy:${decision.policyId}]` : ""}${failovers ? " [failover]" : ""} ${direction === "passthrough" ? "(passthrough)" : `(${direction})`} ${req.method} ${req.url}`,
  );

  const watcher = isStream ? new StreamUsageWatcher(provider.protocol) : null;
  // For non-streaming, collect bytes (passthrough delivers Uint8Array chunks) AND/OR
  // the string passed by streamTranslatedResponse for non-streaming. Either fills the same buffer.
  const nonStreamingChunks: Uint8Array[] = [];
  const onUpstreamRaw = (chunk: Uint8Array | string) => {
    if (isStream) {
      if (typeof chunk !== "string") watcher?.feed(chunk);
      return;
    }
    if (typeof chunk === "string") {
      nonStreamingChunks.push(new TextEncoder().encode(chunk));
    } else {
      nonStreamingChunks.push(chunk);
    }
  };

  try {
    if (direction === "anthropic-to-openai") {
      await streamTranslatedResponse({
        upstream,
        res,
        model: actualTarget.model,
        isStream,
        contentType: "application/json",
        streamContentType: "text/event-stream",
        translateBody: OtoA.translateResponseBody,
        makeStreamTranslator: (m) => new OtoA.StreamTranslator(m),
        errorWrap: toAnthropicError,
        onUpstreamRaw,
      });
    } else if (direction === "openai-to-anthropic") {
      await streamTranslatedResponse({
        upstream,
        res,
        model: actualTarget.model,
        isStream,
        contentType: "application/json",
        streamContentType: "text/event-stream",
        translateBody: AtoO.translateResponseBody,
        makeStreamTranslator: (m) => new AtoO.StreamTranslator(m),
        errorWrap: toOpenAIError,
        onUpstreamRaw,
      });
    } else {
      await streamPassthrough({ upstream, res, onUpstreamRaw });
    }
  } finally {
    let usage: Usage;
    if (watcher) {
      usage = watcher.finalize();
    } else {
      const total = nonStreamingChunks.reduce((n, c) => n + c.byteLength, 0);
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const c of nonStreamingChunks) {
        merged.set(c, offset);
        offset += c.byteLength;
      }
      const text = new TextDecoder().decode(merged);
      usage = extractUsageFromBody(text, provider.protocol);
    }
    await persistRun({
      tracker,
      startedAt,
      durationMs: Date.now() - runStart,
      usage,
      httpStatus: upstream.status,
      errorMessage: upstream.ok ? null : `upstream ${upstream.status}`,
    });
  }
}

type AttemptOutcome =
  | {
      ok: true;
      provider: ProviderSpec;
      direction: Direction;
      isStream: boolean;
      upstream: Response;
    }
  | { ok: false; status: number; reply: string };

async function attempt(params: {
  agent: AgentSpec;
  target: { provider: string; model: string };
  inboundBody: string;
  inboundPath: string;
  req: IncomingMessage;
}): Promise<AttemptOutcome> {
  // Local registry first (builtins + ~/.thomas/providers.json). Falls back to
  // the cloud-cache snapshot — covers the case where the user configured a
  // provider on thomas-cloud but hasn't run `thomas providers register` locally.
  // Credential lookup is unchanged: keys NEVER come from cloud, only from
  // ~/.thomas/credentials.json.
  let provider = await getProvider(params.target.provider);
  let providerSource: "local" | "cloud" = "local";
  if (!provider) {
    provider = await loadProviderFromCloudCache(params.target.provider);
    if (provider) providerSource = "cloud";
  }
  if (!provider) {
    return {
      ok: false,
      status: 503,
      reply: `Unknown provider ${params.target.provider}`,
    };
  }
  const cred = await findCredential(provider.id);
  if (!cred) {
    const hint =
      providerSource === "cloud"
        ? ` Provider was delivered from thomas-cloud; add a local key with \`thomas providers add ${provider.id} <key>\`.`
        : "";
    return {
      ok: false,
      status: 503,
      reply: `No credentials for provider ${provider.id}.${hint}`,
    };
  }
  const secret = resolveSecret(cred);
  if (!secret) {
    return { ok: false, status: 503, reply: `Could not resolve secret for ${provider.id}` };
  }
  const direction = directionOf(params.agent, provider);
  const { outboundBody, outboundPath, isStream } = prepareOutbound({
    direction,
    inboundBody: params.inboundBody,
    inboundPath: params.inboundPath,
    routeModel: params.target.model,
  });
  // For OpenAI-protocol upstreams: ensure stream_options.include_usage so the
  // final SSE chunk carries token counts. No-op when stream !== true or when
  // the user already specified include_usage explicitly.
  const finalBody =
    provider.protocol === "openai" ? ensureOpenAIIncludeUsage(outboundBody) : outboundBody;
  const outboundHeaders = buildOutboundHeaders({ provider, cred, req: params.req, secret });
  const candidates = buildOutboundCandidates(provider.originBaseUrl, outboundPath);

  let upstream: Response | undefined;
  let lastErr: unknown;
  for (let i = 0; i < candidates.length; i++) {
    const url = candidates[i]!;
    try {
      upstream = await fetch(url, {
        method: params.req.method ?? "POST",
        headers: outboundHeaders,
        body: finalBody,
      });
    } catch (err) {
      lastErr = err;
      upstream = undefined;
      continue;
    }
    // 404 strongly suggests wrong path → try the next candidate. Other status
    // codes (200, 401, 5xx, …) are returned to the caller as-is. 401 in particular
    // is ambiguous (could be wrong key OR wrong path) — retrying would waste
    // an upstream call and could double-charge if the second URL is also auth'd
    // separately, so we don't retry on 401.
    if (upstream.status === 404 && i < candidates.length - 1) {
      log("info", `[adaptive-url] ${provider.id} ${url} → 404; trying ${candidates[i + 1]}`);
      await upstream.body?.cancel().catch(() => undefined);
      upstream = undefined;
      continue;
    }
    break;
  }
  if (!upstream) {
    return {
      ok: false,
      status: 0,
      reply: `Upstream fetch failed: ${lastErr ?? "all URL candidates returned 404"}`,
    };
  }
  return { ok: true, provider, direction, isStream, upstream };
}

// outboundPath is always the canonical "/v1/<verb>" form produced by prepareOutbound
// (e.g. /v1/chat/completions, /v1/messages). The adaptive rule:
//   - originBaseUrl already contains a `/v1` segment → strip /v1 from the verb path,
//     since /v1 is already in the base. Single candidate.
//   - originBaseUrl has NO /v1 → try without /v1 first (some local OpenAI-compatible
//     servers serve verbs at the root), fall back to the legacy "/v1/<verb>" form.
// This is purely additive over the legacy behavior: the legacy URL is always tried,
// just possibly second.
export function buildOutboundCandidates(originBaseUrl: string, outboundPath: string): string[] {
  const base = originBaseUrl.replace(/\/+$/, "");
  const verbWithoutV1 = outboundPath.replace(/^\/v1(?=\/)/, "");
  if (/\/v1(\/|$)/.test(base)) {
    return [`${base}${verbWithoutV1}`];
  }
  return [`${base}${verbWithoutV1}`, `${base}${outboundPath}`];
}

type RunTracker = {
  runId: string;
  agent: AgentId;
  inboundProtocol: Protocol;
  provider: string;
  model: string;
  streamed: boolean;
  failovers: number;
  failoverNote: string | null;
};

async function persistRun(params: {
  tracker: RunTracker;
  startedAt: string;
  durationMs: number;
  usage: Usage;
  httpStatus: number;
  errorMessage: string | null;
}): Promise<void> {
  const { tracker } = params;
  const cost = await computeCost(
    tracker.provider,
    tracker.model,
    params.usage.input,
    params.usage.output,
  );
  try {
    await appendRun({
      runId: tracker.runId,
      agent: tracker.agent,
      startedAt: params.startedAt,
      endedAt: new Date().toISOString(),
      durationMs: params.durationMs,
      status: params.httpStatus >= 200 && params.httpStatus < 400 ? "ok" : "error",
      inboundProtocol: tracker.inboundProtocol,
      outboundProvider: tracker.provider,
      outboundModel: tracker.model,
      inputTokens: params.usage.input,
      outputTokens: params.usage.output,
      cost,
      streamed: tracker.streamed,
      httpStatus: params.httpStatus,
      errorMessage: params.errorMessage,
      failovers: tracker.failovers,
      failoverNote: tracker.failoverNote,
    });
  } catch (err) {
    log("error", `failed to append run ${tracker.runId}: ${err}`);
  }
}

type Direction = "passthrough" | "anthropic-to-openai" | "openai-to-anthropic";

function directionOf(agent: AgentSpec, provider: ProviderSpec): Direction {
  if (agent.protocol === provider.protocol) return "passthrough";
  if (agent.protocol === "anthropic" && provider.protocol === "openai") {
    return "anthropic-to-openai";
  }
  return "openai-to-anthropic";
}

function prepareOutbound(params: {
  direction: Direction;
  inboundBody: string;
  inboundPath: string;
  routeModel: string;
}): { outboundBody: string; outboundPath: string; isStream: boolean } {
  if (params.direction === "anthropic-to-openai") {
    let parsed: any;
    try {
      parsed = JSON.parse(params.inboundBody);
    } catch {
      return { outboundBody: params.inboundBody, outboundPath: "/v1/chat/completions", isStream: false };
    }
    return {
      outboundBody: JSON.stringify(AtoO.translateRequest(parsed, params.routeModel)),
      outboundPath: "/v1/chat/completions",
      isStream: !!parsed.stream,
    };
  }
  if (params.direction === "openai-to-anthropic") {
    let parsed: any;
    try {
      parsed = JSON.parse(params.inboundBody);
    } catch {
      return { outboundBody: params.inboundBody, outboundPath: "/v1/messages", isStream: false };
    }
    return {
      outboundBody: JSON.stringify(OtoA.translateRequest(parsed, params.routeModel)),
      outboundPath: "/v1/messages",
      isStream: !!parsed.stream,
    };
  }
  // passthrough
  const body = rewriteModel(params.inboundBody, params.routeModel);
  let isStream = false;
  try {
    isStream = !!JSON.parse(body || "{}").stream;
  } catch {
    // non-JSON body
  }
  return { outboundBody: body, outboundPath: params.inboundPath, isStream };
}

function buildOutboundHeaders(params: {
  provider: ProviderSpec;
  cred: { type: string };
  req: IncomingMessage;
  secret: string;
}): Record<string, string> {
  const out: Record<string, string> = { "content-type": "application/json" };
  if (params.provider.protocol === "anthropic") {
    if (params.cred.type === "oauth") {
      out.authorization = `Bearer ${params.secret}`;
    } else {
      out["x-api-key"] = params.secret;
    }
    out["anthropic-version"] =
      headerString(params.req.headers["anthropic-version"]) ?? "2023-06-01";
    const beta = headerString(params.req.headers["anthropic-beta"]);
    if (beta) out["anthropic-beta"] = beta;
  } else {
    out.authorization = `Bearer ${params.secret}`;
  }
  return out;
}

type StreamTranslatorLike = { feed: (chunk: Uint8Array) => string; flush: () => string };

async function streamTranslatedResponse(params: {
  upstream: Response;
  res: ServerResponse;
  model: string;
  isStream: boolean;
  contentType: string;
  streamContentType: string;
  translateBody: (body: string, model: string) => string;
  makeStreamTranslator: (model: string) => StreamTranslatorLike;
  errorWrap: (body: string) => string;
  // Hook for run-tracking: receives each streaming chunk OR the full body once for non-streaming.
  onUpstreamRaw?: (chunk: Uint8Array | string) => void;
}): Promise<void> {
  if (!params.upstream.ok || !params.upstream.body) {
    const text = await params.upstream.text();
    params.onUpstreamRaw?.(text);
    params.res.writeHead(params.upstream.status, { "content-type": params.contentType });
    params.res.end(params.errorWrap(text));
    return;
  }
  if (!params.isStream) {
    const text = await params.upstream.text();
    params.onUpstreamRaw?.(text);
    params.res.writeHead(params.upstream.status, { "content-type": params.contentType });
    params.res.end(params.translateBody(text, params.model));
    return;
  }
  params.res.writeHead(params.upstream.status, {
    "content-type": params.streamContentType,
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const translator = params.makeStreamTranslator(params.model);
  const reader = params.upstream.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        params.onUpstreamRaw?.(value);
        const chunk = translator.feed(value);
        if (chunk) params.res.write(chunk);
      }
    }
  } finally {
    const tail = translator.flush();
    if (tail) params.res.write(tail);
    params.res.end();
  }
}

async function streamPassthrough(params: {
  upstream: Response;
  res: ServerResponse;
  onUpstreamRaw?: (chunk: Uint8Array | string) => void;
}): Promise<void> {
  const respHeaders: Record<string, string> = {};
  params.upstream.headers.forEach((value, key) => {
    if (key === "content-encoding" || key === "content-length") return;
    respHeaders[key] = value;
  });
  params.res.writeHead(params.upstream.status, respHeaders);
  if (params.upstream.body) {
    const reader = params.upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        params.onUpstreamRaw?.(value);
        params.res.write(value);
      }
    }
  }
  params.res.end();
}

function toAnthropicError(upstreamBody: string): string {
  try {
    const parsed = JSON.parse(upstreamBody);
    const message = parsed?.error?.message ?? parsed?.message ?? upstreamBody;
    return JSON.stringify({
      type: "error",
      error: { type: "api_error", message },
    });
  } catch {
    return JSON.stringify({
      type: "error",
      error: { type: "api_error", message: upstreamBody },
    });
  }
}

function toOpenAIError(upstreamBody: string): string {
  try {
    const parsed = JSON.parse(upstreamBody);
    const message = parsed?.error?.message ?? parsed?.message ?? upstreamBody;
    const type = parsed?.error?.type ?? "api_error";
    return JSON.stringify({ error: { message, type } });
  } catch {
    return JSON.stringify({ error: { message: upstreamBody, type: "api_error" } });
  }
}

function rewriteModel(body: string, model: string): string {
  if (!body || !model || model === "passthrough") return body;
  try {
    const parsed = JSON.parse(body);
    parsed.model = model;
    return JSON.stringify(parsed);
  } catch {
    return body;
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function headerString(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

function reply(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "text/plain" });
  res.end(`${message}\n`);
}

function log(level: "info" | "error", msg: string): void {
  const line = `${new Date().toISOString()} [${level}] ${msg}\n`;
  process.stdout.write(line);
}
