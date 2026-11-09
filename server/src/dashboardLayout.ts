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

/**
 * Ordered bucket cards for the dashboard (Patrimonio neto hero stays client-first).
 * First-level children of the `net_worth` portfolio group; an unseeded tree is an error.
 */
export function getDashboardLayoutCards(): DashboardLayoutCardRow[] {
  const cards = db.prepare(netWorthBucketCardsQuery).all() as DashboardLayoutCardRow[];
  if (cards.length === 0) throw new Error("dashboard layout: the net_worth nav tree has no bucket cards (seedNavTree)");
  return cards;
}
