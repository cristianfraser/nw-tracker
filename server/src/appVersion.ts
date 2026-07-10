import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { repoRootFromSrc } from "./rootDotenv.js";

/** Version info shape, shared with the client (scripts/version-info.mjs). */
export interface AppVersionInfo {
  version: string;
  sha: string;
  commitAt: string;
  dirty: boolean;
  resolvedAt: string;
}

let cached: AppVersionInfo | undefined;

/**
 * Resolve the running commit's version.
 *
 * Prod (Render): the build writes `version.json` at repo root — preferred, because
 * `.git` may not be present at runtime. Local dev: no `version.json`, so run the
 * shared resolver (single source of truth for the format). Fail fast if neither
 * works — no "unknown" fallback (AGENTS.md).
 */
export function getAppVersion(): AppVersionInfo {
  if (cached) return cached;
  const root = repoRootFromSrc();

  const versionJson = path.join(root, "version.json");
  if (fs.existsSync(versionJson)) {
    cached = JSON.parse(fs.readFileSync(versionJson, "utf8")) as AppVersionInfo;
    return cached;
  }

  const script = path.join(root, "scripts", "version-info.mjs");
  const out = execFileSync("node", [script], { cwd: root, encoding: "utf8" });
  cached = JSON.parse(out) as AppVersionInfo;
  return cached;
}
