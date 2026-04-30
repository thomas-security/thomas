import { homedir } from "node:os";
import { join } from "node:path";

function thomasDir(): string {
  return process.env.THOMAS_HOME ?? join(homedir(), ".thomas");
}

export const paths = {
  get root() {
    return thomasDir();
  },
  get config() {
    return join(thomasDir(), "config.json");
  },
  get credentials() {
    return join(thomasDir(), "credentials.json");
  },
  get routes() {
    return join(thomasDir(), "routes.json");
  },
  get agents() {
    return join(thomasDir(), "agents.json");
  },
  get providers() {
    return join(thomasDir(), "providers.json");
  },
  get bin() {
    return join(thomasDir(), "bin");
  },
  get proxyPid() {
    return join(thomasDir(), "proxy.pid");
  },
  get proxyLog() {
    return join(thomasDir(), "proxy.log");
  },
};

export function home(...segments: string[]): string {
  return join(homedir(), ...segments);
}
