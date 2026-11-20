#!/usr/bin/env node
// The typechecker: TypeScript 7 (native), installed under the `typescript-7` alias because
// typescript-eslint still needs the classic `typescript` 5.x API (docs/test-speed-plan.md step 3).
// Both packages ship a `tsc` bin, so never rely on node_modules/.bin/tsc — call this wrapper.
// Usage (from a workspace): node <root>/scripts/tsc.mjs --noEmit
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSC = path.join(ROOT, "node_modules", "typescript-7", "bin", "tsc");
if (!existsSync(TSC)) {
  console.error(`TypeScript 7 not installed (${TSC} missing) — run npm ci at the repo root`);
  process.exit(2);
}
const r = spawnSync(process.execPath, [TSC, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 1);
