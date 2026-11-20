#!/usr/bin/env node
// Root `prepare` script: point git at the tracked hooks. A no-op (exit 0) without git, outside
// a work tree, or when this directory is not itself the work tree's root, so `npm ci` on the
// home server and in tarballs never breaks.
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
try {
  const top = run(["rev-parse", "--show-toplevel"]);
  if (top.error || top.status !== 0) process.exit(0);
  if (realpathSync(top.stdout.trim()) !== realpathSync(root)) process.exit(0);
  if (!existsSync(path.join(root, ".githooks"))) process.exit(0);
  run(["config", "core.hooksPath", ".githooks"]);
} catch {
  // never fail an install over a hook
}
process.exit(0);
