import { db } from "./db.js";

export type DashboardLayoutCardRow = {
  slug: string;
  label: string;
  label_i18n_key: string | null;
  sort_order: number;
  bucket_slug: string;
  card_css: string | null;
};

const fallbackBucketCardsQuery = `
  SELECT slug, label,
         COALESCE(dashboard_card_label_i18n_key, label_i18n_key) AS label_i18n_key,
         dashboard_sort_order AS sort_order,
         dashboard_bucket_slug AS bucket_slug,
         dashboard_card_css AS card_css
  FROM portfolio_groups
  WHERE dashboard_sort_order IS NOT NULL
    AND dashboard_card_kind = 'bucket'
    AND dashboard_bucket_slug IS NOT NULL
  ORDER BY dashboard_sort_order ASC, id ASC
`;

const netWorthChildrenQuery = `
  SELECT c.slug, c.label,
         COALESCE(c.dashboard_card_label_i18n_key, c.label_i18n_key) AS label_i18n_key,
         i.sort_order AS sort_order,
         c.dashboard_bucket_slug AS bucket_slug,
         c.dashboard_card_css AS card_css
  FROM portfolio_groups p
  JOIN portfolio_group_items i ON i.group_id = p.id AND i.item_kind = 'group'
  JOIN portfolio_groups c ON c.id = i.child_group_id
  WHERE p.slug = 'net_worth'
    AND c.dashboard_bucket_slug IS NOT NULL
  ORDER BY i.sort_order ASC, c.id ASC
`;

const legacyBucketCardsQuery = `
  SELECT slug, label, label_i18n_key,
         dashboard_sort_order AS sort_order,
         dashboard_bucket_slug AS bucket_slug,
         dashboard_card_css AS card_css
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
    const fromNetWorth = db.prepare(netWorthChildrenQuery).all() as DashboardLayoutCardRow[];
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
