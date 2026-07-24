import { dashboardBucketForAssetGroupSlug } from "./assetGroupTree.js";
import { portfolioGroupBySlug } from "./portfolioGroupTree.js";
import { db } from "./db.js";
import { MONTH_PRECISION_ACCOUNT_KIND_SLUGS } from "./monthPrecisionAccountKinds.js";

const bucketSlugStmt = db.prepare(
  `SELECT g.slug FROM accounts a
   INNER JOIN asset_groups g ON g.id = a.asset_group_id
   WHERE a.id = ?`
);

/** Behavior kind from portfolio leaf slug, else legacy `parent__kind` segment. */
export function accountBucketKindSlug(leafBucketSlug: string): string {
  const pg = portfolioGroupBySlug(leafBucketSlug);
  if (pg?.kind_slug) return pg.kind_slug;
  const sep = leafBucketSlug.lastIndexOf("__");
  return sep >= 0 ? leafBucketSlug.slice(sep + 2) : leafBucketSlug;
}

/** Leaf `asset_groups.slug` for an account (replaces legacy `categories.slug`). */
export function bucketSlugForAccountId(accountId: number): string | null {
  const row = bucketSlugStmt.get(accountId) as { slug: string } | undefined;
  return row?.slug ?? null;
}

/** Account behavior kind (`afp`, `spy`, `cuenta_corriente`, …) from `accounts.asset_group_id`, not nav bucket kind. */
export function accountKindSlugForAccountId(accountId: number): string | null {
  const bucketSlug = bucketSlugForAccountId(accountId);
  if (!bucketSlug) return null;
  return accountBucketKindSlug(bucketSlug);
}

/** True when this account's movement dates are month-precision (see the kind set). */
export function accountIsMonthPrecisionDated(accountId: number): boolean {
  const kind = accountKindSlugForAccountId(accountId);
  return kind != null && MONTH_PRECISION_ACCOUNT_KIND_SLUGS.has(kind);
}

/**
 * Debt account: its mark is a positive amount OWED, so value moves and P/L run opposite to an
 * asset's (`pl = prior − owed − flow`, flows positive when capital goes into the debt).
 */
export function isLiabilityAccountId(accountId: number): boolean {
  const kind = accountKindSlugForAccountId(accountId);
  return kind === "credit_card" || kind === "mortgage";
}

export function dashboardBucketSlugForPortfolioGroupSlug(portfolioGroupSlug: string): string | null {
  const pg = portfolioGroupBySlug(portfolioGroupSlug);
  if (!pg) return null;
  if (pg.dashboard_bucket_slug) return pg.dashboard_bucket_slug;
  if (pg.asset_group_slug) return dashboardBucketForAssetGroupSlug(pg.asset_group_slug);
  return null;
}

export function requireBucketSlugForAccountId(accountId: number): string {
  const slug = bucketSlugForAccountId(accountId);
  if (!slug) throw new Error(`account ${accountId} has no asset_group_id`);
  return slug;
}

/** Top-level NW bucket for an account (portfolio group, then asset placement). */
export { dashboardBucketSlugForAccountId } from "./portfolioGroupTree.js";
