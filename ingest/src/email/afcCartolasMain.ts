/**
 * Fetch the AFC's cartola PDFs from Gmail into `cfraser/afc-certs/cartolas/`.
 *
 *   npm run fetch:afc-cartolas                  # normal use (45-day window)
 *   npm run fetch:afc-cartolas -- --dry-run     # list what would be downloaded
 *   npm run fetch:afc-cartolas -- --days=400    # widen the search window (history)
 *   npm run fetch:afc-cartolas -- --force       # ignore the per-message ledger
 */
import { fetchAfcCartolaEmails } from "./afcCartolas.js";
import { setForceRefetch } from "../documentLedger.js";
import { log } from "../log.js";

const argv = process.argv.slice(2);
const daysRaw = Number(argv.find((a) => a.startsWith("--days="))?.split("=")[1]);
setForceRefetch(argv.includes("--force"));

fetchAfcCartolaEmails({ windowDays: Number.isFinite(daysRaw) && daysRaw > 0 ? daysRaw : undefined, dryRun: argv.includes("--dry-run") })
  .then((result) => {
    log("");
    log(`Summary: ${result.saved.length} saved, ${result.skipped.length} skipped` + (result.errors.length > 0 ? `, ${result.errors.length} ERROR(S)` : ""));
    process.exitCode = result.errors.length > 0 ? 1 : 0;
  })
  .catch((err: unknown) => {
    log(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
