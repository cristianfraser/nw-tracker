/**
 * Import Racional movements staged by `ingest/` (`npm run fetch:racional`).
 *
 *   npm run import:racional-movements -w nw-tracker-server              # report only
 *   npm run import:racional-movements -w nw-tracker-server -- --apply   # write
 *
 * Report-first: a movement here becomes a real ledger row with units, so the default run shows
 * exactly what it would write and changes nothing. Applying also moves the crawl watermark
 * (`cfraser/.racional-import-state.json` → `last_row_key`), which is what lets the next fetch
 * stop as soon as it reaches already-imported history, and — when the run leaves nothing to
 * fix — `clean_crawl_at`, which answers the e-mail nudges mailed before that crawl.
 *
 * Two staged shapes: `movements-<stamp>.json` (the scraped list rows, dividends enriched with
 * their API record) and `dividends-<stamp>.json` (the raw `/users/movements/dividends`
 * response, saved on every crawl). The second pass pairs every API dividend with its ledger row
 * and writes the gross / withholding breakdown (`movement_dividend_details`), which is also how
 * dividends booked before 2026-09-23 get theirs.
 *
 * Exit status: non-zero when a staged file cannot be imported (a trade listed without its share
 * count that the ledger does not already hold, an unmapped kind — every other file and the
 * dividends pass still run), when the ledger and the feed DISAGREE about a movement (a same-day
 * same-legs row with a different amount), or when an API dividend has no ledger row — data
 * errors that must reach the nightly notification, unlike the by-design `requires_manual` cash
 * legs, which only report.
 */
import {
  listRacionalDividendFiles,
  listRacionalMovementFiles,
  readRacionalImportState,
  resolveRacionalMovementsDir,
  resolveRacionalStatePath,
  runRacionalImport,
} from "../src/racionalMovementsImport.js";

const apply = process.argv.includes("--apply");
const dir = resolveRacionalMovementsDir();

if (listRacionalMovementFiles(dir).length === 0 && listRacionalDividendFiles(dir).length === 0) {
  console.log(`No staged Racional movements in ${dir}.`);
  console.log("Run: npm run fetch:racional");
  process.exit(0);
}

const statePath = resolveRacionalStatePath();
const state = readRacionalImportState(statePath);
console.log(
  state?.last_row_key
    ? `Watermark: ${state.last_row_key} (from ${state.watermark_file ?? "an unnamed crawl"})`
    : state?.last_movement_id
      ? `Watermark: ${state.last_movement_id} — written before list keys, which the fetcher cannot match; it reads the whole rendered list once.`
      : "Watermark: none — the next fetch reads the whole rendered list once."
);

const summary = runRacionalImport({
  dir,
  statePath,
  apply,
  nowIso: new Date().toISOString(),
  log: (line) => console.log(line),
});

console.log(
  apply
    ? `\nImported ${summary.inserted} movement(s); ${summary.duplicates} already present; ${summary.details} dividend breakdown(s) written.`
    : `\nReport only — nothing written (${summary.duplicates} of the above already exist). Re-run with --apply.`
);
if (summary.state) {
  console.log(
    `State → watermark ${summary.state.last_row_key} (${summary.state.watermark_file}); ` +
      `clean through the crawl of ${summary.state.clean_crawl_at ?? "—"}`
  );
}

if (summary.failures.length > 0) {
  console.log(`\n${summary.failures.length} staged file problem(s) — NOT imported, fix and re-run:`);
  for (const f of summary.failures) console.log(`  ${f}`);
}
if (summary.conflicts.length > 0) {
  console.log(`\n${summary.conflicts.length} CONFLICT(S) — the ledger and Racional disagree; reconcile by hand:`);
  for (const c of summary.conflicts) console.log(`  ${c}`);
}
if (summary.failures.length > 0 || summary.conflicts.length > 0) process.exitCode = 1;
