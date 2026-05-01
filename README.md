# Thomas

> **Use any model with any AI agent — safely.**
>
> Thomas is the plug-and-play model hub that connects your agents to your models, with security guardrails, quotas, fallback, and cost controls.

---

## What it does

Thomas is the universal adapter between AI agents and model providers. Install it once, and any agent on your machine — Claude Code, Codex, OpenClaw, Hermes Agent — can talk to any provider — Anthropic, OpenAI, OpenRouter, Kimi, DeepSeek, Groq, or your own OpenAI-compatible endpoint — without editing each agent's own configuration.

Roadmap order: **connect → control → optimize → protect.**

| Stage | Capability | Status |
| --- | --- | --- |
| **connect** | Discover installed agents; route any agent to any provider; cross-protocol translation (Anthropic ↔ OpenAI) including streaming | ✅ v0.1.0 |
| **control** | Per-agent quotas, allowed-models policies, audit log | 🚧 planned |
| **optimize** | Multi-provider fallback on failure; cost-aware routing; latency-aware routing | 🚧 planned |
| **protect** | Prompt-injection / PII / secret detection; tool-call guardrails | 💼 commercial (planned) |

The open core is licensed under AGPL-3.0. Security and governance features will ship as a commercial add-on.

Audience: individual users, developers, solo and small teams. Not aimed at enterprise procurement.

## Why thomas

| Approach | Problem |
| --- | --- |
| Manually edit each agent's config (`~/.claude/settings.json`, `~/.codex/auth.json`, …) | Brittle. Five agents = five drift surfaces. |
| Use a profile-switcher that rewrites those configs | When you uninstall the switcher, the agent stays pointed at whatever it last wrote. |
| Use a router that requires `ANTHROPIC_BASE_URL` exported into your shell | When the router stops, your agent breaks. |
| **thomas** | Installs a transparent shim earlier in `PATH`. Original config is never touched. Uninstall thomas → shim disappears → every agent reverts. |

## Install

```sh
npm i -g @thomas-security/thomas
thomas doctor
```

Requires Node 20+.

## Quick start

```sh
# 1. See what agents and credentials you already have on the host
thomas doctor

# 2. Wire an agent through thomas (installs a transparent PATH shim)
thomas connect claude-code

# 3. Add a provider key (only if thomas didn't import one for you)
thomas providers add openrouter sk-or-v1-...

# 4. Switch which model that agent uses (without touching its own config)
thomas route claude-code openrouter/anthropic/claude-sonnet-4.5

# 5. See current state
thomas list

# 6. Optional: supervise the proxy with launchd / systemd so it survives reboot
thomas daemon install

# Revert at any time
thomas disconnect claude-code
```

After `thomas connect`, add `~/.thomas/bin` to your `PATH` (the command prints the exact line).

## Currently supported

**Agents** (CLIs that thomas knows how to detect, import credentials from, and shim):

- Claude Code
- Codex CLI
- OpenClaw
- Hermes Agent

**Providers** (built-in routing targets):

- `anthropic` (Anthropic API)
- `openai` (OpenAI API)
- `openrouter`
- `kimi` (Moonshot AI)
- `deepseek`
- `groq`

Plus any OpenAI-compatible or Anthropic-compatible endpoint via `thomas providers register`.

## Cross-protocol translation

Both directions of `/v1/messages` ↔ `/v1/chat/completions` are translated, including streaming SSE — so a Claude Code (Anthropic-shape) agent can talk to OpenRouter / Groq / Kimi (OpenAI-shape), and a Codex (OpenAI-shape) agent can talk to Anthropic. System prompts, tool definitions, tool calls, tool results, image inputs, stop reasons, and SSE events are all mapped.

## Use the skill

This repo ships a `SKILL.md` in the root. AI agents that find this repo on GitHub can read it directly to drive thomas on a user's behalf.

To install the skill into your local Claude Code skill directory:

```sh
thomas skill install claude-code
```

After this, your Claude Code session can answer "switch claude code to kimi" / "show me which agents are connected" autonomously.

## Status

**v0.1.0 — public alpha.** The connect/route stage of the roadmap is complete and tested. Quotas, fallback, cost-aware routing, and security guardrails are not yet implemented.

## License

This project is licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0)**.

This means:

- ✅ You can use, modify, and distribute this software
- ✅ You can use it for commercial purposes
- ⚠️ **You must disclose source code** when you distribute the software
- ⚠️ **Network use is distribution** — if you run a modified version on a server and let others interact with it, you must make the source code available to them
- ⚠️ Modifications must be released under the same license

See the [LICENSE](LICENSE) file for the full license text.

### Why AGPL-3.0?

AGPL-3.0 ensures that improvements to this software benefit the entire community. If you modify thomas and deploy it as a service, you must share your improvements with your users. Commercial security and governance features will ship under a separate license.
