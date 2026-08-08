/**
 * Import Racional movements staged by `scraper/` (`npm run fetch:racional`).
 *
 *   npm run import:racional-movements -w nw-tracker-server              # report only
 *   npm run import:racional-movements -w nw-tracker-server -- --apply   # write
 *
 * Report-first: a movement here becomes a real ledger row with units, so the default run shows
 * exactly what it would write and changes nothing. Applying also advances the crawl watermark
 * (`cfraser/.racional-import-state.json`), which is what lets the next fetch stop as soon as it
 * reaches already-imported history instead of walking the whole list.
 */
import {
  applyRacionalMovements,
  listRacionalMovementFiles,
  planRacionalMovementsFile,
  readRacionalImportState,
  resolveRacionalMovementsDir,
} from "../src/racionalMovementsImport.js";

const apply = process.argv.includes("--apply");
const dir = resolveRacionalMovementsDir();
const files = listRacionalMovementFiles(dir);

if (files.length === 0) {
  console.log(`No staged Racional movements in ${dir}.`);
  console.log("Run: npm run fetch:racional");
  process.exit(0);
}

const state = readRacionalImportState();
console.log(
  state?.last_movement_id
    ? `Watermark: ${state.last_occurred_at} (${state.last_movement_id})`
    : "Watermark: none — the next fetch will crawl the full list once."
);

let totalInserted = 0;
let totalDuplicates = 0;

for (const file of files) {
  const planned = planRacionalMovementsFile(file);
  console.log(`\n${planned.file}: ${planned.parsed} movement(s)`);
  for (const p of planned.planned) {
    const legs =
      p.from_account_id != null && p.to_account_id != null
        ? `${p.from_account_id} → ${p.to_account_id}`
        : `account ${p.account_id}`;
    const units = p.units_delta ? ` · ${p.units_delta} units` : "";
    const dup = p.duplicate_of != null ? `  [already in ledger as movement ${p.duplicate_of}]` : "";
    const manual = p.requires_manual ? `  [NOT written: ${p.requires_manual}]` : "";
    console.log(
      `  ${p.source.occurred_on}  ${p.source.kind.padEnd(16)} ${String(p.amount).padStart(12)} ${p.currency}  ${legs}${units}${dup}${manual}`
    );
  }

  if (apply) {
    const result = applyRacionalMovements(planned, new Date().toISOString());
    totalInserted += result.inserted;
    totalDuplicates += result.duplicates;
    console.log(`  → ${result.inserted} inserted, ${result.duplicates} already present`);
  } else {
    totalDuplicates += planned.duplicates;
  }
}

console.log(
  apply
    ? `\nImported ${totalInserted} movement(s); ${totalDuplicates} already present.`
    : `\nReport only — nothing written (${totalDuplicates} of the above already exist). Re-run with --apply.`
);
