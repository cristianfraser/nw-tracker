import { db } from "../db.js";

/**
 * Override `fx_daily` rows for specific dates and return a restore function — tests that
 * INSERT OR REPLACE fixed rates must put the generated rows back (a clobbered rate leaks
 * into every later conversion on the shared test DB).
 */
export function overrideFxDaily(rows: ReadonlyArray<[date: string, clpPerUsd: number]>): () => void {
  const saved = rows.map(([date]) => ({
    date,
    prior: db.prepare(`SELECT clp_per_usd FROM fx_daily WHERE date = ?`).get(date) as
      | { clp_per_usd: number }
      | undefined,
  }));
  const upsert = db.prepare(`INSERT OR REPLACE INTO fx_daily (date, clp_per_usd) VALUES (?, ?)`);
  for (const [date, clp] of rows) upsert.run(date, clp);
  return () => {
    for (const { date, prior } of saved) {
      if (prior) upsert.run(date, prior.clp_per_usd);
      else db.prepare(`DELETE FROM fx_daily WHERE date = ?`).run(date);
    }
  };
}
