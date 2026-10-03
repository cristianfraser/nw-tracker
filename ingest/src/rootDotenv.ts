import fs from "node:fs";
import path from "node:path";
import { resolveRepoRoot } from "./paths.js";

/**
 * Load the repo-root `.env` into `process.env` for keys not already set (a copy of the server's
 * `rootDotenv.ts`). The inbox pipeline loads it first so every step it spawns sees the same
 * settings — the statement PDF passwords the qpdf step decrypts with among them.
 */
export function loadRootDotenv(): void {
  const p = path.join(resolveRepoRoot(), ".env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
