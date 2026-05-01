# Changelog

All notable changes to thomas are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.1.1] - 2026-05-01

### Changed

- Renamed npm package from `@openguardrails/thomas` to `@thomas-security/thomas`. Repository moved to `github.com/thomas-security/thomas`. Daemon LaunchAgent / systemd label changed from `com.openguardrails.thomas` to `security.thomas` — users with the daemon installed on 0.1.0 should run `thomas daemon uninstall` before upgrading, then `thomas daemon install` again afterward.

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
