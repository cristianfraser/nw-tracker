/**
 * Load the currency pairs `currencies` names (EUR/USD) into `fx_rates`: the whole history on the
 * first run, the missing days after. The `fx_pairs` global-sync source runs the same thing each fx
 * day. `npx tsx scripts/sync-fx-pairs.ts [--dry-run]` (from server/).
 */
import { syncFxPairsFromYahoo } from "../src/fxPairsSync.js";

const dryRun = process.argv.includes("--dry-run");
const result = await syncFxPairsFromYahoo({ dryRun });
for (const p of result.pairs) console.log(`${p.code}: ${p.inserted} row(s) inserted, latest ${p.latest ?? "—"}${dryRun ? " (dry run)" : ""}`);
