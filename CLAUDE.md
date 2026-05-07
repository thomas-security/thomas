# CLAUDE.md

Engineering notes for working in this repo. Telegraph style. README.md is for users; this file is for whoever (human or agent) is editing the source.

## Product

Thomas is the universal adapter between **autonomous AI agents** and model providers. It connects any agent running on a single user's host (Claude Code, Codex, OpenClaw, Hermes Agent) to any provider (Anthropic, OpenAI, OpenRouter, Kimi, DeepSeek, Groq, custom OpenAI/Anthropic-compatible endpoints) — automatically, with cross-protocol translation, without editing the agent's own config.

**Audience and scope.** Thomas is for **personal / solo developers** running autonomous AI agents on their own machine. It is deliberately single-user. Team collaboration, multi-tenancy, shared admin, central observability, enterprise SSO/RBAC are **explicit non-goals** — those concerns belong to separate products built on top of thomas, not features added inside it. PRs that drag thomas toward team/enterprise scope should be redirected to the appropriate sibling project, not merged here.

License: Apache-2.0.

Roadmap order: **connect → control → optimize → protect.** v0.1.0 covers connect + route + cross-protocol translation. Per-agent-run cost tracking, cost cascade (e.g. Opus until $X, then Haiku), in-run model failover come next (control + optimize). Prompt-injection / PII / secret detection are later (protect). All in single-user scope.

## Operating model (the user's own agent is the primary operator)

The user usually interacts with thomas **through their own AI agent** (Claude Code, Codex, OpenClaw, hermes, …), not by typing `thomas` at a terminal. Real questions look like:

- "Which model is each agent on this machine using right now?" (dashboard)
- "Configure thomas so openclaw falls back to DeepSeek when I'm over $5/day." (writes through the agent)
- "What's a good model combination for hermes given my budget?" (recommendation)
- "Why did my last claude-code run cost $2?" (explain)

The agent shells out to `thomas` to answer or act. Direct human-at-terminal use exists, but is the secondary case. Every CLI design decision must serve the agent-as-operator path first.

**Consequences — every command is dual-audience:**

- **Read commands MUST support `--json`** with a stable, documented output schema. Default text output is for humans; JSON is the contract for agents. No agent should have to grep human-formatted text. Applies to `doctor`, `list`, `providers`, `daemon status`, `proxy status`, and any future `status` / `runs` / `explain` / `recommend` commands.
- **Read commands explain, don't just dump.** A status response must include what each connected agent is *currently effectively using* (after route + cascade), recent activity, spend, errors. The calling agent needs enough material to answer the user in one shot — don't make it stitch together three commands.
- **Write commands idempotent + reversible.** Agents retry, abort halfway, second-guess. `connect`, `route`, `providers add`, future `policy enable` must be safe to call twice and easy to undo. Snapshot-and-revert (already in config-mode connect) extends to all state-changing commands.
- **Errors return structured codes** in `--json` mode: `{ "error": { "code": "E_PROVIDER_AUTH", "message": "...", "remediation": "..." } }`. The agent either recovers (different args) or relays the remediation verbatim.
- **SKILL.md is a load-bearing contract**, not docs. It maps user-intent phrases → commands → JSON interpretation. Every command-surface change updates SKILL.md in the same PR. The skill must cover at least: dashboard ("what's using what"), configure ("make agent X use provider Y"), recommend ("good combination for agent X under $N/day"), explain ("why did this cost / fail").

**Current gap.** No command takes `--json` yet; SKILL.md covers connect/route/disconnect but not dashboard/recommend/explain. Closing this is a near-term task: agree the JSON schemas first (one design pass), then retrofit existing commands and extend SKILL.md.

## Architecture (load-bearing)

**Two connect modes, by agent capability.** `AgentSpec` declares `shimEnv` (env vars the shim sets) and/or `applyConfig`/`revertConfig` (config-file mutation with snapshot). The connect command runs whichever the spec defines.

- **shim-env (preferred)**: agents that respect `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` / per-provider `*_BASE_URL` env vars (claude-code, codex, hermes). `thomas connect` writes a wrapper at `~/.thomas/bin/<binary>` earlier on PATH than the real binary; the wrapper exports the env block and `exec`s the real binary. Original agent config is **never touched**. Uninstall thomas → shim disappears → agent reverts.
- **config-mode (only when forced)**: agents that don't read base-URL env vars and resolve providers exclusively through their own config file (openclaw is the current case). `applyConfig` mutates the agent's config but must be **strictly additive** (preserve existing user data) and **fully reversible**: it returns an `AgentSnapshot` persisted at `~/.thomas/snapshots/<agent>.json` capturing the prior values it overwrote. `thomas disconnect` reads the snapshot and calls `revertConfig` to restore. Config-mode agents can also have `shimEnv` so their config can reference an env-var-injected token (e.g., openclaw config sets `apiKey: "THOMAS_OPENCLAW_TOKEN"`, shim sets that env var) — keeps the bearer token out of the on-disk config.

