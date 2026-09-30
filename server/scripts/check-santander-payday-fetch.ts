/**
 * Exit 0 (and record the attempt) when the hourly poll should fetch Santander for the payday
 * deposit, 1 when not — see `src/santanderPaydayFetch.ts`. The shell needs an exit code; the
 * reason is printed either way. Reads the scraper's state files, never the database.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chileWallClockAt } from "../src/chileDate.js";
import { santanderPaydayFetchDecision } from "../src/santanderPaydayFetch.js";

// The repo's cfraser/ — resolved here rather than through cfraserPaths, whose imports open the DB.
const cfraser = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "cfraser");
const stateFile = path.join(cfraser, ".santander-payday-fetch.json");

function readJson(file: string): Record<string, unknown> | null {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

function isoOrNull(raw: unknown): Date | null {
  if (typeof raw !== "string") return null;
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) throw new Error(`invalid timestamp ${JSON.stringify(raw)}`);
  return at;
}

/** Newest `card-movements-<UTC stamp>.json`, staged or imported (same rule as the catch-up). */
function lastSuccessfulFetchAt(): Date | null {
  const dir = path.join(cfraser, "santander-movements");
  let latest: Date | null = null;
  for (const d of [dir, path.join(dir, "imported")]) {
    if (!fs.existsSync(d)) continue;
    for (const name of fs.readdirSync(d)) {
      const m = /^card-movements-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})\.json$/.exec(name);
      if (!m) continue;
      const at = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`);
      if (!latest || at > latest) latest = at;
    }
  }
  return latest;
}

const now = new Date();
const lastAttemptYmd = readJson(stateFile)?.last_attempt_ymd;
const decision = santanderPaydayFetchDecision({
  now,
  lastPaydayAttemptYmd: typeof lastAttemptYmd === "string" ? lastAttemptYmd : null,
  lastSuccessfulFetchAt: lastSuccessfulFetchAt(),
  lastBankAttemptAt: isoOrNull(readJson(path.join(cfraser, ".scraper-run-state.json"))?.santander),
  loginLatched: fs.existsSync(path.join(cfraser, ".santander-login-rejected.json")),
});
if (decision.due) {
  // Recorded before the fetch runs: a payday fetch that fails still used the day's one attempt.
  fs.writeFileSync(stateFile, JSON.stringify({ last_attempt_ymd: chileWallClockAt(now).ymd }, null, 2));
  console.log(`payday fetch due — ${decision.reason}`);
  process.exit(0);
}
console.log(`no payday fetch — ${decision.reason}`);
process.exit(1);
