/**
 * Record the hourly e-mail poll's outcome (`ingest/email-run.sh`).
 *
 *   echo '[{"label":"fetch broker e-mail","ok":true,"seconds":5}]' \
 *     | npx tsx server/scripts/record-email-run.ts --activity=1
 *
 * Reads the step results as JSON on stdin, like record-daily-run.ts, but writes under the
 * hourly titles — never the daily ones, whose presence would make the 22:00 scheduled run
 * skip itself for the day. The runner only calls this when something happened (activity or
 * a failure); a quiet success passed in anyway is deliberately not recorded.
 */
import fs from "node:fs";
import { recordHourlyEmailRun, type DailyRunStep } from "../src/dailyRunLog.js";

function readStdin(): string {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

const activity = process.argv.some((a) => a === "--activity=1" || a === "--activity");

const raw = readStdin().trim();
if (!raw) {
  console.error("record-email-run: no step JSON on stdin");
  process.exit(2);
}

let steps: DailyRunStep[];
try {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("expected an array of steps");
  steps = parsed.map((s: Record<string, unknown>) => ({
    label: String(s.label ?? "(unnamed step)"),
    ok: s.ok === true,
    seconds: typeof s.seconds === "number" ? s.seconds : null,
  }));
} catch (err) {
  console.error(`record-email-run: unparseable step JSON (${err instanceof Error ? err.message : err})`);
  process.exit(2);
}

const result = recordHourlyEmailRun(steps, { activity });
console.log(result.body);
console.log(
  result.recorded
    ? `Recorded as app message ${result.message_id} (${result.kind}).`
    : "Quiet run — not recorded."
);
process.exit(result.ok ? 0 : 1);
