/**
 * Fetch Apple's App Store receipts and subscription notices from Gmail into `cfraser/apple-mail/`.
 *
 *   npm run fetch:apple-mail                  # normal use (45-day window)
 *   npm run fetch:apple-mail -- --dry-run     # list what would be staged
 *   npm run fetch:apple-mail -- --days=4000   # widen the window (history backfill)
 *   npm run fetch:apple-mail -- --force       # ignore the per-message ledger
 */
import { fetchAppleMail } from "./appleMail.js";
import { setForceRefetch } from "../documentLedger.js";
import { log } from "../log.js";

const argv = process.argv.slice(2);
const daysRaw = Number(argv.find((a) => a.startsWith("--days="))?.split("=")[1]);

setForceRefetch(argv.includes("--force"));

fetchAppleMail({
  windowDays: Number.isFinite(daysRaw) && daysRaw > 0 ? daysRaw : undefined,
  dryRun: argv.includes("--dry-run"),
})
  .then((result) => {
    log("");
    log(`Summary: ${result.saved.length} saved, ${result.skipped.length} skipped`);
    process.exitCode = 0;
  })
  .catch((err: unknown) => {
    log(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
