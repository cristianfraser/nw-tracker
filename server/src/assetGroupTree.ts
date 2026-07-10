import { accountIdsInPortfolioGroup, portfolioGroupBySlug } from "./portfolioGroupTree.js";
import { db } from "./db.js";

export type AssetGroupRow = {
  id: number;
  slug: string;
  label: string;
  sort_order: number;
  parent_id: number | null;
};

const groupBySlugStmt = db.prepare(
  `SELECT id, slug, label, sort_order, parent_id FROM asset_groups WHERE slug = ?`
);

const childCountStmt = db.prepare(
  `SELECT COUNT(*) AS c FROM asset_groups WHERE parent_id = ?`
);


export function assetGroupBySlug(slug: string): AssetGroupRow | null {
  return (groupBySlugStmt.get(slug) as AssetGroupRow | undefined) ?? null;
}

const leafAssetGroupForKindStmt = db.prepare(
  `SELECT id, slug FROM asset_groups
   WHERE slug = ? OR slug LIKE '%\_\_' || ? ESCAPE '\\'
   ORDER BY LENGTH(slug) DESC, id DESC
   LIMIT 1`
);

/**
 * Leaf `asset_groups.id` for a category/kind slug (e.g. `afc` → `retirement_afp_afc__afc`).
 * Uses escaped `__` in LIKE — unescaped `_` is a single-char wildcard and would match parent buckets like `retirement_afp_afc`.
 */
export function leafAssetGroupIdForKindSlug(kindSlug: string): number {
  const row = leafAssetGroupForKindStmt.get(kindSlug, kindSlug) as
    | { id: number; slug: string }
    | undefined;
  if (!row) throw new Error(`no leaf asset group for kind ${kindSlug}`);
  return row.id;
}

export function leafAssetGroupSlugForKindSlug(kindSlug: string): string {
  const row = leafAssetGroupForKindStmt.get(kindSlug, kindSlug) as
    | { id: number; slug: string }
    | undefined;
  if (!row) throw new Error(`no leaf asset group for kind ${kindSlug}`);
  return row.slug;
}

export function isLeafAssetGroupId(groupId: number): boolean {
  const row = childCountStmt.get(groupId) as { c: number };
  return row.c === 0;
}

export function isLeafAssetGroupSlug(slug: string): boolean {
  const g = assetGroupBySlug(slug);
  return g != null && isLeafAssetGroupId(g.id);
}

/** All asset_group ids in the subtree rooted at `rootSlug` (includes root). */
export function assetGroupIdsInSubtree(rootSlug: string): number[] {
  const root = assetGroupBySlug(rootSlug);
  if (!root) return [];
  const rows = db
    .prepare(
      `WITH RECURSIVE tree(id) AS (
         SELECT id FROM asset_groups WHERE id = ?
         UNION ALL
         SELECT c.id FROM asset_groups c
         INNER JOIN tree t ON c.parent_id = t.id
       )
       SELECT id FROM tree`
    )
    .all(root.id) as { id: number }[];
  return rows.map((r) => r.id);
}

/** Leaf bucket ids under `rootSlug` (descendants that hold accounts). */
export function leafAssetGroupIdsUnder(rootSlug: string): number[] {
  const ids = assetGroupIdsInSubtree(rootSlug);
  return ids.filter((id) => isLeafAssetGroupId(id));
}

