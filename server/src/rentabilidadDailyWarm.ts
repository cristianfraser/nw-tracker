import { db } from "./db.js";
import { resolveAccountDailySeries, resolveGroupDailySeries } from "./groupDailySeries.js";
import { isInvestmentPerformanceAccount, isInvestmentPerformanceGroupSlug } from "./portfolioGroupTree.js";

/**
 * The full-history daily series every Rentabilidad table chains (`periodReturnsDaily.ts`) and the
 * own-portfolio benchmarks read: each investment group page and each investment account, in CLP
 * (the default display unit; USD builds on first use). Built one scope per macrotask, so
 * requests interleave with the warm instead of waiting behind all of it. A scope already cached
 * costs nothing; after a live-quote tick only today's marks recompute.
 */
export async function warmRentabilidadDailySeries(): Promise<number> {
  const groups = (
    db
      .prepare(`SELECT slug FROM portfolio_groups WHERE group_kind IN ('bucket', 'nav_bucket') ORDER BY id`)
      .all() as { slug: string }[]
  )
    .map((r) => r.slug)
    .filter((slug) => isInvestmentPerformanceGroupSlug(slug));
  if (!groups.includes("inversiones")) groups.push("inversiones");
  const accounts = (
    db
      .prepare(
        `SELECT a.id AS account_id, a.name, g.slug AS bucket_slug, a.import_key
         FROM accounts a JOIN asset_groups g ON g.id = a.asset_group_id ORDER BY a.id`
      )
      .all() as { account_id: number; name: string | null; bucket_slug: string; import_key: string | null }[]
  ).filter((a) => isInvestmentPerformanceAccount(a.account_id));

  let scopes = 0;
  const yieldToRequests = () => new Promise<void>((resolve) => setImmediate(resolve));
  for (const slug of groups) {
    await yieldToRequests();
    if (resolveGroupDailySeries(slug, "clp", 0)) scopes += 1;
  }
  for (const a of accounts) {
    await yieldToRequests();
    resolveAccountDailySeries(a, "clp", 0);
    scopes += 1;
  }
  return scopes;
}
