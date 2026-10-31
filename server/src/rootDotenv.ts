import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Repo root (parent of `server/`). */
export function repoRootFromSrc(): string {
  return path.resolve(__dirname, "..", "..");
}

let loadedFromStamp: string | null = null;
let checkedAtMs = -Infinity;

/** How long a load stands before the file is looked at again. */
const RECHECK_MS = 1000;

/**
 * Load repo-root `.env` when keys are not already in `process.env`. Hot readers call this per
 * lookup (the live-quote config, once per quote read), so the file is looked at no more than
 * once a second and re-read only when it changed on disk.
 */
export function loadRootDotenv(): void {
  const nowMs = Date.now();
  if (nowMs - checkedAtMs < RECHECK_MS && nowMs >= checkedAtMs) return;
  checkedAtMs = nowMs;
  const p = path.join(repoRootFromSrc(), ".env");
  let stat: fs.Stats;
  try {
    stat = fs.statSync(p);
  } catch {
    return;
  }
  const stamp = `${stat.ino}|${stat.mtimeMs}|${stat.size}`;
  if (stamp === loadedFromStamp) return;
  loadedFromStamp = stamp;
  const text = fs.readFileSync(p, "utf8");
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
