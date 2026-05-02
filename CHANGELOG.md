# Changelog

All notable changes to thomas are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.1.2] - 2026-05-02

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

- Renamed npm package from `@openguardrails/thomas` to `@trustunknown/thomas`. Repository moved to `github.com/trustunknown/thomas`. Daemon LaunchAgent / systemd label changed from `com.openguardrails.thomas` to `security.thomas` — users with the daemon installed on 0.1.0 should run `thomas daemon uninstall` before upgrading, then `thomas daemon install` again afterward.

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
