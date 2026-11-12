/**
 * The Banco Central's observado for a foreign currency, in pesos per unit: what the SII converts a
 * persona natural's foreign-currency purchases and sales at («según el tipo de cambio observado de
 * la moneda que se trate, publicado por el Banco Central», Oficio 2573/2022; Oficio 233/2018 for
 * the dollar). The dollar's is `fx_daily_bcentral` (synced by `sbif_usd`), the euro's `eur_daily`
 * (Banco Central's euro, synced by `sbif_eur`). A currency the Banco Central does not publish
 * here throws, naming it — never a market rate in its place.
 */
import { db } from "./db.js";

/** Days the observado may lag a date (weekends and holidays carry the last published value). */
export const OBSERVADO_MAX_CARRY_DAYS = 7;

const OBSERVADO_SERIES: Readonly<Record<string, { table: string; column: string; sync: string; name: string }>> = {
  usd: { table: "fx_daily_bcentral", column: "clp_per_usd", sync: "sbif_usd", name: "dólar observado" },
  eur: { table: "eur_daily", column: "clp_per_eur", sync: "sbif_eur", name: "euro observado" },
};

const statements = new Map<string, ReturnType<typeof db.prepare>>();

/** The observado of `currency` in force on `ymd` (the last one published on or before it); throws past the carry limit. */
export function observadoClpOnOrBefore(currency: string, ymd: string): number {
  const series = OBSERVADO_SERIES[currency];
  if (!series) {
    throw new Error(`The Banco Central publishes no observado for ${currency.toUpperCase()} in the app — it cannot be priced in pesos`);
  }
  let stmt = statements.get(currency);
  if (!stmt) {
    stmt = db.prepare(`SELECT date, ${series.column} AS clp FROM ${series.table} WHERE date <= ? ORDER BY date DESC LIMIT 1`);
    statements.set(currency, stmt);
  }
  const r = stmt.get(ymd) as { date: string; clp: number } | undefined;
  const name = series.name;
  if (!r) throw new Error(`No ${name} on or before ${ymd}`);
  const gapDays = (Date.parse(`${ymd}T00:00:00Z`) - Date.parse(`${r.date}T00:00:00Z`)) / 86_400_000;
  if (gapDays > OBSERVADO_MAX_CARRY_DAYS) {
    throw new Error(`${name[0]!.toUpperCase()}${name.slice(1)} for ${ymd}: the latest is ${r.date}, ${gapDays} days earlier — sync ${series.sync}`);
  }
  return r.clp;
}

/** The dólar observado in force on `ymd`. */
export function dollarObservadoOnOrBefore(ymd: string): number {
  return observadoClpOnOrBefore("usd", ymd);
}
