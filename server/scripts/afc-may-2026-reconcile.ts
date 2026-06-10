/**
 * One-off: AFC account May 2026 balance + movement reconcile (see plan afc-may-fix).
 * Run: npx tsx scripts/afc-may-2026-reconcile.ts
 */
import { invalidateAggregationForAccountDate } from "../src/aggregationCache.js";
import { db } from "../src/db.js";

const AFC_ACCOUNT_ID = 79;
const MAY_WITHDRAWAL_ON = "2026-05-13";
const NEW_WITHDRAWAL_CLP = -2_732_052;
const VALUATION_CLP = 1_323_181;

const upsertVal = db.prepare(`
  INSERT INTO valuations (account_id, as_of_date, value_clp) VALUES (?, ?, ?)
  ON CONFLICT(account_id, as_of_date) DO UPDATE SET value_clp = excluded.value_clp
`);

const updMov = db.prepare(`
  UPDATE movements SET amount_clp = ?,
    note = CASE
      WHEN note LIKE '%|manual:may-2026-balance-reconcile%' THEN note
      ELSE COALESCE(note, '') || '|manual:may-2026-balance-reconcile'
    END
  WHERE account_id = ? AND occurred_on = ?
`);

for (const d of ["2026-05-31", "2026-06-01"]) {
  upsertVal.run(AFC_ACCOUNT_ID, d, VALUATION_CLP);
  invalidateAggregationForAccountDate(AFC_ACCOUNT_ID, d);
}

const mov = updMov.run(NEW_WITHDRAWAL_CLP, AFC_ACCOUNT_ID, MAY_WITHDRAWAL_ON);
if (mov.changes !== 1) {
  throw new Error(
    `Expected 1 movement update on ${MAY_WITHDRAWAL_ON}, got ${mov.changes}`
  );
}
invalidateAggregationForAccountDate(AFC_ACCOUNT_ID, MAY_WITHDRAWAL_ON);

console.log("AFC reconcile OK:", {
  valuations: ["2026-05-31", "2026-06-01"],
  value_clp: VALUATION_CLP,
  movement: { occurred_on: MAY_WITHDRAWAL_ON, amount_clp: NEW_WITHDRAWAL_CLP },
});
