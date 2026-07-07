import { assetGroupBySlug, CHECKING_ACCOUNTS_KIND, leafAssetGroupIdForKindSlug } from "./assetGroupTree.js";
import { getCreditCardGroupBySlug, listCreditCardGroupMasterAccountIds } from "./creditCardTree.js";
import { listLiabilitiesTabAccountRows } from "./liabilityTabAccounts.js";
import { db } from "./db.js";
import { getPortfolioGroupIndex } from "./portfolioGroupIndex.js";

export type PortfolioGroupRow = {
  id: number;
  slug: string;
  label: string;
  parent_id: number | null;
  group_kind: string;
  asset_group_slug: string | null;
  kind_slug: string | null;
  dashboard_bucket_slug: string | null;
  exclude_from_parent_total: number;
  api_group: string | null;
  api_subgroup: string | null;
};

type ItemRow = {
  group_id: number;
  item_kind: "group" | "account" | "expense_account";
  child_group_id: number | null;
  account_id: number | null;
  sort_order: number;
};

const groupBySlugStmt = db.prepare(
  `SELECT id, slug, label, parent_id, group_kind, asset_group_slug, kind_slug,
          dashboard_bucket_slug, exclude_from_parent_total, api_group, api_subgroup
   FROM portfolio_groups WHERE slug = ?`
);

const groupByIdStmt = db.prepare(
  `SELECT id, slug, label, parent_id, group_kind, asset_group_slug, kind_slug,
          dashboard_bucket_slug, exclude_from_parent_total, api_group, api_subgroup
   FROM portfolio_groups WHERE id = ?`
);

export function portfolioGroupBySlug(slug: string): PortfolioGroupRow | null {
  return (groupBySlugStmt.get(slug) as PortfolioGroupRow | undefined) ?? null;
}

/** Portfolio group tab or `credit_card_groups` issuer slug (Santander, BCI, …). */
export function isResolvablePortfolioGroupSlug(slug: string): boolean {
  return portfolioGroupBySlug(slug) != null || getCreditCardGroupBySlug(slug) != null;
}

function accountIdsInCreditCardIssuerGroup(issuerSlug: string): number[] {
  return listCreditCardGroupMasterAccountIds(issuerSlug);
}

export function portfolioGroupById(id: number): PortfolioGroupRow | null {
  const idx = getPortfolioGroupIndex();
  if (idx) return idx.groupById.get(id) ?? null;
  return (groupByIdStmt.get(id) as PortfolioGroupRow | undefined) ?? null;
}

export function isNavBucketKind(groupKind: string): boolean {
  return groupKind === "nav_bucket" || groupKind === "nav_hub";
}

export function isBucketKind(groupKind: string): boolean {
  return groupKind === "bucket" || groupKind === "normal";
}

function loadAllItems(): ItemRow[] {
  const idx = getPortfolioGroupIndex();
  if (idx) return idx.items as ItemRow[];
  return db
    .prepare(
      `SELECT group_id, item_kind, child_group_id, account_id, sort_order
       FROM portfolio_group_items
       WHERE item_kind IN ('group', 'account')
       ORDER BY sort_order, id`
    )
    .all() as ItemRow[];
}

function itemsByGroupId(items: ItemRow[]): Map<number, ItemRow[]> {
  const idx = getPortfolioGroupIndex();
  if (idx) return idx.byGroupId as Map<number, ItemRow[]>;
  const map = new Map<number, ItemRow[]>();
  for (const item of items) {
    const arr = map.get(item.group_id) ?? [];
    arr.push(item);
    map.set(item.group_id, arr);
  }
  return map;
}

export { withPortfolioGroupIndex } from "./portfolioGroupIndex.js";

