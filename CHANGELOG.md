# Changelog

All notable changes to thomas are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **JSON output mode** on every read command. Each emits a stable envelope `{ schemaVersion, command, generatedAt, data | error }`; errors carry `{ code, message, remediation?, details? }`. Agents driving thomas can branch on `error.code` without scraping prose. Schema lives in `src/cli/output.ts`, runtime helper in `src/cli/json.ts`.
- **New read commands** for the agent-driving-thomas path: `thomas status`, `thomas runs`, `thomas explain`, `thomas recommend`, `thomas policy`, `thomas prices`. All support `--json`. See SKILL.md for the user-intent → command map.
- **Cost-cascade policy**: `thomas policy set <agent> --primary <prov/model> [--at <usd>=<prov/model>]... [--failover-to <prov/model>]`. Stored in `~/.thomas/policies.json`; the proxy consults it on every request via `src/policy/decide.ts`. Cascade rules trigger on today's cumulative spend (UTC day window). Optional `failoverTo` retries on retryable upstream errors (network / 408 / 429 / 5xx).
- **Per-run cost tracking** via `~/.thomas/runs.jsonl` (append-only). Token counts auto-extracted from upstream responses; `stream_options.include_usage` injected on streaming OpenAI requests so the final SSE chunk carries usage. `RunRecord` aggregates by `X-Thomas-Run-Id` header (or generated UUID).
- **Provider health probes**: `thomas doctor --check` does a `GET /v1/models` (with OPTIONS-on-verb fallback) per credentialed provider and classifies into `ok | wrong_path | auth_failed | models_unavailable | unreachable | other`. Surfaces base-URL misconfigurations early. Same probe also runs in `thomas connect`, attached to the response as `providerProbes[]`.
- **Adaptive proxy URL**: the proxy's outbound URL builder now respects user-typed paths. `originBaseUrl` may include `/v1` (e.g. `https://api.openai.com/v1`) or omit it (legacy). Path-after-`/v1` prefixes (e.g. `https://api.xiangxinai.cn/v1/gateway`) are preserved end-to-end. On 404, falls back to inserting `/v1` once.
- **Stable plugin SDK surface** at `src/sdk/`. Re-exports `AgentSpec` (L1) and a new `TranslatorPair` interface (L2) so out-of-tree adapters / translators can target a stable import path.
- **OpenClaw LaunchAgent plist injection + bootout/bootstrap reload.** `thomas connect openclaw` now writes `THOMAS_OPENCLAW_TOKEN` directly into the LaunchAgent plist's `EnvironmentVariables` dict (`~/Library/LaunchAgents/ai.openclaw.gateway.plist`). Previously the shim-set env var only reached openclaw processes spawned from the user's shell — a launchd-managed gateway daemon could never resolve `${THOMAS_OPENCLAW_TOKEN}` in its config and 401'd every request. The mutation is surgical (only our key, never siblings) and reversible by name on disconnect; no snapshot needed. Paired with this: openclaw's restart hook now uses `launchctl bootout gui/<uid> <plist> && launchctl bootstrap …` on darwin instead of falling through to `openclaw daemon restart` (which uses `launchctl kickstart -k` and does NOT re-read the plist — would respawn the daemon into a stale env dict). Override the plist path with `THOMAS_OPENCLAW_LAUNCHD_PLIST` (tests use this to avoid touching real installations). Linux/Windows: skipped — plist concept doesn't apply there.
- **`--restart-agent` flag** on `thomas connect` and `thomas disconnect`. Optional opt-in that asks the agent to restart its long-running daemon so config edits take effect immediately. Currently effective only for OpenClaw (calls `openclaw daemon restart`, which dispatches platform-specific launchctl/systemctl/schtasks). Shim-env agents (claude-code, codex, hermes) report `attempted: false` since their next process spawn already picks up the new shim. Restart failure does not fail the parent command — `data.restart.ok=false` and a relayable note in `notes[]` instead. New `AgentSpec.restart()` extension point for future agent contributors. Schema: `data.restart: RestartOutcome | null` on both `connect` and `disconnect` envelopes.
- **`thomas cloud` subcommand** (login / whoami / sync / logout) for the optional [thomas-cloud](https://github.com/trustunknown/thomas-cloud) SaaS. Device-code grant; token persisted at `~/.thomas/cloud.json`. `thomas cloud sync` writes the policy / bundle / binding / provider snapshot to `~/.thomas/cloud-cache.json` — the proxy now reads policies from there ahead of the local store, so a centrally-managed policy supersedes a local one once the user logs in. Offline / not-logged-in users keep the existing local-only behavior.

### Changed

- **License: AGPL-3.0 → Apache-2.0.** L1 / L2 adapters benefit more from a permissive license (community contributions, closed-source agent integrations on top); commercial value moves to the separately-licensed thomas-cloud SaaS. See README.md "License" section for rationale.
- `thomas connect` now **rolls back atomically** when `~/.thomas/bin` isn't ahead of the original binary on `$PATH`. Previously a connect could succeed (config patched, shim written) while the shim never ran (PATH wrong), leading to silent token-resolution failures on the next request. New error code `E_SHIM_NOT_ON_PATH` with the exact `export PATH=...` line for the user's shell rc. Reverts shim, config snapshot, and recorded connection.
- `extractCredentials` and `thomas providers register` no longer strip `/v1` from the user's `originBaseUrl`. The proxy's adaptive URL builder handles `/v1` insertion at request time. Existing custom providers registered before this change still work.

### Fixed

- **vllm / xiangxinai 401** when `originBaseUrl` ended at the bare host. The old extraction regex greedily ate path segments after `/v1`, so a baseUrl like `https://api.xiangxinai.cn/v1/gateway` collapsed to `https://api.xiangxinai.cn` and the proxy posted to `https://api.xiangxinai.cn/v1/chat/completions` instead of `.../gateway/chat/completions`. Now the user-typed URL is preserved end-to-end.

## [8.0.0] - 2026-05-02

### Added

- **OpenClaw config-mode connect**: `thomas connect openclaw` now actually routes openclaw through thomas. Previous releases set `OPENAI_BASE_URL` in the shim, but openclaw doesn't read that env var — connect was a no-op for routing. The new flow patches `~/.openclaw/openclaw.json` additively (adds `models.providers.thomas` and switches `agents.defaults.model.primary` to `thomas/auto`), records a snapshot at `~/.thomas/snapshots/openclaw.json`, and `thomas disconnect openclaw` restores the prior state. The bearer token stays out of openclaw.json — the config references env var `THOMAS_OPENCLAW_TOKEN` which the shim sets.
- **Hermes full provider catalog**: `extractCredentials` now recognizes ~30 native hermes providers (xai, zai, gemini, copilot, alibaba, stepfun, minimax, lmstudio, kimi-coding, opencode-zen, kilocode, vercel ai-gateway, and more) instead of only the six built-ins. Non-built-in providers also auto-register a `ProviderSpec` so they're routable immediately with `thomas route hermes <provider/model>`.
- `bun run sync:providers` — drift detector that compares `src/providers/agents/hermes.generated.ts` against `references/hermes-agent/hermes_cli/auth.py` and prints additions / removals when upstream evolves. Reports the upstream openclaw provider catalog informationally.
- **Snapshot infrastructure**: `~/.thomas/snapshots/` directory + `src/config/snapshots.ts` helpers. Used by config-mode agents (currently openclaw); future config-mode agents share the same store.
- `ExtractedCredential` type pairs a `Credential` with an optional `ProviderSpec` so agents can surface user-specific endpoints (openclaw's vllm baseUrl, hermes's custom providers) without manual `thomas providers register`.

### Changed

- `AgentSpec.shimEnv` is now `Record<string, string>` with `${THOMAS_URL}` / `${THOMAS_TOKEN}` template tokens, replacing the fixed `{ baseUrl, apiKey }` pair. Lets hermes set its three-var combo (`HERMES_INFERENCE_PROVIDER` + `OPENROUTER_API_KEY` + `OPENROUTER_BASE_URL`) and openclaw set just `THOMAS_OPENCLAW_TOKEN`.
- `AgentSpec.baseUrlPath` removed; each agent encodes the path in its `shimEnv` value (e.g., `OPENAI_BASE_URL: "${THOMAS_URL}/v1"`).
- `AgentSpec.extractCredentials` returns `ExtractedCredential[]` instead of `Credential[]`.

### Fixed

- `thomas connect openclaw` no longer silently fails to route. Previously it set env vars openclaw ignored and the agent kept using whatever provider its config pointed at.

## [0.1.1] - 2026-05-01

### Changed

- Renamed npm package from `@openguardrails/thomas` to `@trustunknown/thomas`. Repository moved to `github.com/trustunknown/thomas`. Daemon LaunchAgent / systemd label changed from `com.openguardrails.thomas` to `com.trustunknown.thomas` — users with the daemon installed on 0.1.0 should run `thomas daemon uninstall` before upgrading, then `thomas daemon install` again afterward.

## [0.1.0] - 2026-04-30

### Added

- `thomas doctor` — discover installed AI agents (claude-code, codex, openclaw, hermes-agent), their config files, credential sources, and skill directories
- `thomas connect <agent>` / `thomas disconnect <agent>` — install or remove a transparent PATH shim that routes the agent through thomas's local proxy. Original agent config is left untouched; uninstalling thomas restores the agent's original behavior automatically
- `thomas route <agent> <provider/model>` — switch an agent's target model
- `thomas list` — current state: connected agents, configured providers, routes, proxy status, daemon supervision
- `thomas providers` — list / add / remove credentials and register custom OpenAI-compatible or Anthropic-compatible endpoints
- `thomas daemon install|uninstall|status` — supervise the proxy via macOS LaunchAgent or Linux systemd user service (Windows scheduled task stubbed)
- `thomas skill install|remove <agent>` — install the thomas skill so an AI agent can drive thomas autonomously (claude-code only in this release)
- Cross-protocol translation between Anthropic `/v1/messages` and OpenAI `/v1/chat/completions`, including streaming SSE
- Built-in OpenAI-compatible providers: openai, openrouter, kimi, deepseek, groq; Anthropic provider: anthropic
- Test suite: 36 tests across translator, hermes credential extraction, provider registry, and daemon file rendering
