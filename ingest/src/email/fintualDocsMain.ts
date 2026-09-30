/**
 * Fetch Fintual's «Acciones» PDFs (monthly Alpaca cartola, capital-events certificado) from
 * Gmail into `cfraser/fintual-acciones/`.
 *
 *   npm run fetch:fintual-docs                  # normal use (45-day window)
 *   npm run fetch:fintual-docs -- --dry-run     # list what would be downloaded
 *   npm run fetch:fintual-docs -- --days=400    # widen the window (history backfill)
 *   npm run fetch:fintual-docs -- --force       # ignore the per-message ledger
 *
 * Exits non-zero when a wanted mail's attachment shape is unmapped (see fintualDocs.ts) — a
 * template change must fail the step, not silently drop a statement.
 */
import { fetchFintualAccionesDocuments } from "./fintualDocs.js";
import { setForceRefetch } from "../documentLedger.js";
import { log } from "../log.js";

const argv = process.argv.slice(2);
const daysRaw = Number(argv.find((a) => a.startsWith("--days="))?.split("=")[1]);

setForceRefetch(argv.includes("--force"));

fetchFintualAccionesDocuments({
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
