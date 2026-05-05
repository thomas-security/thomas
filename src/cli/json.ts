// Runtime helpers that wrap a thomas command in either human or JSON output.
// All read commands route through `runJson` so the JSON envelope (schemaVersion,
// command, generatedAt, data | error) stays uniform — see CLAUDE.md "Operating
// model".

import type { CommandName, CommandOutput, ErrorPayload } from "./output.js";

export class ThomasError extends Error {
  constructor(public payload: ErrorPayload) {
    super(payload.message);
    this.name = "ThomasError";
  }
}

export type RunJsonOptions<C extends CommandName> = {
  command: C;
  json: boolean;
  fetch: () => Promise<CommandOutput[C]>;
  printHuman: (data: CommandOutput[C]) => void;
};

export async function runJson<C extends CommandName>(opts: RunJsonOptions<C>): Promise<number> {
  try {
    const data = await opts.fetch();
    if (opts.json) {
      process.stdout.write(formatOk(opts.command, data, new Date()));
      return 0;
    }
    opts.printHuman(data);
    return 0;
  } catch (err) {
    const payload = toErrorPayload(err);
    if (opts.json) {
      process.stdout.write(formatError(opts.command, payload, new Date()));
    } else {
      process.stderr.write(`thomas: ${payload.message}\n`);
      if (payload.remediation) process.stderr.write(`  ${payload.remediation}\n`);
    }
    return 1;
  }
}

export function formatOk<C extends CommandName>(
  command: C,
  data: CommandOutput[C],
  now: Date,
): string {
  return (
    JSON.stringify({
      schemaVersion: 1,
      command,
      generatedAt: now.toISOString(),
      data,
    }) + "\n"
  );
}

export function formatError(command: CommandName, error: ErrorPayload, now: Date): string {
  return (
    JSON.stringify({
      schemaVersion: 1,
      command,
      generatedAt: now.toISOString(),
      error,
    }) + "\n"
  );
}

export function toErrorPayload(err: unknown): ErrorPayload {
  if (err instanceof ThomasError) return err.payload;
  if (err instanceof Error) return { code: "E_INTERNAL", message: err.message };
  return { code: "E_INTERNAL", message: String(err) };
}
