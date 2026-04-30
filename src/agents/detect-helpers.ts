import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export async function whichBinary(name: string): Promise<string | undefined> {
  const cmd = process.platform === "win32" ? "where" : "which";
  try {
    const { stdout } = await execFileP(cmd, [name]);
    const first = stdout.split(/\r?\n/).find((line) => line.trim().length > 0);
    return first?.trim();
  } catch {
    return undefined;
  }
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function macKeychainFind(
  service: string,
): Promise<{ account: string } | undefined> {
  if (process.platform !== "darwin") return undefined;
  try {
    const { stdout } = await execFileP("security", ["find-generic-password", "-s", service], {
      timeout: 2000,
    });
    const match = stdout.match(/"acct"<blob>="([^"]+)"/);
    return match ? { account: match[1]! } : { account: "" };
  } catch {
    return undefined;
  }
}

export async function macKeychainRead(service: string): Promise<string | undefined> {
  if (process.platform !== "darwin") return undefined;
  try {
    const { stdout } = await execFileP(
      "security",
      ["find-generic-password", "-s", service, "-w"],
      { timeout: 2000 },
    );
    return stdout.replace(/\r?\n$/, "");
  } catch {
    return undefined;
  }
}

export async function tryGetVersion(binary: string, flag = "--version"): Promise<string | undefined> {
  try {
    const { stdout } = await execFileP(binary, [flag], { timeout: 3000 });
    const first = stdout.split(/\r?\n/).find((line) => line.trim().length > 0);
    return first?.trim();
  } catch {
    return undefined;
  }
}
