import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { writeFile } from "node:fs/promises";
import { findByToken } from "../config/agents.js";
import { findCredential, resolveSecret } from "../config/credentials.js";
import { paths } from "../config/paths.js";
import { getRoute } from "../config/routes.js";
import { getAgent } from "../agents/registry.js";
import { getProvider, type ProviderSpec } from "../providers/registry.js";
import type { AgentSpec } from "../agents/types.js";
import * as AtoO from "./translate/anthropic-to-openai.js";
import * as OtoA from "./translate/openai-to-anthropic.js";

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

  const provider = await getProvider(route.provider);
  if (!provider) return reply(res, 503, `Unknown provider ${route.provider}`);

  const cred = await findCredential(provider.id);
  if (!cred) return reply(res, 503, `No credentials for provider ${provider.id}`);

  const secret = resolveSecret(cred);
  if (!secret) return reply(res, 503, `Could not resolve secret for ${provider.id}`);

  const direction = directionOf(agent, provider);

  const inboundBody = await readBody(req);
  const { outboundBody, outboundPath, isStream } = prepareOutbound({
    direction,
    inboundBody,
    inboundPath: req.url ?? "",
    routeModel: route.model,
  });

  const outboundUrl = `${provider.originBaseUrl}${outboundPath}`;
  const outboundHeaders = buildOutboundHeaders({ provider, cred, req, secret });

  log(
    "info",
    `${found.agentId} → ${provider.id}/${route.model} ${direction === "passthrough" ? "(passthrough)" : `(${direction})`} ${req.method} ${req.url} → ${outboundPath}`,
  );

  let upstream: Response;
  try {
    upstream = await fetch(outboundUrl, {
      method: req.method ?? "POST",
      headers: outboundHeaders,
      body: outboundBody,
    });
  } catch (err) {
    return reply(res, 502, `Upstream fetch failed: ${err}`);
  }

  if (direction === "anthropic-to-openai") {
    await streamTranslatedResponse({
      upstream,
      res,
      model: route.model,
      isStream,
      contentType: "application/json",
      streamContentType: "text/event-stream",
      translateBody: OtoA.translateResponseBody,
      makeStreamTranslator: (m) => new OtoA.StreamTranslator(m),
      errorWrap: toAnthropicError,
    });
  } else if (direction === "openai-to-anthropic") {
    await streamTranslatedResponse({
      upstream,
      res,
      model: route.model,
      isStream,
      contentType: "application/json",
      streamContentType: "text/event-stream",
      translateBody: AtoO.translateResponseBody,
      makeStreamTranslator: (m) => new AtoO.StreamTranslator(m),
      errorWrap: toOpenAIError,
    });
  } else {
    await streamPassthrough({ upstream, res });
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
}): Promise<void> {
  if (!params.upstream.ok || !params.upstream.body) {
    const text = await params.upstream.text();
    params.res.writeHead(params.upstream.status, { "content-type": params.contentType });
    params.res.end(params.errorWrap(text));
    return;
  }
  if (!params.isStream) {
    const text = await params.upstream.text();
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
      if (value) params.res.write(value);
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
