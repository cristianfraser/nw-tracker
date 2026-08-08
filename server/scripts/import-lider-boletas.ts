/**
 * Parse staged Lider «Boleta Digital» PDFs and import them (see `liderBoletasImport.ts`).
 *
 *   npm run import:lider-boletas                 # parse new boletas + import
 *   npm run import:lider-boletas -- --dry-run    # report without writing
 *   npm run import:lider-boletas -- --skip-parse # import already-parsed staged boletas only
 *
 * The Python parser is fail-fast (a boleta that does not balance aborts with the delta);
 * import is idempotent — receipts upsert by message id, card lines dedupe via the web-paste
 * path, stamps survive re-imports.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { importStagedBoletas } from "../src/liderBoletasImport.js";
import { invalidateAggregationForAccountDate } from "../src/aggregationCache.js";
import { liderMasterAccountId } from "../src/liderMovementsImport.js";
import { loadRootDotenv } from "../src/rootDotenv.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

loadRootDotenv();
const dryRun = process.argv.includes("--dry-run");

if (!process.argv.includes("--skip-parse")) {
  const r = spawnSync("python3", [path.join(__dirname, "parse-lider-boletas.py")], {
    stdio: "inherit",
  });
  if ((r.status ?? 1) !== 0) {
    console.error("Boleta parse failed — nothing imported. Fix the parser or quarantine the boleta.");
    process.exit(r.status ?? 1);
  }
}

const results = importStagedBoletas({ dryRun });
if (results.length === 0) {
  console.log("No staged boletas.");
  process.exit(0);
}

let created = 0;
const counts = new Map<string, number>();
for (const r of results) {
  counts.set(r.movement.status, (counts.get(r.movement.status) ?? 0) + 1);
  if (r.movement.status === "created") {
    created += 1;
    console.log(
      `  ${r.purchased_at}  ${String(r.card_paid_clp).padStart(9)} clp  ${r.items} item(s), ${r.items_classified} classified  [movement created]`
    );
  } else if (r.movement.status === "unknown_sucursal") {
    console.log(`  ${r.purchased_at}  UNKNOWN SUCURSAL «${r.movement.sucursal}» — add it to cc-cards.json boleta_sucursal_merchants`);
  }
}
console.log(
  `\n${results.length} boleta(s): ` +
    [...counts.entries()].map(([k, v]) => `${v} ${k}`).join(", ") +
    (dryRun ? " (dry run)" : "")
);
if (!dryRun && created > 0) {
  const earliest = results
    .filter((r) => r.movement.status === "created")
    .map((r) => r.purchased_at.slice(0, 10))
    .sort()[0]!;
  invalidateAggregationForAccountDate(liderMasterAccountId(), earliest);
}
