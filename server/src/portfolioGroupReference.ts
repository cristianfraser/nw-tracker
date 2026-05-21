/**
 * Chart reference lines built from `portfolio_groups` with `group_kind = 'reference'`
 * and `portfolio_group_items` with `item_kind = 'linked_group'` (weighted child groups).
 */
import { db } from "./db.js";
import { rgbTripletToCss } from "./chartColorRgb.js";

export type ReferenceGroupDef = {
  id: number;
  slug: string;
  label: string;
  label_i18n_key: string | null;
  color_rgb: string | null;
  dataKey: string;
  chart_account_id: number;
  links: { source_slug: string; weight: number }[];
};

export type ReferenceAccountLine = {
  account_id: number;
  name: string;
  dataKey: string;
  valueSeriesType: "reference";
  color_rgb?: string;
};

const linkedGroupsStmt = db.prepare(
  `SELECT g.slug AS source_slug, i.link_weight AS weight
   FROM portfolio_group_items i
   JOIN portfolio_groups g ON g.id = i.child_group_id
   WHERE i.group_id = ? AND i.item_kind = 'linked_group'
   ORDER BY i.sort_order, i.id`
);

const referenceGroupsStmt = db.prepare(
  `SELECT id, slug, label, label_i18n_key, color_rgb
   FROM portfolio_groups
   WHERE group_kind = 'reference' AND chart_host_slug = ?
   ORDER BY sort_order, id`
);

export function listReferenceGroupsForChartHost(chartHostSlug: string): ReferenceGroupDef[] {
  const rows = referenceGroupsStmt.all(chartHostSlug) as {
    id: number;
    slug: string;
    label: string;
    label_i18n_key: string | null;
    color_rgb: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    label: r.label,
    label_i18n_key: r.label_i18n_key,
    color_rgb: r.color_rgb,
    dataKey: `ref:${r.slug}`,
    chart_account_id: -10_000 - r.id,
    links: linkedGroupsStmt.all(r.id) as { source_slug: string; weight: number }[],
  }));
}

/** Compose reference series from precomputed source-group totals (date → value). */
export function composeReferenceValuesByDate(
  defs: ReferenceGroupDef[],
  totalsBySourceSlug: Map<string, Map<string, number>>,
  datesAsc: string[]
): Map<string, Map<string, number>> {
  const valuesByDataKey = new Map<string, Map<string, number>>();
  for (const def of defs) {
    const byDate = new Map<string, number>();
    for (const d of datesAsc) byDate.set(d, 0);
    for (const link of def.links) {
      const src = totalsBySourceSlug.get(link.source_slug);
      if (!src) continue;
      const w = Number.isFinite(link.weight) ? link.weight : 1;
      for (const d of datesAsc) {
        const part = src.get(d);
        if (part != null && Number.isFinite(part)) {
          byDate.set(d, (byDate.get(d) ?? 0) + part * w);
        }
      }
    }
    valuesByDataKey.set(def.dataKey, byDate);
  }
  return valuesByDataKey;
}

export function referenceGroupStrokeCss(def: ReferenceGroupDef): string | undefined {
  return def.color_rgb ? rgbTripletToCss(def.color_rgb) : undefined;
}

export function portfolioGroupApiForValuation(slug: string): {
  groupSlug: string;
  tabSubgroup: string | undefined;
} {
  const row = db
    .prepare(
      `SELECT slug, api_group, asset_group_slug, api_subgroup FROM portfolio_groups WHERE slug = ?`
    )
    .get(slug) as
    | { slug: string; api_group: string | null; asset_group_slug: string | null; api_subgroup: string | null }
    | undefined;
  if (!row) return { groupSlug: slug, tabSubgroup: undefined };
  return {
    groupSlug: row.api_group ?? row.asset_group_slug ?? row.slug,
    tabSubgroup: row.api_subgroup ?? undefined,
  };
}
