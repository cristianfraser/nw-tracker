/**
 * Fetch the BCI Lider «Estado de Cuenta» statement PDF from Gmail into `cfraser/inbox/`.
 *
 *   npm run fetch:lider-statements                  # normal use (45-day window)
 *   npm run fetch:lider-statements -- --dry-run     # list what would be downloaded
 *   npm run fetch:lider-statements -- --days=60     # widen the search window
 *   npm run fetch:lider-statements -- --force       # ignore the per-message ledger
 *
 * Exits non-zero when a statement mail's attachment shape is unmapped (see liderStatements.ts) —
 * a template change must fail the step, not silently drop a facturación.
 */
import { fetchLiderStatementEmails } from "./liderStatements.js";
import { setForceRefetch } from "../documentLedger.js";
import { log } from "../log.js";

const argv = process.argv.slice(2);
const daysRaw = Number(argv.find((a) => a.startsWith("--days="))?.split("=")[1]);

setForceRefetch(argv.includes("--force"));

fetchLiderStatementEmails({
  windowDays: Number.isFinite(daysRaw) && daysRaw > 0 ? daysRaw : undefined,
  dryRun: argv.includes("--dry-run"),
})
  .then((result) => {
    log("");
    log(
      `Summary: ${result.saved.length} saved, ${result.skipped.length} skipped` +
        (result.errors.length > 0 ? `, ${result.errors.length} ERROR(S)` : "")
    );
    process.exitCode = result.errors.length > 0 ? 1 : 0;
  })
  .catch((err: unknown) => {
    log(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
