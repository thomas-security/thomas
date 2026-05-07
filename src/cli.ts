import { parseArgs } from "node:util";
import { cloudLogin } from "./commands/cloud/login.js";
import { cloudLogout } from "./commands/cloud/logout.js";
import { cloudSync } from "./commands/cloud/sync.js";
import { cloudWhoami } from "./commands/cloud/whoami.js";
import { connect } from "./commands/connect.js";
import { daemonInstall, daemonStatus, daemonUninstall } from "./commands/daemon.js";
import { disconnect } from "./commands/disconnect.js";
import { doctor } from "./commands/doctor.js";
import { list } from "./commands/list.js";
import {
  providersAdd,
  providersList,
  providersRegister,
  providersRemove,
  providersUnregister,
} from "./commands/providers.js";
import { explain } from "./commands/explain.js";
import { policyClear, policySet, policyShow } from "./commands/policy.js";
import { pricesSet, pricesShow, pricesUnset } from "./commands/prices.js";
import { recommend } from "./commands/recommend.js";
import { proxyServe, proxyStart, proxyStatus, proxyStop } from "./commands/proxy.js";
import { route } from "./commands/route.js";
import { runs } from "./commands/runs.js";
import { skillInstall, skillRemove } from "./commands/skill.js";
import { status } from "./commands/status.js";

const VERSION = "0.1.0";

const HELP = `thomas v${VERSION} — Universal adapter between AI agents and model providers

Usage:
  thomas status [--json]              Dashboard: which agents use what models, proxy state
  thomas runs [flags] [--json]        Recent agent runs: tokens, cost, latency
                                        --agent <id>     filter to a single agent
                                        --since <iso>    only runs ending after this timestamp
                                        --limit <N>      max records (default 20)
                                        --per-call       1 row per HTTP call (default groups by X-Thomas-Run-Id)
  thomas policy [--json]              Show configured cost-cascade policies + today's spend
  thomas policy set <agent> --primary <prov/model>
                                      [--at <usd>=<prov/model>]... (spend trigger, $/day)
                                      [--at-calls <int>=<prov/model>]... (count trigger, calls/day)
                                      [--failover-to <prov/model>]
                                      Configure cost cascade + optional in-run failover
  thomas policy clear <agent>         Remove an agent's policy
  thomas explain --run <id> [--json]  Narrate one run: route, tokens, cost, errors
  thomas explain --agent <id>         Narrate an agent's current state + today's spend
  thomas recommend --agent <id> [--json]
                                      Suggest model combinations + cost cascade
                                        --budget-day <usd>  cap on premium spend (default: half of premium projection)
                                        --preference quality|balanced|cost  (default: balanced)
  thomas prices [--json]              Show all known prices (builtin + user overlay)
  thomas prices set <prov/model> --input <usd-per-M> --output <usd-per-M>
                                      [--protocol openai|anthropic] [--tier premium|balanced|cheap]
                                      Add or override a price entry. Pass --protocol + --tier to make it
                                      eligible for 'thomas recommend' candidate selection.
  thomas prices unset <prov/model>    Remove an overlay entry (builtins are not removable)
  thomas doctor [--json] [--check]    Discover installed agents and credentials
                                        --check  also probe each provider's base URL (one HTTP call per
                                                 credentialed provider; surfaces wrong_path / unreachable / auth_failed)
  thomas connect <agent> [flags]      Wire an agent through thomas
                                        --no-import      skip credential import
                                        --no-proxy       import only, do not install shim
                                        --restart-agent  ask the agent to restart its daemon
                                                         (only effective for agents with a
                                                         restart hook — currently OpenClaw)
  thomas disconnect <agent> [flags]   Remove the shim for an agent
                                        --restart-agent  ask the agent to restart so it
                                                         reloads its (now-reverted) config
  thomas route <agent> <prov/model>   Switch which model an agent uses
  thomas list [--json]                Show full configured state (providers, routes, daemon)
  thomas providers [--json]           List provider credentials
  thomas providers add <id> <key>     Add an API key for a provider
  thomas providers remove <id>        Remove credentials for a provider
  thomas providers register <id> --protocol <p> --base-url <url>
                                      Register a custom provider
  thomas providers unregister <id>    Remove a custom provider
  thomas skill install <agent>        Install the thomas skill into an agent's skill dir
  thomas skill remove <agent>         Remove the installed thomas skill
  thomas daemon install               Install thomas as a launchd/systemd user service
  thomas daemon uninstall             Remove the supervised service
  thomas daemon status [--json]       Show daemon supervision state
  thomas proxy status [--json]        Show proxy state
  thomas cloud login [--base-url <url>] [--label <name>]
                                      Sign in to thomas-cloud (device-code grant; opens browser)
  thomas cloud logout [--json]        Clear local cloud credential
  thomas cloud whoami [--json]        Show current cloud login (workspace, device, last sync)
  thomas cloud sync [--json]          Pull policy / bundle / binding snapshot from thomas-cloud

Add --json to any command for stable, machine-readable output (see SKILL.md).

Tip: install the skill so an AI agent can drive thomas for you:
  thomas skill install claude-code
Or fetch SKILL.md from https://github.com/trustunknown/thomas
`;