**The cc-switch trap to avoid.** cc-switch claims "non-invasive" but does the opposite: it directly overwrites agent configs with no backup and no auto-restore on uninstall. Don't replicate that. Config-mode mutations in thomas MUST satisfy: (a) additive (don't wipe sibling entries); (b) snapshotted (`AgentSnapshot` captures prior state); (c) reversible (`revertConfig` restores cleanly); (d) self-describing if the user nukes `~/.thomas/` — the openclaw config keeps an env-var reference rather than a literal token, so worst case the user gets a dead provider entry they can delete with `jq`, not a stolen token.

**Single local proxy** (default port 51168, configurable). Listens on `/v1/messages` and `/v1/chat/completions`. Inbound auth is the thomas-issued token in the request header; the proxy looks up caller agent → route → provider creds → swaps auth → forwards.

**Cross-protocol translation** at `src/proxy/translate/`. Both directions implemented: anthropic-to-openai and openai-to-anthropic, request bodies, non-streaming responses, and stateful SSE stream translators. Streaming maps OpenAI `delta.content` / `delta.tool_calls` chunks ↔ Anthropic `content_block_start` / `content_block_delta` / `content_block_stop` events.

**Daemon supervision** mirrors openclaw's `GatewayService` pattern (see `references/openclaw/src/daemon/service.ts` if you need to extend). macOS LaunchAgent + Linux systemd user service implemented; Windows Scheduled Task is stubbed. When a service is installed, `proxy start` defers to it instead of spawning detached.

## Extension layers (contribution surfaces)

Three layers are deliberately pluggable so the surfaces that change fastest — agents, model protocols, strategies — can grow without touching core. A contribution should target exactly one. Each layer has a defined schema; if a PR can't fit one of these layers, it probably doesn't belong in thomas.

### L1 — Agent adapter (`src/agents/`)

Detect a local agent, optionally extract its provider creds, redirect its model traffic to thomas (shim-env preferred, config-mode only when forced), revert cleanly on disconnect. Today: claude-code, codex, openclaw, hermes.