/** Account ids in this portfolio group subtree (direct + nested groups). */
export function accountIdsInPortfolioGroup(slugOrId: string | number): number[] {
  if (typeof slugOrId === "string" && getCreditCardGroupBySlug(slugOrId)) {
    return accountIdsInCreditCardIssuerGroup(slugOrId);
  }
  if (slugOrId === "liabilities_credit_card") {
    return listLiabilitiesTabAccountRows("credit_card").map((r) => r.account_id);
  }
  if (slugOrId === "liabilities_mortgage") {
    return listLiabilitiesTabAccountRows("mortgage").map((r) => r.account_id);
  }
  const root =
    typeof slugOrId === "number" ? portfolioGroupById(slugOrId) : portfolioGroupBySlug(slugOrId);
  if (!root) return [];

  const items = loadAllItems();
  const byGroup = itemsByGroupId(items);
  const out = new Set<number>();

  const visitGroup = (groupId: number) => {
    for (const item of byGroup.get(groupId) ?? []) {
      if (item.item_kind === "account" && item.account_id != null) {
        out.add(item.account_id);
      } else if (item.item_kind === "group" && item.child_group_id != null) {
        visitGroup(item.child_group_id);
      }
    }
  };

  visitGroup(root.id);
  return [...out].sort((a, b) => a - b);
}

/**
 * Account ids that roll up into a parent portfolio group total.
 * Skips child groups with `exclude_from_parent_total`.
 */
export function accountIdsInPortfolioGroupForTotals(slugOrId: string | number): number[] {
  const root =
    typeof slugOrId === "number" ? portfolioGroupById(slugOrId) : portfolioGroupBySlug(slugOrId);
  if (!root) return [];

  const items = loadAllItems();
  const byGroup = itemsByGroupId(items);
  const out = new Set<number>();

  const visitGroup = (groupId: number) => {
    for (const item of byGroup.get(groupId) ?? []) {
      if (item.item_kind === "account" && item.account_id != null) {
        out.add(item.account_id);
      } else if (item.item_kind === "group" && item.child_group_id != null) {
        const child = portfolioGroupById(item.child_group_id);
        if (!child || child.exclude_from_parent_total === 1) continue;
        visitGroup(item.child_group_id);
      }
    }
  };

  visitGroup(root.id);
  return [...out].sort((a, b) => a - b);
}

export type DashboardRowForPortfolioSum = {
  account_id: number;
  current_value_clp: number | null;
  current_value_usd?: number | null;
  exclude_from_group_totals: number;
};

/** Sum live dashboard row balances for all accounts in a portfolio group subtree (tree rollup). */
export function sumDashboardRowsForPortfolioGroup(
  portfolioGroupSlug: string,
  rows: DashboardRowForPortfolioSum[],
  includeUsd: boolean
): { clp: number; usd: number } {
  const ids = new Set(accountIdsInPortfolioGroupForTotals(portfolioGroupSlug));
  let clp = 0;
  let usd = 0;
  for (const r of rows) {
    if (!ids.has(r.account_id)) continue;
    if (r.exclude_from_group_totals === 1) continue;
    clp += r.current_value_clp != null && Number.isFinite(r.current_value_clp) ? r.current_value_clp : 0;
    if (includeUsd && r.current_value_usd != null && Number.isFinite(r.current_value_usd)) {
      usd += r.current_value_usd;
    }
  }
  return { clp, usd };
}