function extractFlag(args: string[], name: string): boolean {
  const idx = args.indexOf(name);
  if (idx < 0) return false;
  args.splice(idx, 1);
  return true;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const json = extractFlag(args, "--json");
  const cmd = args[0];

  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (cmd === "--version" || cmd === "-v" || cmd === "version") {
    console.log(VERSION);
    return 0;
  }

  switch (cmd) {
    case "status":
      return status({ json });

    case "runs": {
      const { values } = parseArgs({
        args: args.slice(1),
        options: {
          agent: { type: "string" },
          since: { type: "string" },
          limit: { type: "string" },
          "per-call": { type: "boolean" },
        },
        allowPositionals: false,
      });
      return runs({
        json,
        agent: values.agent,
        since: values.since,
        limit: values.limit ? Number.parseInt(values.limit, 10) : undefined,
        perCall: values["per-call"],
      });
    }

    case "explain": {
      const { values } = parseArgs({
        args: args.slice(1),
        options: {
          run: { type: "string" },
          agent: { type: "string" },
        },
        allowPositionals: false,
      });
      if (!values.run && !values.agent) {
        return usage("thomas explain --run <id> | --agent <id>");
      }
      return explain({ json, runId: values.run, agentId: values.agent });
    }

    case "recommend": {
      const { values } = parseArgs({
        args: args.slice(1),
        options: {
          agent: { type: "string" },
          "budget-day": { type: "string" },
          preference: { type: "string" },
        },
        allowPositionals: false,
      });
      if (!values.agent) return usage("thomas recommend --agent <id> [--budget-day <usd>] [--preference quality|balanced|cost]");
      return recommend({
        json,
        agent: values.agent,
        budgetDay: values["budget-day"] ? Number.parseFloat(values["budget-day"]) : undefined,
        preference: values.preference,
      });
    }

    case "doctor": {
      const { values } = parseArgs({
        args: args.slice(1),
        options: { check: { type: "boolean" } },
        allowPositionals: false,
      });
      return doctor({ json, check: !!values.check });
    }

    case "connect": {
      const { positionals, values } = parseArgs({
        args: args.slice(1),
        options: {
          "no-import": { type: "boolean" },
          "no-proxy": { type: "boolean" },
          "restart-agent": { type: "boolean" },
        },
        allowPositionals: true,
      });
      const agentId = positionals[0];
      if (!agentId) return usage("thomas connect <agent>");
      return connect({
        agentId,
        noImport: values["no-import"],
        noProxy: values["no-proxy"],
        restartAgent: values["restart-agent"],
        json,
      });
    }

    case "disconnect": {
      const { positionals, values } = parseArgs({
        args: args.slice(1),
        options: {
          "restart-agent": { type: "boolean" },
        },
        allowPositionals: true,
      });
      const agentId = positionals[0];
      if (!agentId) return usage("thomas disconnect <agent>");
      return disconnect(agentId, { json, restartAgent: values["restart-agent"] });
    }

    case "route": {
      const agentId = args[1];
      const spec = args[2];
      if (!agentId || !spec) return usage("thomas route <agent> <provider/model>");
      return route(agentId, spec, { json });
    }

    case "list":
      return list({ json });

    case "providers":
      return runProviders(args, json);

    case "daemon":
      return runDaemon(args, json);

    case "proxy":
      return runProxy(args, json);

    case "skill":
      return runSkill(args, json);

    case "policy":
      return runPolicy(args, json);

    case "prices":
      return runPrices(args, json);

    case "cloud":
      return runCloud(args, json);

    default:
      console.error(`thomas: unknown command '${cmd}'`);
      console.error("Run `thomas --help` for usage.");
      return 1;
  }
}

async function runCloud(args: string[], json: boolean): Promise<number> {
  const sub = args[1];
  switch (sub) {
    case "login": {
      const { values } = parseArgs({
        args: args.slice(2),
        options: { "base-url": { type: "string" }, label: { type: "string" } },
        allowPositionals: false,
      });
      return cloudLogin({ baseUrl: values["base-url"], label: values.label });
    }
    case "logout":
      return cloudLogout({ json });
    case "whoami":
      return cloudWhoami({ json });
    case "sync":
      return cloudSync({ json });
    default:
      console.error("Usage: thomas cloud <login|logout|whoami|sync>");
      return 1;
  }
}

async function runDaemon(args: string[], json: boolean): Promise<number> {
  const sub = args[1];
  switch (sub) {
    case "install":
      return daemonInstall({ json });
    case "uninstall":
    case "remove":
      return daemonUninstall({ json });
    case "status":
      return daemonStatus({ json });
    default:
      console.error("Usage: thomas daemon <install|uninstall|status>");
      return 1;
  }
}

