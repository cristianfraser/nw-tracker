import { accountKindSlugForAccountId } from "./accountBucket.js";
import { kindIsDebt } from "./accountProfile.js";
import { storedValuationInUnit, valuationsAreAppraisals } from "./valuationValue.js";
import { db } from "./db.js";

/**
 * Stored `valuations` rows (ascending) for book / month-end snapshots, as the account's value in
 * pesos (a row in another currency converted once, on its own date, at the account's side). A
 * property's rows are its appraisals, not book snapshots: none.
 */
export function loadBookValuationsAsc(
  accountId: number
): { as_of_date: string; value_clp: number }[] {
  const kind = accountKindSlugForAccountId(accountId) ?? "";
  if (valuationsAreAppraisals(kind)) return [];
  const side = kindIsDebt(kind) ? "debt" : "asset";
  const rows = db
    .prepare(`SELECT as_of_date, value, currency FROM valuations WHERE account_id = ? ORDER BY as_of_date`)
    .all(accountId) as { as_of_date: string; value: number; currency: string }[];
  return rows.map((r) => ({
    as_of_date: r.as_of_date,
    value_clp: storedValuationInUnit(r, "clp", side, "bookValuations"),
  }));
}
