import { db } from "./db.js";

export type DashboardLayoutCardRow = {
  slug: string;
  label: string;
  label_i18n_key: string | null;
  sort_order: number;
  bucket_slug: string;
  card_css: string | null;
  route_path: string | null;
};

const fallbackBucketCardsQuery = `
  SELECT slug, label,
         COALESCE(dashboard_card_label_i18n_key, label_i18n_key) AS label_i18n_key,
         dashboard_sort_order AS sort_order,
         dashboard_bucket_slug AS bucket_slug,
         dashboard_card_css AS card_css,
         route_path
  FROM portfolio_groups
  WHERE dashboard_sort_order IS NOT NULL
    AND dashboard_card_kind = 'bucket'
    AND dashboard_bucket_slug IS NOT NULL
  ORDER BY dashboard_sort_order ASC, id ASC
`;

/** Bucket cards under `net_worth`: unwrap `nav_bucket` nodes (inversiones → brokerage + retirement; cash_eqs → cash_savings). */
const netWorthBucketCardsQuery = `
  WITH RECURSIVE nw_tree(id, slug, group_kind, depth) AS (
    SELECT pg.id, pg.slug, pg.group_kind, 0
    FROM portfolio_groups pg
    WHERE pg.slug = 'net_worth'
    UNION ALL
    SELECT c.id, c.slug, c.group_kind, t.depth + 1
    FROM nw_tree t
    JOIN portfolio_group_items i ON i.group_id = t.id AND i.item_kind = 'group'
    JOIN portfolio_groups c ON c.id = i.child_group_id
  )
  SELECT pg.slug, pg.label,
         COALESCE(pg.dashboard_card_label_i18n_key, pg.label_i18n_key) AS label_i18n_key,
         pg.dashboard_sort_order AS sort_order,
         pg.dashboard_bucket_slug AS bucket_slug,
         pg.dashboard_card_css AS card_css,
         pg.route_path
  FROM nw_tree t
  JOIN portfolio_groups pg ON pg.id = t.id
  WHERE pg.dashboard_bucket_slug IS NOT NULL
    AND pg.dashboard_sort_order IS NOT NULL
    AND t.slug != 'net_worth'
  ORDER BY pg.dashboard_sort_order ASC, pg.id ASC
`;

const legacyBucketCardsQuery = `
  SELECT slug, label, label_i18n_key,
         dashboard_sort_order AS sort_order,
         dashboard_bucket_slug AS bucket_slug,
         dashboard_card_css AS card_css,
         route_path
  FROM portfolio_groups
  WHERE dashboard_sort_order IS NOT NULL
    AND dashboard_card_kind = 'bucket'
    AND dashboard_bucket_slug IS NOT NULL
  ORDER BY dashboard_sort_order ASC, id ASC
`;

/**
 * Ordered bucket cards for the dashboard (Patrimonio neto hero stays client-first).
 * Prefers first-level children of the `net_worth` portfolio group; otherwise rows with `dashboard_sort_order`.
 */
export function getDashboardLayoutCards(): DashboardLayoutCardRow[] {
  try {
    const fromNetWorth = db.prepare(netWorthBucketCardsQuery).all() as DashboardLayoutCardRow[];
    if (fromNetWorth.length > 0) return fromNetWorth;
  } catch (e) {
    console.warn("dashboard_layout: net_worth children query failed.", e);
  }
  try {
    return db.prepare(fallbackBucketCardsQuery).all() as DashboardLayoutCardRow[];
  } catch {
    try {
      return db.prepare(legacyBucketCardsQuery).all() as DashboardLayoutCardRow[];
    } catch (e2) {
      console.warn("dashboard_layout: portfolio_groups dashboard columns missing; run migrations.", e2);
      return [];
    }
  }
}
