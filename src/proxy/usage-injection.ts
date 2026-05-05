// When forwarding a streaming request to an OpenAI-protocol upstream, inject
// `stream_options.include_usage = true` so the final SSE chunk carries token
// counts. Many SDK clients omit this flag and thomas can't compute cost
// otherwise. We respect explicit user opinion: if include_usage is already
// set (true OR false), we leave it alone.

export function ensureOpenAIIncludeUsage(body: string): string {
  if (!body) return body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  if (typeof parsed !== "object" || parsed === null) return body;
  const obj = parsed as Record<string, unknown>;
  if (obj.stream !== true) return body;
  const opts =
    typeof obj.stream_options === "object" && obj.stream_options !== null
      ? (obj.stream_options as Record<string, unknown>)
      : {};
  if ("include_usage" in opts) return body;
  obj.stream_options = { ...opts, include_usage: true };
  return JSON.stringify(obj);
}
