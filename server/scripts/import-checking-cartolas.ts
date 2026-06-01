/**
 * Import Santander checking-account cartolas from xlsx and/or PDF.
 *
 *   npm run import:checking-cartolas -w nw-tracker-server -- --wipe
 *   npm run import:checking-cartolas -w nw-tracker-server -- --pdf
 *   npm run parse:checking-cartola-pdfs   # writes cfraser/checking-cartolas-from-pdf.json
 *
 * `--wipe` deletes all movements, valuations, and import registry for cuenta corriente, then loads every file.
 * Without `--wipe`, only months not yet in `checking_cartola_imports` are imported (safe when adding new files).
 * `--pdf` is the default; pass `--xlsx-only` to skip PDF parse/import.
 * `--skip-pdf-parse` imports existing JSON only (when PDF import is enabled).
 *
 * Env: CFRASER_CHECKING_CARTOLAS_DIR, CFRASER_CHECKING_CARTOLA_PDFS_DIR (optional overrides).
 */
import { importCheckingCartolasFromDir } from "../src/checkingCartolaImport.js";

function main() {
  const wipe = process.argv.includes("--wipe");
  const dryRun = process.argv.includes("--dry-run");
  const pdf = !process.argv.includes("--xlsx-only");
  const skipPdfParse = process.argv.includes("--skip-pdf-parse");
  const forceReimport = process.argv.includes("--force-reimport");
  const dirArg = process.argv.find((a) => a.startsWith("--dir="));
  const dir = dirArg?.slice("--dir=".length);

  const result = importCheckingCartolasFromDir({
    dir,
    wipe,
    dryRun,
    pdf,
    skipPdfParse,
    forceReimport,
  });

  if (result.errors.length) {
    process.exit(1);
  }
}

main();
