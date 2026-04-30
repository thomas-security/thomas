import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { paths } from "../config/paths.js";
import type { ServiceInstallParams, ServiceStatus, ThomasService } from "./service.js";
import { buildProxyServeArgs } from "./service.js";

const execFileP = promisify(execFile);

export class LaunchdService implements ThomasService {
  readonly platformLabel = "LaunchAgent";

  constructor(public readonly label: string) {}

  private get plistPath(): string {
    return join(process.env.HOME ?? "", "Library", "LaunchAgents", `${this.label}.plist`);
  }

  private get domain(): string {
    return `gui/${process.getuid?.() ?? 501}`;
  }

  async install(params: ServiceInstallParams): Promise<void> {
    await mkdir(join(params.homeDir, "Library", "LaunchAgents"), { recursive: true });
    const plist = renderPlist({
      label: this.label,
      programArguments: [
        params.programExec,
        ...params.programPrefixArgs,
        ...buildProxyServeArgs(params.port),
      ],
      workingDirectory: params.homeDir,
      logPath: paths.proxyLog,
      home: params.homeDir,
    });
    await writeFile(this.plistPath, plist);
    if (await this.isLoaded()) {
      await this.run("bootout", `${this.domain}/${this.label}`);
    }
    await this.run("bootstrap", this.domain, this.plistPath);
  }

  async uninstall(): Promise<void> {
    if (await this.isLoaded()) {
      await this.run("bootout", `${this.domain}/${this.label}`).catch(() => undefined);
    }
    if (existsSync(this.plistPath)) {
      await rm(this.plistPath, { force: true });
    }
  }

  async status(): Promise<ServiceStatus> {
    const installed = existsSync(this.plistPath);
    const loaded = installed && (await this.isLoaded());
    if (!installed) return { installed: false, running: false };
    return {
      installed: true,
      running: loaded,
      detail: loaded ? "loaded" : "plist exists but not loaded",
    };
  }

  async start(): Promise<void> {
    if (!(await this.isLoaded())) {
      await this.run("bootstrap", this.domain, this.plistPath);
    } else {
      await this.run("kickstart", "-k", `${this.domain}/${this.label}`).catch(() => undefined);
    }
  }

  async stop(): Promise<void> {
    if (await this.isLoaded()) {
      await this.run("bootout", `${this.domain}/${this.label}`).catch(() => undefined);
    }
  }

  private async isLoaded(): Promise<boolean> {
    try {
      await execFileP("launchctl", ["print", `${this.domain}/${this.label}`], { timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }

  private async run(...args: string[]): Promise<void> {
    await execFileP("launchctl", args, { timeout: 5000 });
  }
}

export function renderPlist(p: {
  label: string;
  programArguments: string[];
  workingDirectory: string;
  logPath: string;
  home: string;
}): string {
  const programXml = p.programArguments
    .map((a) => `    <string>${escapeXml(a)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(p.label)}</string>
  <key>ProgramArguments</key>
  <array>
${programXml}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>${escapeXml(p.workingDirectory)}</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(p.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(p.logPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${escapeXml(p.home)}</string>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
