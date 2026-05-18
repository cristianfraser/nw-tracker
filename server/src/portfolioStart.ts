import { db } from "./db.js";

/** Earliest `YYYY-MM-DD` touch in DB, or `PORTFOLIO_START_YMD` env, or fallback. */
export function portfolioStartYmd(): string {
  const env = process.env.PORTFOLIO_START_YMD?.trim();
  if (env && /^\d{4}-\d{2}-\d{2}$/.test(env)) return env;
  const m = db
    .prepare(
      `SELECT MIN(s) AS d FROM (
         SELECT MIN(occurred_on) AS s FROM movements
         UNION ALL SELECT MIN(as_of_date) FROM valuations
       )`
    )
    .get() as { d: string | null } | undefined;
  if (m?.d && /^\d{4}-\d{2}-\d{2}$/.test(m.d)) return m.d;
  return "2010-01-01";
}
