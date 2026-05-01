# CLAUDE.md

Engineering notes for working in this repo. Telegraph style. README.md is for users; this file is for whoever (human or agent) is editing the source.

## Product

Thomas is the universal adapter between AI agents and model providers. It connects any agent on the host (Claude Code, Codex, OpenClaw, Hermes Agent) to any provider (Anthropic, OpenAI, OpenRouter, Kimi, DeepSeek, Groq, custom OpenAI/Anthropic-compatible endpoints) — automatically, with cross-protocol translation, without editing the agent's own config.

Audience: individuals, developers, solo / small teams. Not enterprise.

License: AGPL-3.0-only (open core). Security/governance features (planned, see Roadmap) will ship as a commercial add-on.

Roadmap order: **connect → control → optimize → protect.** v0.1.0 covers connect + route + cross-protocol translation. Quotas, fallback, cost-aware routing, prompt-injection/PII/secret detection are subsequent.

## Architecture (load-bearing)

**Non-invasive shim model.** `thomas connect <agent>` writes a wrapper at `~/.thomas/bin/<binary>` that fronts the real binary on PATH. The wrapper sets `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` and a thomas-issued token, then `exec`s the real binary. Original agent config is never touched. Uninstall thomas → shim disappears → agent reverts. **Any approach that mutates `~/.claude/settings.json`, `~/.codex/auth.json`, etc. is wrong** — that is what cc-switch and claude-code-router do, and is the bug class thomas is designed to avoid.

**Single local proxy** (default port 51168, configurable). Listens on `/v1/messages` and `/v1/chat/completions`. Inbound auth is the thomas-issued token in the request header; the proxy looks up caller agent → route → provider creds → swaps auth → forwards.

**Cross-protocol translation** at `src/proxy/translate/`. Both directions implemented: anthropic-to-openai and openai-to-anthropic, request bodies, non-streaming responses, and stateful SSE stream translators. Streaming maps OpenAI `delta.content` / `delta.tool_calls` chunks ↔ Anthropic `content_block_start` / `content_block_delta` / `content_block_stop` events.

**Daemon supervision** mirrors openclaw's `GatewayService` pattern (see `references/openclaw/src/daemon/service.ts` if you need to extend). macOS LaunchAgent + Linux systemd user service implemented; Windows Scheduled Task is stubbed. When a service is installed, `proxy ensure` defers to it instead of spawning detached.

## File map

```
src/
  cli.ts                       Command dispatcher (parseArgs)
  agents/                      Per-agent specs
    types.ts                   AgentSpec interface, AgentId union
    registry.ts                Lookup by id
    detect-helpers.ts          which / file-exists / macOS keychain helpers
    dotenv.ts                  Minimal dotenv parser (used by hermes)
    {claude-code,codex,openclaw,hermes}.ts
  providers/registry.ts        BUILTIN map + custom-provider persistence (~/.thomas/providers.json)
  proxy/
    server.ts                  HTTP listener; auth + route + translate dispatch
    translate/
      types.ts                 Anthropic / OpenAI request + response shapes
      anthropic-to-openai.ts   translateRequest + translateResponseBody + StreamTranslator
      openai-to-anthropic.ts   translateRequest + translateResponseBody + StreamTranslator
  shim/
    install.ts                 Generate + write shim files under ~/.thomas/bin/
    templates.ts               Inlined sh + cmd templates (must be inlined; bun build does not bundle non-imported files)
    quote.ts                   Shell quoting + thomas-invocation resolution
  daemon/
    service.ts                 Cross-platform Service interface + factory
    constants.ts               LABEL = "security.thomas"
    launchd.ts                 macOS LaunchAgent + exported renderPlist
    systemd.ts                 Linux systemd user service + exported renderSystemdUnit
    scheduled-task.ts          Windows stub
    lifecycle.ts               PID/health-based proxy lifecycle; defers to Service when installed
  config/
    paths.ts                   ~/.thomas/* getters (env-overridable via THOMAS_HOME)
    config.ts                  port, host
    credentials.ts             SecretRef + Credential schema (matches openclaw's auth-profiles)
    routes.ts                  agent → provider/model
    agents.ts                  connected agents + thomas tokens
    io.ts                      Atomic JSON read/write with mode 0600
  commands/                    One file per top-level CLI verb
SKILL.md                       Skill bundle root for AI agents that drive thomas
skill/                         (reserved) reference docs accompanying SKILL.md
tests/                         bun:test; bunfig.toml scopes to this dir
```

