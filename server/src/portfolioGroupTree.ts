import { assetGroupBySlug, CHECKING_ACCOUNTS_KIND, leafAssetGroupIdForKindSlug } from "./assetGroupTree.js";
import { db } from "./db.js";
import {
  bucketOfAccount,
  groupAccountIds,
  isInvestmentAccount,
  isInvestmentGroup,
  leafGroupOfAccount,
  navGroupById,
} from "./navTreeModel.js";
import { portfolioGroupBySlug } from "./portfolioGroupIndex.js";

export { portfolioGroupById, portfolioGroupBySlug, type PortfolioGroupRow } from "./portfolioGroupIndex.js";

/** A portfolio group tab's slug. */
export function isResolvablePortfolioGroupSlug(slug: string): boolean {
  return portfolioGroupBySlug(slug) != null;
}

export { withPortfolioGroupIndex } from "./portfolioGroupIndex.js";

/** Account ids in this portfolio group subtree (direct + nested groups; the Pasivos subtree attached). */
export function accountIdsInPortfolioGroup(slugOrId: string | number): number[] {
  return groupAccountIds(slugOrId);
}

/**
 * Account ids that roll up into a parent portfolio group total.
 * Skips child groups with `exclude_from_parent_total`.
 */
export function accountIdsInPortfolioGroupForTotals(slugOrId: string | number): number[] {
  return groupAccountIds(slugOrId, { forTotals: true });
}

/** The portfolio group slug each account is an item of (its nav leaf bucket). */
export function leafPortfolioGroupSlugByAccountIds(
  accountIds: readonly number[]
): Map<number, string> {
  const out = new Map<number, string>();
  for (const id of new Set(accountIds)) {
    const leaf = leafGroupOfAccount(id);
    if (leaf) out.set(id, leaf.slug);
  }
  return out;
}

/** The portfolio group slug that lists this account (nav leaf bucket). */
export function leafPortfolioGroupSlugForAccount(accountId: number): string | null {
  return leafGroupOfAccount(accountId)?.slug ?? null;
}

/** The nav leaf's kind (`acciones`, `afp_afc`, …), else the account's own behaviour kind. */
export function kindSlugForAccount(accountId: number): string | null {
  const k = leafGroupOfAccount(accountId)?.kindSlug;
  if (k && k !== CHECKING_ACCOUNTS_KIND) return k;
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
  // The asset leaf's own kind (no profile here: callers ask for accounts a profile may refuse).
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

/**
 * Groups whose page shows a Rentabilidad table (period returns + benchmark row): the investment
 * groups and net worth itself (the home dashboard).
 */
export function groupHasPeriodReturns(slug: string): boolean {
  return slug === "net_worth" || isInvestmentGroup(slug);
}

/** True when the account lives under an investment root (brokerage, retirement). */
export function isInvestmentPerformanceAccount(accountId: number): boolean {
  return isInvestmentAccount(accountId);
}

/** The net-worth bucket an account sits in (nearest `nw_bucket` ancestor of its nav leaf). */
export function dashboardBucketSlugForAccountId(accountId: number): string | null {
  return bucketOfAccount(accountId);
}

export function portfolioGroupIdForAccount(accountId: number): number | null {
  return leafGroupOfAccount(accountId)?.id ?? null;
}

/** True when the portfolio group holds any group-like item (sub-buckets / linked groups). */
export function portfolioGroupHasChildGroupItems(groupId: number): boolean {
  const g = navGroupById(groupId);
  return g != null && (g.childGroupIds.length > 0 || g.linkedGroups.length > 0);
}

/** True when the portfolio group holds any account item directly. */
export function portfolioGroupHasAccountItems(groupId: number): boolean {
  const g = navGroupById(groupId);
  return g != null && !g.liabilityBacked && g.accountIds.length > 0;
}

const HOMOGENEITY_CHECKS = [
  {
    table: "liability_group_items",
    groupTable: "liability_groups",
    groupKinds: ["group"],
    leafKinds: ["account"],
  },
] as const;

/**
 * Invariants on the nav tables, whoever wrote them (the seeds their groups and links, account
 * placement the memberships): runs at the end of every seed (boot included) and throws on the
 * first structural regression.
 *
 * - Portfolio tree: a group may hold sub-buckets and accounts side by side (Acciones holds its
 *   stocks and the Portafolio IPSA bucket), but each account sits in at most one group — a
 *   second membership would count it twice in every per-child view. Linked groups (chart
 *   references) and expense places never mix with anything.
 * - Credit-card and liability trees: a group's items are all sub-groups XOR all accounts.
 */
export function assertNavGroupItemsShape(): void {
  const twice = db
    .prepare(
      `SELECT a.name AS name, GROUP_CONCAT(g.slug, ', ') AS slugs
       FROM portfolio_group_items i
       JOIN portfolio_groups g ON g.id = i.group_id
       JOIN accounts a ON a.id = i.account_id
       WHERE i.item_kind = 'account'
       GROUP BY i.account_id
       HAVING COUNT(*) > 1`
    )
    .all() as { name: string; slugs: string }[];
  if (twice.length > 0) {
    throw new Error(
      "portfolio_group_items: accounts linked under more than one group: " +
        twice.map((r) => `${r.name} (${r.slugs})`).join("; ")
    );
  }
  const mixed = db
    .prepare(
      `SELECT g.slug AS slug, GROUP_CONCAT(DISTINCT i.item_kind) AS kinds
       FROM portfolio_groups g
       JOIN portfolio_group_items i ON i.group_id = g.id
       GROUP BY g.id
       HAVING COUNT(DISTINCT i.item_kind) > 1
          AND SUM(CASE WHEN i.item_kind IN ('linked_group', 'expense_account') THEN 1 ELSE 0 END) > 0`
    )
    .all() as { slug: string; kinds: string }[];
  if (mixed.length > 0) {
    throw new Error(
      "portfolio_group_items: linked groups / expense places mixed with other items: " +
        mixed.map((r) => `${r.slug} (${r.kinds})`).join("; ")
    );
  }
  for (const check of HOMOGENEITY_CHECKS) {
    const groupPh = check.groupKinds.map(() => "?").join(",");
    const leafPh = check.leafKinds.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT g.slug AS slug
         FROM ${check.groupTable} g
         JOIN ${check.table} i ON i.group_id = g.id
         GROUP BY g.id
         HAVING SUM(CASE WHEN i.item_kind IN (${groupPh}) THEN 1 ELSE 0 END) > 0
            AND SUM(CASE WHEN i.item_kind IN (${leafPh}) THEN 1 ELSE 0 END) > 0`
      )
      .all(...check.groupKinds, ...check.leafKinds) as { slug: string }[];
    if (rows.length > 0) {
      throw new Error(
        `${check.table}: groups mix sub-group and account items (must be one or the other): ` +
          rows.map((r) => r.slug).join(", ")
      );
    }
  }
}
