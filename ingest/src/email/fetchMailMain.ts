/**
 * Fetch one mail source's documents (`mailFetcher.ts`):
 *
 *   npm run fetch:<source> -w nw-tracker-ingest [-- --days=N] [--all] [--dry-run] [--force]
 *
 * `--days` widens the window (default `DEFAULT_MAIL_WINDOW_DAYS`), `--all` reads a source's full
 * history where it allows one, `--dry-run` lists without writing, `--force` ignores the ledger.
 * Exit 1 when a mail had a shape the source does not take, or the fetch failed.
 */
import { setForceRefetch } from "../documentLedger.js";
import { log } from "../log.js";
import { reportStepResult } from "../stepResult.js";
import { AFC_CARTOLAS_SOURCE } from "./afcCartolas.js";
import { APPLE_MAIL_SOURCE } from "./appleMail.js";
import { FINTUAL_ACCIONES_SOURCE } from "./fintualDocs.js";
import { LIDER_BOLETAS_SOURCE } from "./liderBoletas.js";
import { LIDER_STATEMENT_SOURCE } from "./liderStatements.js";
import { fetchMailDocuments, type MailSource } from "./mailFetcher.js";
import { SANTANDER_DOCS_SOURCE } from "./santanderDocs.js";

const SOURCES: Record<string, MailSource> = {
  "santander-docs": SANTANDER_DOCS_SOURCE,
  "lider-boletas": LIDER_BOLETAS_SOURCE,
  "lider-statements": LIDER_STATEMENT_SOURCE,
  "fintual-docs": FINTUAL_ACCIONES_SOURCE,
  "apple-mail": APPLE_MAIL_SOURCE,
  "afc-cartolas": AFC_CARTOLAS_SOURCE,
};

const [name, ...argv] = process.argv.slice(2);
const source = SOURCES[name ?? ""];
if (!source) throw new Error(`usage: fetchMailMain.ts <${Object.keys(SOURCES).join("|")}> [--days=N] [--all] [--dry-run] [--force]`);
const daysRaw = Number(argv.find((a) => a.startsWith("--days="))?.split("=")[1]);
setForceRefetch(argv.includes("--force"));

fetchMailDocuments(source, {
  windowDays: Number.isFinite(daysRaw) && daysRaw > 0 ? daysRaw : undefined,
  allHistory: argv.includes("--all"),
  dryRun: argv.includes("--dry-run"),
})
  .then((result) => {
    log("");
    log(
      `Summary: ${result.saved.length} saved, ${result.skipped.length} skipped` +
        (result.errors.length > 0 ? `, ${result.errors.length} ERROR(S)` : "")
    );
    if (!argv.includes("--dry-run")) reportStepResult({ staged: result.saved.length });
    process.exitCode = result.errors.length > 0 ? 1 : 0;
  })
  .catch((err: unknown) => {
    log(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