## Conventions

- TS strict (`strict: true`, `noUncheckedIndexedAccess: true`), ESM, Node 20+ runtime.
- Imports use `node:` prefix for built-ins. **No external runtime deps**; only `node:` modules + `fetch` (Node 20+).
- `paths` is a getter object — env (`THOMAS_HOME`) is read at access time so tests can swap per-test.
- Each agent module exports an `AgentSpec` with `detect()` and optional `extractCredentials()`. Adding a fifth agent: drop in `src/agents/<id>.ts`, register in `src/agents/registry.ts`, add to the `AgentId` union.
- Adding a built-in provider: append entry to `BUILTIN` in `src/providers/registry.ts`. User-specific providers go via `thomas providers register`, persisted at `~/.thomas/providers.json`.
- Daemon service interface follows openclaw's `GatewayService` shape (`label`, `install`, `uninstall`, `status`, `start`, `stop`). Don't add per-platform branches outside `daemon/{launchd,systemd,scheduled-task}.ts`.
- Comments: only the non-obvious why. Don't restate the code. No multi-line block comments.

## Gotchas

- **Claude Code OAuth tokens do not work for direct Anthropic API.** They are scoped to claude.ai endpoints and rejected by `/v1/messages` with `"OAuth authentication is currently not supported."` `thomas connect claude-code` imports the OAuth as a labeled credential, but actual passthrough to Anthropic requires a `sk-ant-` API key. The connect command warns the user about this. Do not regress the warning.
- **macOS keychain account name varies.** For service `Claude Code-credentials`, the account is the local username (e.g. `tom`), not the literal `"Claude Code"` that openclaw's source suggests. `macKeychainFind()` looks up by service only and returns the actual account.
- **`bun build --target=node` does not bundle non-imported files.** That bit shim templates once (they were external `template.sh` / `.cmd` files; loading them at runtime broke after bundling). They are now inlined as TS strings in `src/shim/templates.ts`. Same trap applies to anything else that does runtime `readFile` of project assets — only SKILL.md is currently safe because `skillInstall` walks up to the package root and SKILL.md is in `package.json#files`.
- **Tests must scope to `tests/`.** `bunfig.toml` sets `[test] root = "tests"` because `bun test` from project root would pick up `references/*/test.ts` files (other people's projects we vendored for inspiration).
- **`references/` is in `.gitignore`** — never commit those vendored repos.

## Commands

```sh
bun install
bun run dev      # bun src/cli.ts <args>     — fast iteration
bun run build    # bun build → dist/cli.js   — single-file Node bundle, ~80 KB
bun test         # bun test → tests/*.test.ts  (36 tests, ~100ms)
bunx tsc --noEmit
npm pack         # produce installable tarball; verify with `tar tzf …`
node dist/cli.js doctor   # smoke-test the bundle without `bun`
```

## Test data

- Tests use `mkdtemp` + `THOMAS_HOME` / `HERMES_HOME` env overrides for isolation.
- Daemon tests cover **rendering only** (`renderPlist`, `renderSystemdUnit`); we do not invoke `launchctl` / `systemctl` from tests.
- Integration tests against real provider endpoints are out-of-band; require user-supplied keys.

## CI

- `.github/workflows/ci.yml` — push/PR, ubuntu+macos matrix: typecheck → test → build → smoke.
- `.github/workflows/publish.yml` — tag `v*` triggered, verifies tag matches `package.json` version, then `npm publish --provenance`. Requires `NPM_TOKEN` repo secret.

Bump `version` in `package.json`, update `CHANGELOG.md`, then `git tag v<version> && git push --tags`.
