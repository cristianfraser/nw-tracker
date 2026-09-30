/**
 * Fetch Lider «Boleta Digital» receipt PDFs from Gmail into `cfraser/lider-boletas/staged/`.
 *
 *   npm run fetch:lider-boletas                  # normal nightly use (45-day window)
 *   npm run fetch:lider-boletas -- --dry-run     # list what would be downloaded
 *   npm run fetch:lider-boletas -- --days=120    # widen the search window
 *   npm run fetch:lider-boletas -- --all         # full-history backfill (first run)
 *   npm run fetch:lider-boletas -- --force       # ignore the per-message ledger
 */
import { fetchLiderBoletaEmails } from "./liderBoletas.js";
import { setForceRefetch } from "../documentLedger.js";
import { log } from "../log.js";

const argv = process.argv.slice(2);
const daysRaw = Number(argv.find((a) => a.startsWith("--days="))?.split("=")[1]);

setForceRefetch(argv.includes("--force"));

fetchLiderBoletaEmails({
  windowDays: Number.isFinite(daysRaw) && daysRaw > 0 ? daysRaw : undefined,
  allHistory: argv.includes("--all"),
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
