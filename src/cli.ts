import { parseArgs } from "node:util";
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
import { proxyEnsure, proxyServe, proxyStatus, proxyStop } from "./commands/proxy.js";
import { route } from "./commands/route.js";
import { skillInstall, skillRemove } from "./commands/skill.js";

const VERSION = "0.1.0";

const HELP = `thomas v${VERSION} — unified model proxy for AI agents

Usage:
  thomas doctor                       Discover installed agents and credentials
  thomas connect <agent> [flags]      Wire an agent through thomas
                                        --no-import   skip credential import
                                        --no-proxy    import only, do not install shim
  thomas disconnect <agent>           Remove the shim for an agent
  thomas route <agent> <prov/model>   Switch which model an agent uses
  thomas list                         Show current state
  thomas providers                    List provider credentials
  thomas providers add <id> <key>     Add an API key for a provider
  thomas providers remove <id>        Remove credentials for a provider
  thomas providers register <id> --protocol <p> --base-url <url>
                                      Register a custom provider
  thomas providers unregister <id>    Remove a custom provider
  thomas skill install <agent>        Install the thomas skill into an agent's skill dir
  thomas skill remove <agent>         Remove the installed thomas skill
  thomas daemon install               Install thomas as a launchd/systemd user service
  thomas daemon uninstall             Remove the supervised service
  thomas daemon status                Show daemon supervision state

Tip: install the skill so an AI agent can drive thomas for you:
  thomas skill install claude-code
Or fetch SKILL.md from https://github.com/openguardrails/thomas
`;

async function main(): Promise<number> {
  const cmd = process.argv[2];

  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (cmd === "--version" || cmd === "-v" || cmd === "version") {
    console.log(VERSION);
    return 0;
  }

  switch (cmd) {
    case "doctor":
      await doctor();
      return 0;

    case "connect": {
      const { positionals, values } = parseArgs({
        args: process.argv.slice(3),
        options: {
          "no-import": { type: "boolean" },
          "no-proxy": { type: "boolean" },
        },
        allowPositionals: true,
      });
      const agentId = positionals[0];
      if (!agentId) return usage("thomas connect <agent>");
      return connect({
        agentId,
        noImport: values["no-import"],
        noProxy: values["no-proxy"],
      });
    }

    case "disconnect": {
      const agentId = process.argv[3];
      if (!agentId) return usage("thomas disconnect <agent>");
      return disconnect(agentId);
    }

    case "route": {
      const agentId = process.argv[3];
      const spec = process.argv[4];
      if (!agentId || !spec) return usage("thomas route <agent> <provider/model>");
      return route(agentId, spec);
    }

    case "list":
      await list();
      return 0;

    case "providers":
      return runProviders();

    case "daemon":
      return runDaemon();

    case "proxy":
      return runProxy();

    case "skill":
      return runSkill();

    default:
      console.error(`thomas: unknown command '${cmd}'`);
      console.error("Run `thomas --help` for usage.");
      return 1;
  }
}

async function runDaemon(): Promise<number> {
  const sub = process.argv[3];
  switch (sub) {
    case "install":
      return daemonInstall();
    case "uninstall":
    case "remove":
      return daemonUninstall();
    case "status":
      return daemonStatus();
    default:
      console.error("Usage: thomas daemon <install|uninstall|status>");
      return 1;
  }
}

async function runSkill(): Promise<number> {
  const sub = process.argv[3];
  const agentId = process.argv[4];
  if (sub === "install") {
    if (!agentId) return usage("thomas skill install <agent>");
    return skillInstall(agentId);
  }
  if (sub === "remove" || sub === "rm") {
    if (!agentId) return usage("thomas skill remove <agent>");
    return skillRemove(agentId);
  }
  console.error("Usage: thomas skill <install|remove> <agent>");
  return 1;
}

async function runProviders(): Promise<number> {
  const sub = process.argv[3];
  if (!sub) {
    await providersList();
    return 0;
  }
  if (sub === "add") {
    const id = process.argv[4];
    const key = process.argv[5];
    if (!id || !key) return usage("thomas providers add <id> <key>");
    return providersAdd(id, key);
  }
  if (sub === "remove" || sub === "rm") {
    const id = process.argv[4];
    if (!id) return usage("thomas providers remove <id>");
    return providersRemove(id);
  }
  if (sub === "register") {
    const { positionals, values } = parseArgs({
      args: process.argv.slice(4),
      options: { protocol: { type: "string" }, "base-url": { type: "string" } },
      allowPositionals: true,
    });
    const id = positionals[0];
    if (!id || !values.protocol || !values["base-url"]) {
      return usage("thomas providers register <id> --protocol <openai|anthropic> --base-url <url>");
    }
    return providersRegister(id, values.protocol, values["base-url"]);
  }
  if (sub === "unregister") {
    const id = process.argv[4];
    if (!id) return usage("thomas providers unregister <id>");
    return providersUnregister(id);
  }
  console.error(`thomas providers: unknown subcommand '${sub}'`);
  return 1;
}

async function runProxy(): Promise<number> {
  const sub = process.argv[3];
  const { values } = parseArgs({
    args: process.argv.slice(4),
    options: { port: { type: "string" } },
    allowPositionals: true,
  });
  const port = values.port ? Number.parseInt(values.port, 10) : undefined;
  switch (sub) {
    case "serve":
      await proxyServe(port);
      return 0; // serve runs forever; this is unreachable
    case "ensure":
      return proxyEnsure(port);
    case "status":
      return proxyStatus();
    case "stop":
      return proxyStop();
    default:
      console.error("Usage: thomas proxy <serve|ensure|status|stop> [--port N]");
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
