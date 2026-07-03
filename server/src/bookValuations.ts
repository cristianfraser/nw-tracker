import { assertValuationCurrencyClp } from "./valuationValue.js";
import { db } from "./db.js";

/** Stored `valuations` rows (ascending) for book / month-end snapshots. */
export function loadBookValuationsAsc(
  accountId: number
): { as_of_date: string; value_clp: number }[] {
  const rows = db
    .prepare(
      `SELECT as_of_date, value AS value_clp, currency FROM valuations WHERE account_id = ? ORDER BY as_of_date`
    )
    .all(accountId) as { as_of_date: string; value_clp: number; currency: string }[];
  return rows.map(({ currency, ...row }) => {
    assertValuationCurrencyClp(currency, "bookValuations");
    return row;
  });
}