export function leafAssetGroupSlugsUnder(rootSlug: string): string[] {
  const ids = leafAssetGroupIdsUnder(rootSlug);
  if (ids.length === 0) return [];
  const ph = ids.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT slug FROM asset_groups WHERE id IN (${ph}) ORDER BY sort_order, id`)
    .all(...ids) as { slug: string }[];
  return rows.map((r) => r.slug);
}

/** Slugs used for `group=inversiones` tab (all brokerage + retirement leaves). */
export function inversionesLeafBucketSlugs(): string[] {
  const bro = leafAssetGroupSlugsUnder("brokerage");
  const ret = leafAssetGroupSlugsUnder("retirement");
  return [...bro, ...ret];
}

/** Cash & equivalents sub-buckets (migration 078). */
export const CHECKING_ACCOUNTS_BUCKET = "cash_eqs__checking_accounts";
export const CASH_SAVINGS_BUCKET = "cash_eqs__cash_savings";
export const CHECKING_ACCOUNTS_KIND = "checking_accounts";
export const CASH_SAVINGS_KIND = "cash_savings";

/** NW dashboard charts / consolidation: cash_eqs hub or ahorros leaf (linked CC netting). */
export function isCashSavingsValuationGroupSlug(groupSlug: string): boolean {
  return groupSlug === CASH_SAVINGS_KIND || groupSlug === CASH_SAVINGS_BUCKET;
}

export function isCashEqsNwValuationGroupSlug(groupSlug: string): boolean {
  return groupSlug === "cash_eqs" || isCashSavingsValuationGroupSlug(groupSlug);
}

function assetGroupKindSlug(slug: string): string {
  const sep = slug.lastIndexOf("__");
  return sep >= 0 ? slug.slice(sep + 2) : slug;
}

/** @internal test hook */
export function invalidateDashboardBucketCache(): void {
  dashboardBucketBySlugCache = null;
}

/** Leaf kind slugs for cartola checking accounts (corriente + vista). */
export function isCheckingAccountKindSlug(kindOrLeafSlug: string): boolean {
  const kind = assetGroupKindSlug(kindOrLeafSlug);
  return kind === "cuenta_corriente" || kind === "cuenta_vista";
}

export function listCheckingAccountRows(
  excludeLegacyStocksNote: string
): BucketAccountRow[] {
  return listAccountsForBucketSlug(CHECKING_ACCOUNTS_BUCKET, undefined, excludeLegacyStocksNote);
}

export function listCashSavingsAccountRows(
  excludeLegacyStocksNote: string
): BucketAccountRow[] {
  return listAccountsForBucketSlug(CASH_SAVINGS_BUCKET, undefined, excludeLegacyStocksNote);
}

/** Top-level net-worth dashboard card buckets (asset_groups roots for NW cards). */
export const DASHBOARD_NW_BUCKET_SLUGS = new Set([
  "real_estate",
  "retirement",
  "brokerage",
  "cash_eqs",
]);

type AssetGroupParentRow = { id: number; slug: string; parent_id: number | null };

let dashboardBucketBySlugCache: Map<string, string | null> | null = null;

function buildDashboardBucketBySlugCache(): Map<string, string | null> {
  const rows = db
    .prepare(`SELECT id, slug, parent_id FROM asset_groups`)
    .all() as AssetGroupParentRow[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const cache = new Map<string, string | null>();

  for (const row of rows) {
    let cur: AssetGroupParentRow | undefined = row;
    let underCashEqs = false;
    const seen = new Set<number>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      const kind = assetGroupKindSlug(cur.slug);
      if (
        cur.slug === "cash_eqs" ||
        kind === "cash_eqs" ||
        kind === CHECKING_ACCOUNTS_KIND ||
        kind === CASH_SAVINGS_KIND
      ) {
        underCashEqs = true;
        break;
      }
      cur = cur.parent_id != null ? byId.get(cur.parent_id) : undefined;
    }
    let dashboard: string | null = null;
    if (underCashEqs) {
      dashboard = "cash_eqs";
    } else if (row.slug === "cash_eqs" || assetGroupKindSlug(row.slug) === "cash_eqs") {
      dashboard = null;
    } else {
      cur = row;
      seen.clear();
      while (cur && !seen.has(cur.id)) {
        seen.add(cur.id);
        if (DASHBOARD_NW_BUCKET_SLUGS.has(cur.slug) && cur.slug !== "cash_eqs") {
          dashboard = cur.slug;
          break;
        }
        cur = cur.parent_id != null ? byId.get(cur.parent_id) : undefined;
      }
    }
    cache.set(row.slug, dashboard);
  }
  return cache;
}

function dashboardBucketBySlugMap(): Map<string, string | null> {
  if (!dashboardBucketBySlugCache) {
    dashboardBucketBySlugCache = buildDashboardBucketBySlugCache();
  }
  return dashboardBucketBySlugCache;
}

/** Walk `asset_groups.parent_id` to the NW dashboard bucket slug, if any. */
export function dashboardBucketForAssetGroupSlug(slug: string): string | null {
  return dashboardBucketBySlugMap().get(slug) ?? null;
}

export function accountBelongsToDashboardBucket(
  row: {
    bucket_slug?: string | null;
    group_slug: string;
    dashboard_bucket_slug?: string | null;
  },
  dashboardBucket: string
): boolean {
  if (row.dashboard_bucket_slug != null && row.dashboard_bucket_slug !== "") {
    return row.dashboard_bucket_slug === dashboardBucket;
  }
  const placement = row.bucket_slug ?? row.group_slug;
  return dashboardBucketForAssetGroupSlug(placement) === dashboardBucket;
}

export function requireLeafAssetGroupId(slug: string): number {
  const g = assetGroupBySlug(slug);
  if (!g) throw new Error(`unknown asset group slug: ${slug}`);
  if (!isLeafAssetGroupId(g.id)) {
    throw new Error(`asset group ${slug} is not a leaf bucket`);
  }
  return g.id;
}

export type BucketAccountRow = {
  account_id: number;
  name: string;
  bucket_slug: string;
  bucket_label: string;
  notes: string | null;
  exclude_from_group_totals: number;
};

const LIST_BY_BUCKET_IDS = `
  SELECT a.id AS account_id, a.name,
         g.slug AS bucket_slug, g.label AS bucket_label,
         a.notes AS notes,
         a.exclude_from_group_totals AS exclude_from_group_totals
  FROM accounts a
  INNER JOIN asset_groups g ON g.id = a.asset_group_id
  WHERE (a.import_key IS NULL OR a.import_key != ?)
    AND a.asset_group_id IN (__IDS__)
    AND g.slug != 'individual_stocks'
  ORDER BY g.sort_order, g.id, a.name
`;

/** Create or resolve a leaf bucket under a parent (e.g. ticker slug under brokerage_acciones). */
export function ensureChildAssetGroupId(
  parentSlug: string,
  childSlug: string,
  childLabel: string
): { id: number; created: boolean } {
  const parent = assetGroupBySlug(parentSlug);
  if (!parent) throw new Error(`unknown parent bucket ${parentSlug}`);
  const leafSlug = parentSlug === childSlug ? childSlug : `${parentSlug}__${childSlug}`;
  const existing = db
    .prepare(`SELECT id FROM asset_groups WHERE slug = ?`)
    .get(leafSlug) as { id: number } | undefined;
  if (existing) return { id: existing.id, created: false };
  const maxSort = db
    .prepare(`SELECT COALESCE(MAX(sort_order), 0) AS m FROM asset_groups WHERE parent_id = ?`)
    .get(parent.id) as { m: number };
  const r = db
    .prepare(
      `INSERT INTO asset_groups (slug, label, sort_order, parent_id) VALUES (?, ?, ?, ?)`
    )
    .run(leafSlug, childLabel, maxSort.m + 1, parent.id);
  dashboardBucketBySlugCache = null;
  return { id: Number(r.lastInsertRowid), created: true };
}
export function listAccountsForBucketIds(
  bucketIds: number[],
  excludeLegacyStocksNote: string
): BucketAccountRow[] {
  if (bucketIds.length === 0) return [];
  const ph = bucketIds.map(() => "?").join(",");
  const sql = LIST_BY_BUCKET_IDS.replace("__IDS__", ph);
  return db.prepare(sql).all(excludeLegacyStocksNote, ...bucketIds) as BucketAccountRow[];
}

const LIST_BY_ACCOUNT_IDS = `
  SELECT a.id AS account_id, a.name,
         g.slug AS bucket_slug, g.label AS bucket_label,
         a.notes AS notes,
         a.exclude_from_group_totals AS exclude_from_group_totals
  FROM accounts a
  INNER JOIN asset_groups g ON g.id = a.asset_group_id
  WHERE (a.import_key IS NULL OR a.import_key != ?)
    AND a.id IN (__IDS__)
    AND g.slug != 'individual_stocks'
  ORDER BY g.sort_order, g.id, a.name
`;

export function listAccountsForBucketSlug(
  bucketSlug: string,
  _tabSubgroup: string | undefined,
  excludeLegacyStocksNote: string
): BucketAccountRow[] {
  if (portfolioGroupBySlug(bucketSlug)) {
    const ids = accountIdsInPortfolioGroup(bucketSlug);
    if (ids.length === 0) return [];
    const ph = ids.map(() => "?").join(",");
    const sql = LIST_BY_ACCOUNT_IDS.replace("__IDS__", ph);
    return db.prepare(sql).all(excludeLegacyStocksNote, ...ids) as BucketAccountRow[];
  }
  const ids = assetGroupIdsInSubtree(bucketSlug);
  return listAccountsForBucketIds(ids, excludeLegacyStocksNote);
}
