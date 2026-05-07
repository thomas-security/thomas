// Regenerate src/cloud/openapi-types.ts from the running thomas-cloud's
// /openapi.json. Run when the server's wire shapes change:
//
//   bun run gen:types                       # default: http://localhost:8000
//   THOMAS_CLOUD_BASE_URL=https://thomas.trustunknown.com bun run gen:types
//
// Two artifacts land under src/cloud/:
//   - openapi.json        — checked-in spec (drift-detectable in CI)
//   - openapi-types.ts    — generated TS, imported by policy-bridge / runs-uplink
//
// Both files are regenerated atomically; nothing is partially overwritten.

import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const baseUrl = (process.env.THOMAS_CLOUD_BASE_URL ?? "http://localhost:8000").replace(/\/+$/, "");
const specPath = join("src", "cloud", "openapi.json");
const typesPath = join("src", "cloud", "openapi-types.ts");

console.log(`Fetching ${baseUrl}/openapi.json…`);
const resp = await fetch(`${baseUrl}/openapi.json`);
if (!resp.ok) {
  console.error(`Failed to fetch OpenAPI: ${resp.status} ${resp.statusText}`);
  console.error(`Make sure thomas-cloud is running and reachable at ${baseUrl}.`);
  process.exit(1);
}
const spec = await resp.json();

// Stable, prettified — diff-friendly.
await writeFile(specPath, JSON.stringify(spec, null, 2) + "\n");
console.log(`Wrote ${specPath} (${(JSON.stringify(spec).length / 1024).toFixed(1)} KB)`);

// Use the CLI to generate. Single-file output, no per-route boilerplate.
const result = spawnSync(
  "bunx",
  [
    "openapi-typescript",
    specPath,
    "--output",
    typesPath,
    "--root-types",
    // Use plain object types instead of `Record<string, never>` for empty
    // schemas — friendlier to import and typecheck.
    "--alphabetize",
  ],
  { stdio: "inherit" },
);
if (result.status !== 0) {
  console.error("openapi-typescript failed");
  process.exit(result.status ?? 1);
}
console.log(`Wrote ${typesPath}`);
