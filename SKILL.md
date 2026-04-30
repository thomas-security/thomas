---
name: thomas
description: Universal adapter between AI agents and model providers. Use thomas to discover installed AI agents on a host, wire them through a local proxy, and switch which model provider any agent uses without editing the agent's own config.
---

# thomas

`thomas` is a CLI that lets any AI agent on a host (Claude Code, Codex CLI, OpenClaw, hermes-agent) talk to any model provider through a single local proxy.

## When to use

Use thomas when the user wants to:
- See which AI agents are installed on this machine and what credentials they have. → `thomas doctor`
- Make an agent use a different model provider than the one it was configured with. → `thomas connect <agent>` then `thomas route <agent> <provider/model>`
- Reuse credentials already on the host (e.g., the local Claude CLI keychain entry) for a different agent.
- Stop routing an agent through thomas, restoring its original configuration. → `thomas disconnect <agent>`

## Commands

| Command | Purpose |
| --- | --- |
| `thomas doctor` | Read-only scan: which agents are installed, where their config lives, what credential sources they have. Always start here. |
| `thomas connect <agent>` | Install a PATH shim for the agent so its requests go to thomas's proxy. Imports the agent's existing credentials by default. |
| `thomas connect <agent> --no-import` | Install shim only; do not pull credentials from the agent. |
| `thomas connect <agent> --no-proxy` | Pull credentials into thomas's store, but do not install a shim. |
| `thomas disconnect <agent>` | Remove the shim. The agent's original config is untouched and resumes working. |
| `thomas route <agent> <provider/model>` | Change which model an agent uses. Does not touch the agent. |
| `thomas list` | Current state: connected agents, configured providers, active routes, proxy status. |
| `thomas skill install <agent>` | Install this skill into the named agent's skill directory so the agent can drive thomas for the user. |

## Key design facts (so you don't have to guess)

- thomas **never modifies the agent's own config files**. It works by putting a shim in `$HOME/.thomas/bin/<agent>` that runs earlier in PATH than the real binary, sets the right env vars, and execs the real binary. If thomas is uninstalled, the shim disappears and the original agent works as before.
- The proxy listens on `http://127.0.0.1:51168` (configurable). It exposes `/messages` for Anthropic-shaped clients and `/v1/chat/completions` for OpenAI-shaped clients.
- Credentials are stored in `~/.thomas/credentials.json` (plaintext JSON, same scheme as openclaw — supports `keyRef` for users who want to point to a vault/env var instead).
- Routes (`agent → provider/model`) live in `~/.thomas/routes.json`.

## How to drive thomas on the user's behalf

1. Run `thomas doctor` first to see what's on the host. Show the output to the user verbatim.
2. If the user wants to switch an agent's model, run `thomas connect <agent>` (defaults are usually right), then `thomas route <agent> <provider/model>`.
3. After any `connect`, the user should restart their agent's terminal session so the new shim is on PATH.
4. If anything misbehaves, run `thomas list` to see the current state and `thomas disconnect <agent>` to revert.

## Troubleshooting hints

- "Shim not on PATH" → the user's shell rc must include `$HOME/.thomas/bin` early in `PATH`. `thomas connect` prints the line to add.
- "Proxy not running" → the shim auto-starts the proxy daemon. If it failed, `~/.thomas/proxy.log` has the reason.
- "Agent still uses old credentials" → the agent process was started before the shim was installed. Restart the agent.
