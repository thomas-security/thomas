import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ServiceInstallParams, ServiceStatus, ThomasService } from "./service.js";
import { buildProxyServeArgs } from "./service.js";

const execFileP = promisify(execFile);

export class SystemdService implements ThomasService {
  readonly platformLabel = "systemd user service";

  constructor(public readonly label: string) {}

  private get unitName(): string {
    return `${this.label}.service`;
  }

  private get unitDir(): string {
    return join(process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? "", ".config"), "systemd", "user");
  }

  private get unitPath(): string {
    return join(this.unitDir, this.unitName);
  }

  async install(params: ServiceInstallParams): Promise<void> {
    await mkdir(this.unitDir, { recursive: true });
    const unit = renderSystemdUnit({
      programExec: params.programExec,
      programPrefixArgs: params.programPrefixArgs,
      port: params.port,
      homeDir: params.homeDir,
    });
    await writeFile(this.unitPath, unit);
    await this.systemctl("daemon-reload");
    await this.systemctl("enable", "--now", this.unitName);
  }

  async uninstall(): Promise<void> {
    if (existsSync(this.unitPath)) {
      await this.systemctl("disable", "--now", this.unitName).catch(() => undefined);
      await rm(this.unitPath, { force: true });
      await this.systemctl("daemon-reload").catch(() => undefined);
    }
  }

  async status(): Promise<ServiceStatus> {
    if (!existsSync(this.unitPath)) {
      return { installed: false, running: false };
    }
    const active = await this.isActive();
    return {
      installed: true,
      running: active,
      detail: active ? "active" : "inactive",
    };
  }

  async start(): Promise<void> {
    await this.systemctl("start", this.unitName);
  }

  async stop(): Promise<void> {
    await this.systemctl("stop", this.unitName).catch(() => undefined);
  }

  private async isActive(): Promise<boolean> {
    try {
      const { stdout } = await execFileP("systemctl", ["--user", "is-active", this.unitName], {
        timeout: 3000,
      });
      return stdout.trim() === "active";
    } catch {
      return false;
    }
  }

  private async systemctl(...args: string[]): Promise<void> {
    await execFileP("systemctl", ["--user", ...args], { timeout: 8000 });
  }
}

export function renderSystemdUnit(p: {
  programExec: string;
  programPrefixArgs: string[];
  port: number;
  homeDir: string;
}): string {
  const exec = quoteForSystemd([
    p.programExec,
    ...p.programPrefixArgs,
    ...buildProxyServeArgs(p.port),
  ]);
  const log = escapeIni(`${p.homeDir}/.thomas/proxy.log`);
  return `[Unit]
Description=Thomas — Universal adapter between AI agents and model providers
After=network.target

[Service]
ExecStart=${exec}
Restart=on-failure
RestartSec=5
StandardOutput=append:${log}
StandardError=append:${log}

[Install]
WantedBy=default.target
`;
}

function quoteForSystemd(parts: string[]): string {
  return parts
    .map((p) => {
      if (/^[A-Za-z0-9_./@:+=-]+$/.test(p)) return p;
      return `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    })
    .join(" ");
}

function escapeIni(s: string): string {
  return s.replace(/[\r\n]/g, " ");
}
