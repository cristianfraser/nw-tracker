import { db } from "./db.js";

/** Σ `movements.units_delta` for Fintual certificate / flow rows. */
export function fintualGoalUnitsFromMovements(accountId: number): number | null {
  if (!Number.isFinite(accountId) || accountId <= 0) return null;
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(units_delta), 0) AS u FROM movements
       WHERE account_id = ? AND units_delta IS NOT NULL`
    )
    .get(accountId) as { u: number } | undefined;
  const u = row?.u;
  if (u == null || !Number.isFinite(u) || u <= 0) return null;
  return Math.round(u * 1e4) / 1e4;
}