async function runSkill(args: string[], json: boolean): Promise<number> {
  const sub = args[1];
  const agentId = args[2];
  if (sub === "install") {
    if (!agentId) return usage("thomas skill install <agent>");
    return skillInstall(agentId, { json });
  }
  if (sub === "remove" || sub === "rm") {
    if (!agentId) return usage("thomas skill remove <agent>");
    return skillRemove(agentId, { json });
  }
  console.error("Usage: thomas skill <install|remove> <agent>");
  return 1;
}

async function runProviders(args: string[], json: boolean): Promise<number> {
  const sub = args[1];
  if (!sub) {
    return providersList({ json });
  }
  if (sub === "add") {
    const id = args[2];
    const key = args[3];
    if (!id || !key) return usage("thomas providers add <id> <key>");
    return providersAdd(id, key, { json });
  }
  if (sub === "remove" || sub === "rm") {
    const id = args[2];
    if (!id) return usage("thomas providers remove <id>");
    return providersRemove(id, { json });
  }
  if (sub === "register") {
    const { positionals, values } = parseArgs({
      args: args.slice(2),
      options: { protocol: { type: "string" }, "base-url": { type: "string" } },
      allowPositionals: true,
    });
    const id = positionals[0];
    if (!id || !values.protocol || !values["base-url"]) {
      return usage("thomas providers register <id> --protocol <openai|anthropic> --base-url <url>");
    }
    return providersRegister(id, values.protocol, values["base-url"], { json });
  }
  if (sub === "unregister") {
    const id = args[2];
    if (!id) return usage("thomas providers unregister <id>");
    return providersUnregister(id, { json });
  }
  console.error(`thomas providers: unknown subcommand '${sub}'`);
  return 1;
}

async function runPolicy(args: string[], json: boolean): Promise<number> {
  const sub = args[1];
  if (!sub) return policyShow({ json });
  if (sub === "set") {
    const { positionals, values } = parseArgs({
      args: args.slice(2),
      options: {
        primary: { type: "string" },
        at: { type: "string", multiple: true },
        "at-calls": { type: "string", multiple: true },
        "failover-to": { type: "string" },
      },
      allowPositionals: true,
    });
    const agentId = positionals[0];
    if (!agentId || !values.primary) {
      return usage(
        "thomas policy set <agent> --primary <prov/model> [--at <usd>=<prov/model>]... [--at-calls <int>=<prov/model>]... [--failover-to <prov/model>]",
      );
    }
    return policySet({
      json,
      agentId,
      primary: values.primary,
      cascade: (values.at ?? []) as string[],
      cascadeCalls: (values["at-calls"] ?? []) as string[],
      failoverTo: values["failover-to"],
    });
  }
  if (sub === "clear") {
    const agentId = args[2];
    if (!agentId) return usage("thomas policy clear <agent>");
    return policyClear(agentId, { json });
  }
  console.error(`thomas policy: unknown subcommand '${sub}'`);
  return 1;
}

async function runPrices(args: string[], json: boolean): Promise<number> {
  const sub = args[1];
  if (!sub) return pricesShow({ json });
  if (sub === "set") {
    const { positionals, values } = parseArgs({
      args: args.slice(2),
      options: {
        input: { type: "string" },
        output: { type: "string" },
        protocol: { type: "string" },
        tier: { type: "string" },
      },
      allowPositionals: true,
    });
    const modelSpec = positionals[0];
    if (!modelSpec || !values.input || !values.output) {
      return usage(
        "thomas prices set <provider/model> --input <usd-per-M> --output <usd-per-M> [--protocol openai|anthropic] [--tier premium|balanced|cheap]",
      );
    }
    return pricesSet({
      json,
      modelSpec,
      inputUsd: Number.parseFloat(values.input),
      outputUsd: Number.parseFloat(values.output),
      protocol: values.protocol,
      tier: values.tier,
    });
  }
  if (sub === "unset" || sub === "remove") {
    const modelSpec = args[2];
    if (!modelSpec) return usage("thomas prices unset <provider/model>");
    return pricesUnset(modelSpec, { json });
  }
  console.error(`thomas prices: unknown subcommand '${sub}'`);
  return 1;
}

async function runProxy(args: string[], json: boolean): Promise<number> {
  const sub = args[1];
  const { values } = parseArgs({
    args: args.slice(2),
    options: { port: { type: "string" } },
    allowPositionals: true,
  });
  const port = values.port ? Number.parseInt(values.port, 10) : undefined;
  switch (sub) {
    case "start":
      return proxyStart(port);
    case "serve":
      await proxyServe(port);
      return 0; // serve runs forever; this is unreachable
    case "status":
      return proxyStatus({ json });
    case "stop":
      return proxyStop();
    default:
      console.error("Usage: thomas proxy <start|serve|stop|status> [--port N]");
      return 1;
  }
}

function usage(line: string): number {
  console.error(`Usage: ${line}`);
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : err);
    process.exit(1);
  });
