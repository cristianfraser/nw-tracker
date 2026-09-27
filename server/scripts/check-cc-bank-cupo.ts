/**
 * Compare the bank's own cupo utilizado per card and currency (the latest nightly feed's product
 * summary, recorded by `import:santander-movements`) with what the app says each card owes.
 *
 *   npm run check:cc-bank-cupo -w nw-tracker-server               # judge the latest capture
 *   npm run check:cc-bank-cupo -w nw-tracker-server -- --recheck  # judge it again, ledger as of now
 *
 * Exits 1 on a mismatch or when the latest feed carried no summary — a nightly step that fails,
 * so the run's notification names it — and records its own app message with both sides and the
 * app's terms (a notification for a new, changed or cleared mismatch, a log otherwise). A capture
 * an earlier run already judged is reported again but raises nothing.
 */
import { db } from "../src/db.js";
import { insertAppMessage } from "../src/appMessages.js";
import {
  bankCupoMessageKind,
  formatBankCupoReport,
  judgeLatestBankCupoCapture,
} from "../src/ccBankCupoCheck.js";

const TITLE = "Credit card bank cupo";
const recheck = process.argv.includes("--recheck");

const accountName = (accountId: number): string =>
  (db.prepare(`SELECT name FROM accounts WHERE id = ?`).get(accountId) as { name: string } | undefined)?.name ??
  `account ${accountId}`;

const run = judgeLatestBankCupoCapture({ recheck });

if (!run.capture) {
  console.log("No bank cupo captured yet — the fetcher records it from 2026-09-27 on.");
  process.exit(0);
}

if (run.capture_error != null) {
  const body = `The latest Santander feed (${run.capture.source_file}) carried no cupo summary: ${run.capture_error}`;
  console.error(body);
  if (run.capture.already_checked) {
    console.log("(already reported — nothing new)");
    process.exit(0);
  }
  insertAppMessage("notification", TITLE, body);
  process.exit(1);
}

const report = formatBankCupoReport(run.verdicts, accountName);
console.log(report);

const fresh = run.verdicts.some((v) => v.fresh);
const mismatches = run.verdicts.filter((v) => v.status === "mismatch");
if (fresh) {
  insertAppMessage(bankCupoMessageKind(run.verdicts), TITLE, report);
} else {
  console.log(`\n(${run.capture.source_file} was already judged — nothing new to report)`);
}
process.exit(fresh && mismatches.length > 0 ? 1 : 0);
