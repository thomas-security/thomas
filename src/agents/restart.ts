import { spawn } from "node:child_process";
import type { RestartOutcome } from "./types.js";

export type RunCommandOptions = {
  /** Hard cap so a hung restart doesn't wedge connect/disconnect. */
  timeoutMs?: number;
  /** Inject for tests; defaults to node:child_process.spawn. */
  spawnFn?: typeof spawn;
};

/** Run an external command, capture exit + stderr tail, return a RestartOutcome.
 *  Used by AgentSpec.restart() implementations so each agent doesn't reinvent
 *  the same spawn-and-wait dance. */
export async function runRestartCommand(
  argv: string[],
  method: string,
  opts: RunCommandOptions = {},
): Promise<RestartOutcome> {
  if (argv.length === 0) {
    return { attempted: false, ok: false, method, message: "no command" };
  }
  const startedAt = Date.now();
  const spawner = opts.spawnFn ?? spawn;
  // 60s default — observed openclaw daemon restart takes ~6s when reverting to bare config
  // but can exceed 30s when the new daemon boots into a thomas-patched config (it does a
  // startup readiness check that talks back to the thomas proxy). 60s comfortably covers both.
  const timeoutMs = opts.timeoutMs ?? 60_000;

  return new Promise<RestartOutcome>((resolve) => {
    let settled = false;
    const child = spawner(argv[0]!, argv.slice(1), {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderrTail = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2048);
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // child may already be gone
      }
      resolve({
        attempted: true,
        ok: false,
        method,
        message: `${method} timed out after ${timeoutMs}ms`,
        durationMs: Date.now() - startedAt,
      });
    }, timeoutMs);

    child.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        attempted: true,
        ok: false,
        method,
        message: `${method} failed to start: ${err.message}`,
        durationMs: Date.now() - startedAt,
      });
    });

    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const ok = code === 0;
      const trimmedStderr = stderrTail.trim();
      const message = ok
        ? `${method} completed`
        : `${method} exited ${code}${trimmedStderr ? `: ${trimmedStderr.split("\n").slice(-1)[0]}` : ""}`;
      resolve({
        attempted: true,
        ok,
        method,
        message,
        exitCode: code,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}
