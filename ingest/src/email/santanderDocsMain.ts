/**
 * Fetch Santander's monthly statement + cartola PDFs from Gmail into `cfraser/inbox/`.
 *
 *   npm run fetch:santander-docs                  # normal nightly use
 *   npm run fetch:santander-docs -- --dry-run     # list what would be downloaded
 *   npm run fetch:santander-docs -- --days=120    # widen the search window
 *   npm run fetch:santander-docs -- --force       # ignore the once-a-month ledger
 */
import { fetchSantanderMailDocuments } from "./santanderDocs.js";
import { setForceRefetch } from "../documentLedger.js";
import { log } from "../log.js";

const argv = process.argv.slice(2);
const daysRaw = Number(argv.find((a) => a.startsWith("--days="))?.split("=")[1]);

setForceRefetch(argv.includes("--force"));

fetchSantanderMailDocuments({
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
