/**
 * The UF ahead of its publication, shared by everything that prices a future day in UF
 * («Próximos pagos», declared UF payments, the expense lines' declared-payment names).
 */
import { db } from "./db.js";
import { addDays, daysBetween } from "./recurringPaymentMatch.js";

export type UfLookup = (ymd: string) => { date: string; clp_per_uf: number } | null;

/**
 * The UF on a day: the published value on or before it, or — past the last published day — the
 * last value grown at the last twelve months' rate (a rough estimate the user asked for). Throws
 * when the series has no year of history to take the rate from.
 */
export function projectedUfClp(ymd: string, latest: { date: string; clp_per_uf: number }, lookup: UfLookup): number {
  if (ymd <= latest.date) {
    const row = lookup(ymd);
    if (!row) throw new Error(`No UF on or before ${ymd}`);
    return row.clp_per_uf;
  }
  const yearAgo = lookup(addDays(latest.date, -365));
  if (!yearAgo) throw new Error(`No UF a year before ${latest.date} to project from`);
  const growth = latest.clp_per_uf / yearAgo.clp_per_uf;
  return latest.clp_per_uf * growth ** (daysBetween(latest.date, ymd) / 365);
}

const latestUfStmt = db.prepare(`SELECT date, clp_per_uf FROM uf_daily ORDER BY date DESC LIMIT 1`);
const ufOnOrBeforeStmt = db.prepare(`SELECT date, clp_per_uf FROM uf_daily WHERE date <= ? ORDER BY date DESC LIMIT 1`);

/** UF on a day (published, or projected past the last published one) and that last published day. */
export function ufProjector(): { ufOn: (ymd: string) => number; knownThrough: string } {
  const latest = latestUfStmt.get() as { date: string; clp_per_uf: number } | undefined;
  if (!latest) throw new Error("uf_daily is empty");
  const lookup: UfLookup = (ymd) => (ufOnOrBeforeStmt.get(ymd) as { date: string; clp_per_uf: number } | undefined) ?? null;
  return { ufOn: (ymd) => projectedUfClp(ymd, latest, lookup), knownThrough: latest.date };
}
