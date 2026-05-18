import { chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";

export type LatestValuationRow = { value_clp: number; as_of_date: string };

const stmtOnOrBefore = db.prepare(
  `SELECT value_clp, as_of_date FROM valuations
   WHERE account_id = ? AND as_of_date <= ?
   ORDER BY as_of_date DESC LIMIT 1`
);

const stmtFallback = db.prepare(
  `SELECT value_clp, as_of_date FROM valuations
   WHERE account_id = ?
   ORDER BY as_of_date DESC LIMIT 1`
);

/** Latest valuation on or before `asOfYmd`. Returns `undefined` when the account has no history yet. */
export function latestValuationRowOnOrBefore(
  accountId: number,
  asOfYmd: string
): LatestValuationRow | undefined {
  if (!Number.isFinite(accountId) || accountId <= 0) return undefined;
  return stmtOnOrBefore.get(accountId, asOfYmd) as LatestValuationRow | undefined;
}

/**
 * Latest valuation on or before Chile today. Falls back to the absolute latest row only for the
 * current snapshot (e.g. account with only a future month-end placeholder).
 */
export function latestValuationRowOnOrBeforeChileToday(accountId: number): LatestValuationRow | undefined {
  if (!Number.isFinite(accountId) || accountId <= 0) return undefined;
  const today = chileCalendarTodayYmd();
  const row = stmtOnOrBefore.get(accountId, today) as LatestValuationRow | undefined;
  if (row) return row;
  return stmtFallback.get(accountId) as LatestValuationRow | undefined;
}
