import { whenNoApiRequestsInFlight } from "./apiRequestsInFlight.js";
import { db } from "./db.js";
import { accountDailyPctPoints, groupDailyPctPoints } from "./dailyPctSeries.js";
import { accountIsDebt } from "./accountProfile.js";

/**
 * The full-history daily RETURNS every Rentabilidad table chains (`periodReturnsDaily.ts`), the
 * own-portfolio benchmarks read and every period % compounds (`periodPctDailyChain.ts`: the
 * dashboard account rows and nav groups, the detalle tables) — `dailyPctSeries.ts`, which keeps
 * only each day's pct, never the full payload: every portfolio group page, net worth (the home
 * page) and every account that is not a liability, in CLP and USD (the per-account marks are
 * shared by both units, so USD adds only its own sums and conversions). Each scope waits until no API request is in flight (`apiRequestsInFlight.ts`), so
 * requests run ahead of the warm instead of waiting behind it. A scope already cached
 * costs nothing; after a live-quote tick only today's marks recompute.
 */
export async function warmRentabilidadDailySeries(): Promise<number> {
  const groups = (
    db
      .prepare(`SELECT slug FROM portfolio_groups WHERE group_kind IN ('bucket', 'nav_bucket') ORDER BY id`)
      .all() as { slug: string }[]
  )
    .map((r) => r.slug);
  for (const slug of ["inversiones", "net_worth"]) if (!groups.includes(slug)) groups.push(slug);
  const accounts = (
    db
      .prepare(
        `SELECT a.id AS account_id, a.name, g.slug AS bucket_slug, a.import_key
         FROM accounts a JOIN asset_groups g ON g.id = a.asset_group_id ORDER BY a.id`
      )
      .all() as { account_id: number; name: string | null; bucket_slug: string; import_key: string | null }[]
  ).filter((a) => !accountIsDebt(a.account_id));

  let scopes = 0;
  const yieldToRequests = () => whenNoApiRequestsInFlight();
  for (const unit of ["clp", "usd"] as const) {
    for (const slug of groups) {
      await yieldToRequests();
      if (groupDailyPctPoints(slug, unit)) scopes += 1;
    }
    for (const a of accounts) {
      await yieldToRequests();
      accountDailyPctPoints(a, unit);
      scopes += 1;
    }
  }
  return scopes;
}
