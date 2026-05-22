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

/** Bucket cards under `net_worth`, flattening `nav_hub` children (e.g. inversiones → brokerage + retirement). */
const netWorthBucketCardsQuery = `
  SELECT c.slug, c.label,
         COALESCE(c.dashboard_card_label_i18n_key, c.label_i18n_key) AS label_i18n_key,
         c.dashboard_sort_order AS sort_order,
         c.dashboard_bucket_slug AS bucket_slug,
         c.dashboard_card_css AS card_css,
         c.route_path
  FROM portfolio_groups p
  JOIN portfolio_group_items i ON i.group_id = p.id AND i.item_kind = 'group'
  JOIN portfolio_groups child ON child.id = i.child_group_id
  LEFT JOIN portfolio_group_items i2
    ON i2.group_id = child.id AND i2.item_kind = 'group' AND child.group_kind = 'nav_hub'
  JOIN portfolio_groups c ON c.id = COALESCE(i2.child_group_id, child.id)
  WHERE p.slug = 'net_worth'
    AND c.dashboard_bucket_slug IS NOT NULL
  ORDER BY c.dashboard_sort_order ASC, c.id ASC
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
