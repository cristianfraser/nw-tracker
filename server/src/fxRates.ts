import { db } from "./db.js";

/** Single FX row used for CLP↔USD (charts, bolsa flows, dashboard). */
export function fxRowOnOrBefore(date: string | null): { date: string; clp_per_usd: number } | null {
  if (!date) return null;
  return (
    (db
      .prepare(`SELECT date, clp_per_usd FROM fx_daily WHERE date <= ? ORDER BY date DESC LIMIT 1`)
      .get(date) as { date: string; clp_per_usd: number } | undefined) ?? null
  );
}

export function ufRowOnOrBefore(date: string | null): { date: string; clp_per_uf: number } | null {
  if (!date) return null;
  return (
    (db
      .prepare(`SELECT date, clp_per_uf FROM uf_daily WHERE date <= ? ORDER BY date DESC LIMIT 1`)
      .get(date) as { date: string; clp_per_uf: number } | undefined) ?? null
  );
}

/**
 * Official UF (CLP per 1 UF) from `uf_daily` at each snapshot label — last row on or before each date.
 * Used for mortgage cierre / UF día (not duplicated from the depto dividendos sheet).
 */
export function ufClpBySnapshotDatesAsc(datesAsc: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (datesAsc.length === 0) return out;
  const rows = db
    .prepare(`SELECT date, clp_per_uf FROM uf_daily ORDER BY date ASC`)
    .all() as { date: string; clp_per_uf: number }[];
  if (rows.length === 0) return out;
  let j = 0;
  let last: number | null = null;
  for (const d of datesAsc) {
    while (j < rows.length && rows[j]!.date <= d) {
      last = rows[j]!.clp_per_uf;
      j += 1;
    }
    if (last != null && Number.isFinite(last)) out.set(d, last);
  }
  return out;
}
