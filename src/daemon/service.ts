import { homedir } from "node:os";
import { LABEL } from "./constants.js";
import { LaunchdService } from "./launchd.js";
import { ScheduledTaskService } from "./scheduled-task.js";
import { SystemdService } from "./systemd.js";

export type ServiceStatus = {
  installed: boolean;
  running: boolean;
  detail?: string;
};

export type ServiceInstallParams = {
  /** Absolute path to the program executable, e.g. process.execPath. */
  programExec: string;
  /** Additional args to prefix before "proxy serve --port N". E.g. the cli.js script path. */
  programPrefixArgs: string[];
  port: number;
  homeDir: string;
};

export interface ThomasService {
  /** Reverse-DNS label (macOS) / unit name (linux) / task name (windows). */
  readonly label: string;
  /** Friendly platform tag for messages: "LaunchAgent" / "systemd user service" / "Scheduled Task". */
  readonly platformLabel: string;
  install(params: ServiceInstallParams): Promise<void>;
  uninstall(): Promise<void>;
  status(): Promise<ServiceStatus>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function resolveService(): ThomasService {
  if (process.platform === "darwin") return new LaunchdService(LABEL);
  if (process.platform === "linux") return new SystemdService(LABEL);
  if (process.platform === "win32") return new ScheduledTaskService(LABEL);
  throw new Error(`thomas daemon supervision not supported on ${process.platform}`);
}

export function buildProxyServeArgs(port: number): string[] {
  return ["proxy", "serve", "--port", String(port)];
}

export function defaultInstallParams(port: number): ServiceInstallParams {
  const programExec = process.execPath;
  const programPrefixArgs: string[] = [];
  const script = process.argv[1];
  if (script && script !== programExec) programPrefixArgs.push(script);
  return {
    programExec,
    programPrefixArgs,
    port,
    homeDir: homedir(),
  };
}
