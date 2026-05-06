import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addThomasTokenToPlist,
  removeThomasTokenFromPlist,
} from "../src/agents/openclaw-plist.js";

// plutil is macOS-only. Skip the entire suite elsewhere so Linux/Windows CI passes.
const itDarwin = process.platform === "darwin" ? it : it.skip;

async function readEnv(plistPath: string): Promise<Record<string, string> | null> {
  const r = spawnSync("plutil", ["-extract", "EnvironmentVariables", "json", "-o", "-", plistPath], {
    encoding: "utf8",
  });
  if (r.status !== 0) return null;
  return JSON.parse(r.stdout);
}

describe("openclaw-plist", () => {
  let dir: string;
  let plistPath: string;
  const originalOverride = process.env.THOMAS_OPENCLAW_LAUNCHD_PLIST;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "thomas-plist-"));
    plistPath = join(dir, "ai.openclaw.gateway.plist");
    process.env.THOMAS_OPENCLAW_LAUNCHD_PLIST = plistPath;
  });

  afterEach(async () => {
    if (originalOverride !== undefined) process.env.THOMAS_OPENCLAW_LAUNCHD_PLIST = originalOverride;
    else delete process.env.THOMAS_OPENCLAW_LAUNCHD_PLIST;
    await rm(dir, { recursive: true, force: true });
  });

  it("returns touched=false when the plist file does not exist (foreground openclaw / non-darwin)", async () => {
    const out = await addThomasTokenToPlist("tok");
    expect(out.touched).toBe(false);
    expect(out.path).toBe(plistPath);
  });

  itDarwin(
    "creates EnvironmentVariables and adds THOMAS_OPENCLAW_TOKEN when key did not exist",
    async () => {
      // minimal LaunchAgent plist with NO EnvironmentVariables key
      await writeFile(
        plistPath,
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.openclaw.gateway</string>
  <key>ProgramArguments</key>
  <array><string>/usr/bin/true</string></array>
</dict>
</plist>`,
      );

      const out = await addThomasTokenToPlist("tok-abc");
      expect(out.touched).toBe(true);

      const env = await readEnv(plistPath);
      expect(env).toEqual({ THOMAS_OPENCLAW_TOKEN: "tok-abc" });

      // round-trip: removing should leave the plist with no EnvironmentVariables key
      const removed = await removeThomasTokenFromPlist();
      expect(removed.touched).toBe(true);
      expect(await readEnv(plistPath)).toBeNull();

      // sibling top-level keys must survive both mutations
      const xml = await readFile(plistPath, "utf8");
      expect(xml).toContain("ai.openclaw.gateway");
      expect(xml).toContain("/usr/bin/true");
    },
  );

  itDarwin("preserves sibling env vars across add+remove", async () => {
    await writeFile(
      plistPath,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.openclaw.gateway</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>OPENCLAW_GATEWAY_PORT</key>
    <string>18789</string>
  </dict>
</dict>
</plist>`,
    );

    await addThomasTokenToPlist("tok-xyz");
    expect(await readEnv(plistPath)).toEqual({
      OPENCLAW_GATEWAY_PORT: "18789",
      THOMAS_OPENCLAW_TOKEN: "tok-xyz",
    });

    await removeThomasTokenFromPlist();
    // sibling key remains; only our token is gone
    expect(await readEnv(plistPath)).toEqual({ OPENCLAW_GATEWAY_PORT: "18789" });
  });

  itDarwin("add is idempotent when the same token is already present", async () => {
    await writeFile(
      plistPath,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>x</string>
</dict>
</plist>`,
    );
    const first = await addThomasTokenToPlist("same");
    expect(first.touched).toBe(true);
    const second = await addThomasTokenToPlist("same");
    expect(second.touched).toBe(false);
  });

  itDarwin("remove is a no-op when our token isn't present", async () => {
    await writeFile(
      plistPath,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>x</string>
</dict>
</plist>`,
    );
    const out = await removeThomasTokenFromPlist();
    expect(out.touched).toBe(false);
  });
});
