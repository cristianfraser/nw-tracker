import { db } from "./db.js";
import { leafPortfolioGroupSlugByAccountIds } from "./portfolioGroupTree.js";
import { listAccountsForGroupTab } from "./valuationTimeseries.js";

/**
 * `GET /api/accounts?portfolio_group=…` — all group members for charts/tables (includes `chart_inactive`).
 */
export async function listPortfolioGroupAccountsForApi(
  portfolioGroupSlug: string,
  _includeUsd: boolean
): Promise<Record<string, unknown>[]> {
  const tabRows = listAccountsForGroupTab(portfolioGroupSlug);
  if (!tabRows.length) return [];

  const inactiveById = new Map(tabRows.map((r) => [r.account_id, r.chart_inactive === true]));
  const leafGroupSlugById = leafPortfolioGroupSlugByAccountIds(tabRows.map((r) => r.account_id));

  const ph = tabRows.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT a.id, a.name, a.notes, a.created_at, a.exclude_from_group_totals, a.color_rgb,
              a.source_account_id, g.slug AS bucket_slug, g.label AS bucket_label
       FROM accounts a
       INNER JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE a.id IN (${ph})
       ORDER BY g.sort_order, a.id, a.name`
    )
    .all(...tabRows.map((r) => r.account_id)) as Record<string, unknown>[];

  return rows.map((row) => ({
    ...row,
    group_slug: leafGroupSlugById.get(row.id as number) ?? row.bucket_slug,
    chart_inactive: inactiveById.get(row.id as number) ?? false,
  }));
}
