import { db } from "./db.js";
import { transferLegUnitsThroughDate } from "./movementTransfer.js";
import { chileCalendarTodayYmd } from "./chileDate.js";

/** Σ `movements.units_delta` for Fintual certificate / flow rows. */
export function fintualGoalUnitsFromMovements(accountId: number): number | null {
  return fintualGoalUnitsFromMovementsThroughDate(accountId);
}

/**
 * Σ Fintual cuotas through an optional as-of date (`YYYY-MM-DD`): certificate/flow rows on the
 * account plus manual `checking → fund` transfer legs (aportes/retiros entered by hand).
 */
export function fintualGoalUnitsFromMovementsThroughDate(
  accountId: number,
  asOfYmd?: string
): number | null {
  if (!Number.isFinite(accountId) || accountId <= 0) return null;
  const row =
    asOfYmd && /^\d{4}-\d{2}-\d{2}$/.test(asOfYmd)
      ? (db
          .prepare(
            `SELECT COALESCE(SUM(units_delta), 0) AS u FROM movements
             WHERE account_id = ? AND units_delta IS NOT NULL AND date(occurred_on) <= date(?)`
          )
          .get(accountId, asOfYmd) as { u: number } | undefined)
      : (db
          .prepare(
            `SELECT COALESCE(SUM(units_delta), 0) AS u FROM movements
             WHERE account_id = ? AND units_delta IS NOT NULL`
          )
          .get(accountId) as { u: number } | undefined);
  const ledger = row?.u ?? 0;
  const asOf = asOfYmd && /^\d{4}-\d{2}-\d{2}$/.test(asOfYmd) ? asOfYmd : chileCalendarTodayYmd();
  const u = ledger + transferLegUnitsThroughDate(accountId, asOf);
  if (!Number.isFinite(u) || u <= 0) return null;
  return Math.round(u * 1e4) / 1e4;
}
