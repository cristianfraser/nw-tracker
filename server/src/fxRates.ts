import { db } from "./db.js";

export type FxRow = { date: string; clp_per_usd: number };

export type FxLookupOptions = {
  /**
   * When true, only month-end `fx_daily` rows are considered (official monthly snapshots).
   * Falls back to any row on or before the date if no month-end row exists.
   */
  monthEndOnly?: boolean;
};

const stmtAny = db.prepare(
  `SELECT date, clp_per_usd FROM fx_daily WHERE date <= ? ORDER BY date DESC LIMIT 1`
);

const stmtMonthEnd = db.prepare(
  `SELECT date, clp_per_usd FROM fx_daily
   WHERE date <= ?
     AND date = date(date, 'start of month', '+1 month', '-1 day')
   ORDER BY date DESC LIMIT 1`
);

/** First month-end `fx_daily` row on or after `date` (when the series starts after snapshot dates). */
const stmtMonthEndOnOrAfter = db.prepare(
  `SELECT date, clp_per_usd FROM fx_daily
   WHERE date >= ?
     AND date = date(date, 'start of month', '+1 month', '-1 day')
   ORDER BY date ASC LIMIT 1`
);

/** Single FX row used for CLP↔USD (charts, bolsa flows, dashboard). */
export function fxRowOnOrBefore(
  date: string | null,
  opts?: FxLookupOptions
): FxRow | null {
  if (!date) return null;
  if (opts?.monthEndOnly) {
    const row = (stmtMonthEnd.get(date) as FxRow | undefined) ?? null;
    if (row) return row;
  }
  return (stmtAny.get(date) as FxRow | undefined) ?? null;
}

/**
 * CLP→USD for balances, charts, and dashboard `current_value_usd`.
 * Prefers Banco Central **daily** observado (`fxRowOnOrBefore`) so Chile holidays still use the last
 * published tipo de cambio. Falls back to month-end-only rows for legacy Excel imports, then the
 * earliest month-end on or after `date` when the series starts after snapshot dates.
 */
export function fxMonthEndForBalanceUsd(date: string | null): FxRow | null {
  if (!date) return null;
  const observado = fxRowOnOrBefore(date);
  if (observado) return observado;
  const prior = (stmtMonthEnd.get(date) as FxRow | undefined) ?? null;
  if (prior) return prior;
  return (stmtMonthEndOnOrAfter.get(date) as FxRow | undefined) ?? null;
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