**Contract.** `AgentSpec` in `src/agents/types.ts` — required: `id`, `detect()`. Optional: `extractCredentials()`, `shimEnv`, `applyConfig`/`revertConfig`, `restart()`. Pick shim-env if the agent reads `*_BASE_URL`; pick config-mode only when forced (see openclaw rationale + cc-switch trap above). Config-mode mutations MUST be additive, snapshotted, and reversible. Implement `restart()` only for agents whose long-running daemon caches config in memory (e.g. openclaw's `GatewayService`) — and always go through the agent's own canonical restart API (`<agent> daemon restart` or equivalent), never raw `kill`/`launchctl`. thomas does not own the agent's process tree.

**Adding one.** New file `src/agents/<id>.ts` → register in `src/agents/registry.ts` → extend the `AgentId` union → `tests/<id>.test.ts`. CI runs `detect()` on macOS + Linux.

### L2 — Protocol adapter (`src/proxy/translate/`)

Translate request bodies, non-streaming responses, and stateful streaming SSE events between two model protocols. Today: Anthropic Messages ↔ OpenAI Chat, both directions.

**When to add.** A new model protocol appears (Gemini, Cohere, OpenAI Responses) or an existing protocol grows fields that matter (thinking blocks, cache breakpoints, tool-result media).

**Contract.** Per pair of protocols, a module exposing `translateRequest(body)`, `translateResponseBody(body)`, and a `StreamTranslator` class doing stateful chunk-by-chunk SSE conversion. Translators register pairwise; the proxy resolves `inbound→outbound` at request time.

**Invariants.** Round-trip idempotent for understood fields; lossless OR explicit drop (documented in module header) for unknowns. No cross-request state.

### L3 — Strategy / policy (planned, `src/policy/`)

Per-agent cost cascade ("Opus until $X, then Haiku"), in-run model failover (continue a run on a different provider when the current one errors mid-stream), per-agent-run budget tracking, task-conditional routing. Strictly single-user — no cross-user RBAC, no shared quotas, no central admin.

**Why pluggable.** Strategies encode user preferences that vary widely (cost vs. quality, conservative vs. aggressive failover, different cascades per agent). Core ships sane defaults; community contributes alternatives.

**Layout.** Each policy is a self-contained directory `src/policy/<id>/` with:
- `manifest.json` — `{ id, version, description, inputs?: JSONSchema, defaults?: object }`. Lets thomas list/inspect installed policies without loading their code.
- `index.ts` — default export implements `PolicySpec` (interface below).
- `<id>.test.ts` — unit tests against fixtures of `decide()` inputs.

Policies are auto-discovered at startup by walking `src/policy/*/manifest.json`; no central registry edits needed when adding one. Users select active policy + per-policy config in `~/.thomas/policies.json`.

**Contract sketch** (will firm up before first L3 release):

```ts
interface PolicySpec {
  id: string;
  decide(ctx: {
    agent: AgentId;
    runId: string;                              // a single agent task spans many model calls
    spend: { run: number; day: number; month: number };
    request: { protocol: ProtocolId; body: unknown };
  }): Promise<{
    target: { provider: ProviderId; model: string };
    onError?: 'fallback' | 'retry' | 'abort';
    annotateRun?: Record<string, unknown>;       // arbitrary tags on the run record
  }>;
}
```

Until L3 lands, route selection is the static one-route-per-agent in `src/config/routes.ts`.

### What does NOT belong in any layer

- Multi-user features: team workspaces, shared keys, RBAC, audit trails for compliance.
- Centralized observability: log shipping to SaaS, dashboards, alerting.
- Enterprise auth: SSO, SCIM, OIDC for human users.
- Anything that assumes more than one user per thomas install.

These are out of scope by design (see Audience above). Redirect the PR.

## File map

```
src/
  cli.ts                       Command dispatcher (parseArgs)
  agents/                      Per-agent specs
    types.ts                   AgentSpec interface, AgentId union
    registry.ts                Lookup by id
    detect-helpers.ts          which / file-exists / macOS keychain helpers
    dotenv.ts                  Minimal dotenv parser (used by hermes)
    restart.ts                 runRestartCommand() — shared spawn+capture for AgentSpec.restart()
    openclaw-plist.ts          Surgical add/remove THOMAS_OPENCLAW_TOKEN in the macOS LaunchAgent plist
    {claude-code,codex,openclaw,hermes}.ts
  providers/registry.ts        BUILTIN map + custom-provider persistence (~/.thomas/providers.json)
  proxy/
    server.ts                  HTTP listener; auth + route + translate dispatch
    translate/
      types.ts                 Anthropic / OpenAI request + response shapes
      anthropic-to-openai.ts   translateRequest + translateResponseBody + StreamTranslator
      openai-to-anthropic.ts   translateRequest + translateResponseBody + StreamTranslator
  shim/
    install.ts                 Generate + write shim files under ~/.thomas/bin/; renderEnvBlock() exported for tests
    templates.ts               Inlined sh + cmd templates (must be inlined; bun build does not bundle non-imported files)
    quote.ts                   Shell quoting + thomas-invocation resolution
  providers/
    registry.ts                BUILTIN map + custom-provider persistence (~/.thomas/providers.json)
    agents/
      hermes.generated.ts      Mirror of hermes_cli/auth.py PROVIDER_REGISTRY. Regenerate-by-hand;
                               `bun run sync:providers` is the drift detector that flags upstream changes.
  runs/
    types.ts                   RunRecord (internal, persisted in runs.jsonl)
    pricing.ts                 ModelMeta (provider/model/protocol/price/tier) + async computeCost (overlay → builtin → null) + listAllPrices
    prices-store.ts            ~/.thomas/prices.json overlay; readOverlay / setOverlayPrice / removeOverlayPrice
    usage.ts                   extractUsageFromBody + StreamUsageWatcher (per-protocol token capture)
    store.ts                   appendRun / readRuns / findRun / findRecordsForRun; ~/.thomas/runs.jsonl, append-only
    aggregate.ts               aggregateRecords — collapse RunRecord[] sharing a runId into AggregatedRun (X-Thomas-Run-Id header)
    analytics.ts               agentHistory(agentId, windowDays) — token totals + per-day averages
  policy/
    types.ts                   PolicyConfig (cost-cascade, optional failoverTo) + PoliciesStore + PolicyDecision
    store.ts                   readPolicies / setPolicy / clearPolicy; ~/.thomas/policies.json
    decide.ts                  Pure decide() + spendSinceStartOfDay (UTC day window)
    failover.ts                isRetryableStatus + shouldFailover (pure; tested in failover.test.ts)
    recommender.ts             Heuristic: history + budget + preference → ranked Suggestion[]
  commands/explain.ts          Narrative + facts for a run or an agent (read-only synthesis)
  commands/recommend.ts        Output suggestions with applyCommand strings the agent can exec
  daemon/
    service.ts                 Cross-platform Service interface + factory
    constants.ts               LABEL = "com.trustunknown.thomas"
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
    snapshots.ts               Per-agent config-mode snapshots (~/.thomas/snapshots/<agent>.json)
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
- Each agent module exports an `AgentSpec` with `detect()` and optional `extractCredentials()` / `shimEnv` / `applyConfig` / `revertConfig`. Adding a fifth agent: drop in `src/agents/<id>.ts`, register in `src/agents/registry.ts`, add to the `AgentId` union. Pick shim-env or config-mode based on whether the agent reads `*_BASE_URL` env vars.
- `shimEnv` values may use `${THOMAS_URL}` and `${THOMAS_TOKEN}` template tokens, resolved at install time. `extractCredentials` returns `ExtractedCredential[]` — pair a `Credential` with an optional `ProviderSpec` so connect can auto-register custom endpoints (e.g., the user's vllm baseUrl).
- Adding a built-in provider: append entry to `BUILTIN` in `src/providers/registry.ts`. User-specific providers come in automatically when extracted from an agent (with `provider` attached on the `ExtractedCredential`), or via `thomas providers register`, persisted at `~/.thomas/providers.json`.
- Hermes provider list lives in `src/providers/agents/hermes.generated.ts`. When upstream hermes adds/renames a provider, run `bun run sync:providers` to detect drift, then update by hand. Source of truth is hermes's `auth.py` `PROVIDER_REGISTRY` (canonical IDs and env aliases); `providers.py` `HERMES_OVERLAYS` uses display-layer renames that are aliases, not creds.
- thomas-cloud wire types live in `src/cloud/openapi-types.ts`, generated from `src/cloud/openapi.json` (also checked in). When you change an `apps/api/app/schemas/*.py` Pydantic model in thomas-cloud, regenerate from a running server: `bun run gen:types` (defaults to `http://localhost:8000`, override with `THOMAS_CLOUD_BASE_URL`). The script writes the spec + the TS atomically; commit both. Importers (`src/cloud/policy-bridge.ts`, `src/cloud/runs-uplink.ts`) use the `Schema*` aliases — never hand-edit `openapi-types.ts`. Unlike `sync:providers` (drift detector only), `gen:types` *is* the source of truth for the wire — a stale `openapi-types.ts` means the client won't typecheck against the actual server contract.
- Daemon service interface follows openclaw's `GatewayService` shape (`label`, `install`, `uninstall`, `status`, `start`, `stop`). Don't add per-platform branches outside `daemon/{launchd,systemd,scheduled-task}.ts`.
- **JSON output is the agent contract.** Every read command takes `--json` and emits a stable, documented schema. Adding a read command without `--json` is incomplete. Schema changes are breaking changes — bump the schema's `version` field and update SKILL.md.
- **SKILL.md updates ride alongside command changes.** New command, renamed flag, changed JSON shape → SKILL.md updated in the same PR. The skill is how agents drive thomas; out-of-date skill = silently broken UX for users who never touch the terminal.
- Comments: only the non-obvious why. Don't restate the code. No multi-line block comments.

## Gotchas

- **OpenClaw caches its config in the GatewayService daemon** — editing `~/.openclaw/openclaw.json` does not retroactively affect a daemon that started before the edit. After `connect openclaw` / `disconnect openclaw`, the daemon must reload. `--restart-agent` runs `openclaw daemon restart` for you (which is platform-aware: launchctl kickstart on macOS, systemctl --user on Linux). Without the flag, the user must restart manually or accept that connect's effect is delayed until next daemon spawn.
- **launchd does not inherit shell env, so the openclaw shim alone is insufficient.** When openclaw runs as a LaunchAgent (`ai.openclaw.gateway.plist` — the default install on macOS), the shim's `THOMAS_OPENCLAW_TOKEN` never reaches the daemon. The patched config's `apiKey: "${THOMAS_OPENCLAW_TOKEN}"` then fails to resolve and openclaw 401s every request. `applyConfig` therefore writes the token directly into the plist's `EnvironmentVariables` dict via `src/agents/openclaw-plist.ts` (round-trips through `plutil -convert json/xml1` so the on-disk format stays canonical). The mutation is **single-key surgical**: we set exactly `EnvironmentVariables.THOMAS_OPENCLAW_TOKEN` and never touch sibling entries; on `revertConfig` we drop just our key (and the dict if it ends up empty). No plist snapshot is needed because the operation is idempotent and reversible by name. **Important:** unlike `~/.openclaw/openclaw.json` snapshots, plist mutations don't roll back if the user nukes `~/.thomas/`. That's intentional and OK — the worst outcome is a leftover `THOMAS_OPENCLAW_TOKEN` env var that's a dead string once the JSON config no longer references it. The user can `launchctl unload && plutil -remove EnvironmentVariables.THOMAS_OPENCLAW_TOKEN <plist>` if they care. Override the plist path with `THOMAS_OPENCLAW_LAUNCHD_PLIST` (used by tests so they never touch a contributor's real install).
- **`launchctl kickstart -k` does not re-read the plist.** openclaw's own `daemon restart` CLI uses kickstart, which only respawns the daemon process — launchd keeps the previously-loaded `EnvironmentVariables` dict in memory. Right after connect mutates the plist, kickstart would respawn the daemon into the OLD env (no `THOMAS_OPENCLAW_TOKEN`), and KeepAlive would loop because of the failed startup. So `openclaw`'s `AgentSpec.restart()` skips kickstart on darwin and runs `launchctl bootout gui/<uid> <plist> && launchctl bootstrap gui/<uid> <plist>` directly — that's the only macOS launchctl verb pair that forces a plist re-read before the daemon comes back up. Empirically takes ~150ms vs the 30-60s timeouts of repeated `kickstart -k` against an unhealthy daemon.
- **OpenClaw doesn't read `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL`.** It resolves providers exclusively through `~/.openclaw/openclaw.json` (`models.providers.<id>.baseUrl` + `agents.defaults.model.primary`). That's why openclaw is the only config-mode agent. The connect flow adds `models.providers.thomas` with `apiKey: "${THOMAS_OPENCLAW_TOKEN}"` (the `${VAR}` template form — openclaw's `parseEnvTemplateSecretRef` recognizes it and resolves from `process.env` at request time; a bare `"THOMAS_OPENCLAW_TOKEN"` string would be sent literally as the bearer, since openclaw only auto-resolves a whitelist of built-in provider env names via `isKnownEnvApiKeyMarker`). It also adds an entry under `agents.defaults.models["thomas/auto"]` and switches `agents.defaults.model.primary` to `thomas/auto`. `applyConfig` snapshots the prior values; `revertConfig` reads the snapshot and restores. The shim sets `THOMAS_OPENCLAW_TOKEN` so the bearer never touches disk.
- **Claude Code OAuth tokens do not work for direct Anthropic API.** They are scoped to claude.ai endpoints and rejected by `/v1/messages` with `"OAuth authentication is currently not supported."` `thomas connect claude-code` imports the OAuth as a labeled credential, but actual passthrough to Anthropic requires a `sk-ant-` API key. The connect command warns the user about this. Do not regress the warning.
- **macOS keychain account name varies.** For service `Claude Code-credentials`, the account is the local username (e.g. `tom`), not the literal `"Claude Code"` that openclaw's source suggests. `macKeychainFind()` looks up by service only and returns the actual account.
- **`bun build --target=node` does not bundle non-imported files.** That bit shim templates once (they were external `template.sh` / `.cmd` files; loading them at runtime broke after bundling). They are now inlined as TS strings in `src/shim/templates.ts`. Same trap applies to anything else that does runtime `readFile` of project assets — only SKILL.md is currently safe because `skillInstall` walks up to the package root and SKILL.md is in `package.json#files`.
- **Tests must scope to `tests/`.** `bunfig.toml` sets `[test] root = "tests"` because `bun test` from project root would pick up `references/*/test.ts` files (other people's projects we vendored for inspiration).
- **`references/` is in `.gitignore`** — never commit those vendored repos.

## Commands

```sh
bun install
bun run dev          # bun src/cli.ts <args>     — fast iteration
bun run build        # bun build → dist/cli.js   — single-file Node bundle, ~80 KB
bun test             # bun test → tests/*.test.ts  (36 tests, ~100ms)
bunx tsc --noEmit
bun run gen:types    # regen src/cloud/openapi-types.ts from running thomas-cloud
bun run sync:providers  # drift-check src/providers/agents/hermes.generated.ts
npm pack             # produce installable tarball; verify with `tar tzf …`
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
