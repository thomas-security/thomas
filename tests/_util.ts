// Shared test helpers. Filename underscore-prefixed so bun test (root="tests")
// doesn't try to load it as a test file.

export function captureStdout<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; out: string; err: string }> {
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  let out = "";
  let errBuf = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    errBuf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stderr.write;
  return fn()
    .then((result) => ({ result, out, err: errBuf }))
    .finally(() => {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    });
}
