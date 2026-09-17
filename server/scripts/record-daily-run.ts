/**
 * Record the daily bank run's outcome so a failure cannot pass unnoticed.
 *
 *   echo '[{"label":"fetch Santander","ok":true,"seconds":41}]' \
 *     | npx tsx server/scripts/record-daily-run.ts
 *
 * Reads the step results as JSON on stdin (the runner builds them) and writes one
 * `app_messages` row: `log` on a clean run, `notification` — which the app badges as unread —
 * when any step failed. Exits 1 when the run failed, so the caller can act on it too.
 */
import fs from "node:fs";
import { recordDailyRun, type DailyRunStep } from "../src/dailyRunLog.js";

function readStdin(): string {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

const raw = readStdin().trim();
if (!raw) {
  console.error("record-daily-run: no step JSON on stdin");
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
  console.error(`record-daily-run: unparseable step JSON (${err instanceof Error ? err.message : err})`);
  process.exit(2);
}

const result = recordDailyRun(steps);
console.log(result.body);
console.log(
  result.message_id != null
    ? `Recorded as app message ${result.message_id} (${result.kind}${result.recovered_from ? ", recovery" : ""}).`
    : "Not recorded."
);
process.exit(result.ok ? 0 : 1);
