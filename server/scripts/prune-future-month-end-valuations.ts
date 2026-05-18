/**
 * Removes `valuations` rows dated at the **calendar month-end** of the **current Chile month** when that
 * date is still in the future (e.g. today `2026-05-14` → deletes all `as_of_date = 2026-05-31` rows).
 *
 * Excel import used to write that placeholder; mid-month Fintual snapshots use Chile “today”. Charts also
 * filter `as_of_date > today`, but pruning keeps the DB aligned.
 *
 *   npm run prune:future-month-end-valuations -w nw-tracker-server
 */
import { chileFutureMonthEndPlaceholderYmd } from "../src/chileDate.js";
import { db } from "../src/db.js";

const me = chileFutureMonthEndPlaceholderYmd();
if (!me) {
  console.log("No future month-end placeholder for the current Chile month — nothing to delete.");
  process.exit(0);
}

const r = db.prepare(`DELETE FROM valuations WHERE as_of_date = ?`).run(me);
console.log(`Deleted ${r.changes} valuation row(s) with as_of_date=${me}.`);
