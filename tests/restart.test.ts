import { describe, expect, it } from "bun:test";
import { runRestartCommand } from "../src/agents/restart.js";

const NODE = process.execPath;

describe("runRestartCommand", () => {
  it("returns ok=true when the command exits 0", async () => {
    const out = await runRestartCommand([NODE, "-e", "process.exit(0)"], "test cmd");
    expect(out.attempted).toBe(true);
    expect(out.ok).toBe(true);
    expect(out.method).toBe("test cmd");
    expect(out.exitCode).toBe(0);
    expect(out.message).toContain("completed");
    expect(typeof out.durationMs).toBe("number");
  });

  it("returns ok=false with last stderr line on non-zero exit", async () => {
    const script = `process.stderr.write("warmup\\nfatal: cannot reach launchd\\n"); process.exit(7);`;
    const out = await runRestartCommand([NODE, "-e", script], "openclaw daemon restart");
    expect(out.attempted).toBe(true);
    expect(out.ok).toBe(false);
    expect(out.exitCode).toBe(7);
    expect(out.message).toContain("exited 7");
    expect(out.message).toContain("fatal: cannot reach launchd");
  });

  it("returns ok=false when the binary cannot be spawned", async () => {
    const out = await runRestartCommand(
      ["/nonexistent/path/to/binary-xyz", "daemon", "restart"],
      "fake cmd",
    );
    expect(out.attempted).toBe(true);
    expect(out.ok).toBe(false);
    expect(out.message.toLowerCase()).toContain("failed to start");
  });

  it("times out a hung restart command", async () => {
    const script = `setTimeout(() => process.exit(0), 5000);`;
    const out = await runRestartCommand([NODE, "-e", script], "hang cmd", { timeoutMs: 80 });
    expect(out.attempted).toBe(true);
    expect(out.ok).toBe(false);
    expect(out.message).toContain("timed out");
    // duration should be close to the timeout, not the 5s the script would have run for
    expect(out.durationMs ?? 0).toBeLessThan(2000);
  });

  it("treats an empty argv as 'not attempted'", async () => {
    const out = await runRestartCommand([], "no-op");
    expect(out.attempted).toBe(false);
    expect(out.ok).toBe(false);
  });
});
