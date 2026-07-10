/**
 * Single source of truth for the app version string (client bundle + server).
 *
 * Scheme: commit-timestamp + short SHA, e.g. `2026-07-10.1433+c2d35e2`.
 * The timestamp is the committer date in UTC (`%cI`), so the string strictly
 * increases per commit on this single-dev repo and stays orderable — while
 * needing only the tip commit, which is all Render's *shallow* build clone has
 * (`git rev-list --count` would need full history and is deliberately avoided).
 * A dirty worktree appends `+dirty`.
 *
 * Three consumers:
 *   - client/vite.config.ts  imports resolveVersionInfo() → bakes __NW_CLIENT_VERSION__
 *   - render.yaml buildCommand runs `node scripts/version-info.mjs --write version.json`
 *   - server/src/appVersion.ts reads that version.json (falls back to running this)
 *
 * Node builtins only (runs before any install step in the Render build).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function git(args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

/** @returns {{version: string, sha: string, commitAt: string, dirty: boolean, resolvedAt: string}} */
export function resolveVersionInfo() {
  // "<shortsha> <committer-date-ISO-8601>" — one call, tip commit only.
  const [sha, commitAt] = git(["log", "-1", "--format=%h %cI"]).split(" ");
  const dirty = git(["status", "--porcelain"]).length > 0;
  const iso = new Date(commitAt).toISOString(); // normalize to UTC
  const stamp = `${iso.slice(0, 10)}.${iso.slice(11, 13)}${iso.slice(14, 16)}`;
  const version = `${stamp}+${sha}${dirty ? "+dirty" : ""}`;
  return { version, sha, commitAt, dirty, resolvedAt: new Date().toISOString() };
}

// CLI: `node scripts/version-info.mjs [--write <path>]`
// With --write, dumps the JSON to <path> (relative to repo root); otherwise prints to stdout.
if (import.meta.url === `file://${process.argv[1]}`) {
  const info = resolveVersionInfo();
  const writeIdx = process.argv.indexOf("--write");
  if (writeIdx !== -1) {
    const target = path.resolve(repoRoot, process.argv[writeIdx + 1] ?? "version.json");
    fs.writeFileSync(target, JSON.stringify(info, null, 2) + "\n");
    process.stderr.write(`version-info: wrote ${info.version} → ${target}\n`);
  } else {
    process.stdout.write(JSON.stringify(info) + "\n");
  }
}
