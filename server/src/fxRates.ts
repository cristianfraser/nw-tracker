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