/** Deepest portfolio group slug per account (one query for dashboard batching). */
export function leafPortfolioGroupSlugByAccountIds(
  accountIds: readonly number[]
): Map<number, string> {
  const out = new Map<number, string>();
  if (!accountIds.length) return out;
  const unique = [...new Set(accountIds)];
  const ph = unique.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT i.account_id, pg.slug, LENGTH(pg.slug) AS slug_len, pg.id AS pg_id
       FROM portfolio_group_items i
       JOIN portfolio_groups pg ON pg.id = i.group_id
       WHERE i.item_kind = 'account' AND i.account_id IN (${ph})
       ORDER BY i.account_id, slug_len DESC, pg_id DESC`
    )
    .all(...unique) as { account_id: number; slug: string }[];
  for (const r of rows) {
    if (!out.has(r.account_id)) out.set(r.account_id, r.slug);
  }
  return out;
}

/** Deepest portfolio group slug that lists this account (nav leaf bucket). */
export function leafPortfolioGroupSlugForAccount(accountId: number): string | null {
  return leafPortfolioGroupSlugByAccountIds([accountId]).get(accountId) ?? null;
}

export function kindSlugForAccount(accountId: number): string | null {
  const leafSlug = leafPortfolioGroupSlugForAccount(accountId);
  if (leafSlug) {
    const pg = portfolioGroupBySlug(leafSlug);
    const k = pg?.kind_slug;
    if (k && k !== CHECKING_ACCOUNTS_KIND) return k;
  }
  const row = db
    .prepare(
      `SELECT pg.kind_slug, g.slug AS asset_slug
       FROM accounts a
       JOIN asset_groups g ON g.id = a.asset_group_id
       LEFT JOIN portfolio_groups pg ON pg.asset_group_slug = g.slug
       WHERE a.id = ?`
    )
    .get(accountId) as { kind_slug: string | null; asset_slug: string } | undefined;
  if (!row) return null;
  if (row.kind_slug) return row.kind_slug;
  const sep = row.asset_slug.lastIndexOf("__");
  return sep >= 0 ? row.asset_slug.slice(sep + 2) : row.asset_slug;
}

/** `accounts.asset_group_id` for import/create from portfolio `kind_slug`. */
export function assetGroupIdForImportKind(kindSlug: string): number {
  const row = db
    .prepare(
      `SELECT asset_group_slug FROM portfolio_groups
       WHERE kind_slug = ?
       ORDER BY LENGTH(slug) DESC, id DESC
       LIMIT 1`
    )
    .get(kindSlug) as { asset_group_slug: string | null } | undefined;
  if (row?.asset_group_slug) {
    const ag = assetGroupBySlug(row.asset_group_slug);
    if (ag) return ag.id;
  }
  return leafAssetGroupIdForKindSlug(kindSlug);
}

const NW_METRIC_GROUP_SLUGS = new Set(["real_estate", "retirement", "brokerage", "cash_eqs"]);

/**
 * Top-level NW bucket used for dashboard performance marks (`brokerage`, `retirement`, …).
 * Walks `primary_portfolio_group_id` ancestors — no per-account slug tags.
 */
export function nwDashboardMetricGroupForAccount(accountId: number): string | null {
  let groupId = db
    .prepare(`SELECT primary_portfolio_group_id FROM accounts WHERE id = ?`)
    .get(accountId) as { primary_portfolio_group_id: number | null } | undefined;
  let currentId = groupId?.primary_portfolio_group_id ?? portfolioGroupIdForAccount(accountId);
  while (currentId != null) {
    const pg = portfolioGroupById(currentId);
    if (!pg) break;
    if (NW_METRIC_GROUP_SLUGS.has(pg.slug)) return pg.slug;
    currentId = pg.parent_id;
  }
  return null;
}

/** Root NW buckets whose descendants get the Rentabilidad (period-returns) section. */
export const INVESTMENT_PERF_ROOT_GROUP_SLUGS = ["brokerage", "retirement"] as const;

/**
 * True for the `inversiones` hub and every group under `brokerage`/`retirement`
 * (the node itself counts) — covers brokerage_{acciones,mutual_funds,long_term,crypto,cash},
 * retirement_afp_afc, retirement_apv{,_a,_b} and the routable parents. Walks `parent_id`; no slug parsing.
 */
export function isInvestmentPerformanceGroupSlug(slug: string): boolean {
  if (slug === "inversiones") return true;
  let pg = portfolioGroupBySlug(slug);
  while (pg != null) {
    if ((INVESTMENT_PERF_ROOT_GROUP_SLUGS as readonly string[]).includes(pg.slug)) return true;
    pg = pg.parent_id != null ? portfolioGroupById(pg.parent_id) : null;
  }
  return false;
}

/** True when the account lives under the `brokerage` or `retirement` NW bucket. */
export function isInvestmentPerformanceAccount(accountId: number): boolean {
  const metricGroup = nwDashboardMetricGroupForAccount(accountId);
  return metricGroup != null && (INVESTMENT_PERF_ROOT_GROUP_SLUGS as readonly string[]).includes(metricGroup);
}

/** Nearest `dashboard_bucket_slug` on this portfolio group or an ancestor (legacy / display). */
export function dashboardBucketSlugForPortfolioGroupId(groupId: number): string | null {
  let currentId: number | null = groupId;
  while (currentId != null) {
    const pg = portfolioGroupById(currentId);
    if (!pg) return null;
    const dash = pg.dashboard_bucket_slug?.trim();
    if (dash) return dash;
    currentId = pg.parent_id;
  }
  return null;
}

export function dashboardBucketSlugForAccountId(accountId: number): string | null {
  const row = db
    .prepare(
      `SELECT a.primary_portfolio_group_id, g.slug AS asset_slug
       FROM accounts a
       LEFT JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE a.id = ?`
    )
    .get(accountId) as { primary_portfolio_group_id: number | null; asset_slug: string } | undefined;
  if (!row) return null;

  const leafGroupId = row.primary_portfolio_group_id ?? portfolioGroupIdForAccount(accountId);
  if (leafGroupId != null) {
    const fromTree = dashboardBucketSlugForPortfolioGroupId(leafGroupId);
    if (fromTree) return fromTree;
  }

  const pg = db
    .prepare(`SELECT dashboard_bucket_slug FROM portfolio_groups WHERE asset_group_slug = ? LIMIT 1`)
    .get(row.asset_slug) as { dashboard_bucket_slug: string | null } | undefined;
  if (pg?.dashboard_bucket_slug?.trim()) return pg.dashboard_bucket_slug.trim();
  return null;
}

const LEGACY_SUBGROUP_ALIASES: Record<string, string> = {
  fondos_mutuos: "mutual_funds",
};

/** Legacy `?subgroup=` query value (empty → undefined, invalid type → null). */
export function normalizeLegacyTabSubgroup(raw: unknown): string | undefined | null {
  if (raw == null || raw === "") return undefined;
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (t === "") return undefined;
  return LEGACY_SUBGROUP_ALIASES[t] ?? t;
}

/**
 * Map deprecated `group` + `subgroup` tab params to a `portfolio_groups.slug`.
 * Returns null when the combination is unknown.
 */
export function resolvePortfolioGroupSlugForLegacyTab(
  groupSlug: string,
  tabSubgroup?: string
): string | null {
  if (groupSlug === "liabilities") {
    if (!tabSubgroup) return portfolioGroupBySlug("liabilities") ? "liabilities" : null;
    if (tabSubgroup === "credit_card" && portfolioGroupBySlug("liabilities_credit_card")) {
      return "liabilities_credit_card";
    }
    if (tabSubgroup === "mortgage" && portfolioGroupBySlug("liabilities_mortgage")) {
      return "liabilities_mortgage";
    }
    return null;
  }
  if (!tabSubgroup) {
    return portfolioGroupBySlug(groupSlug) ? groupSlug : null;
  }
  const row = db
    .prepare(
      `SELECT slug FROM portfolio_groups
       WHERE api_group = ? AND (api_subgroup = ? OR kind_slug = ?)
       ORDER BY LENGTH(slug) DESC
       LIMIT 1`
    )
    .get(groupSlug, tabSubgroup, tabSubgroup) as { slug: string } | undefined;
  if (row) return row.slug;
  const composed = `${groupSlug}_${tabSubgroup}`;
  return portfolioGroupBySlug(composed) ? composed : null;
}

export function portfolioGroupIdForAccount(accountId: number): number | null {
  const row = db
    .prepare(
      `SELECT pg.id
       FROM portfolio_group_items i
       JOIN portfolio_groups pg ON pg.id = i.group_id
       WHERE i.item_kind = 'account' AND i.account_id = ?
       ORDER BY LENGTH(pg.slug) DESC, pg.id DESC
       LIMIT 1`
    )
    .get(accountId) as { id: number } | undefined;
  return row?.id ?? null;
}
