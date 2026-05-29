import { dashboardBucketForAssetGroupSlug } from "./assetGroupTree.js";
import { db } from "./db.js";

const bucketSlugStmt = db.prepare(
  `SELECT g.slug FROM accounts a
   INNER JOIN asset_groups g ON g.id = a.asset_group_id
   WHERE a.id = ?`
);

/** Legacy category segment from a leaf bucket slug (`parent__kind` → `kind`). */
export function accountBucketKindSlug(leafBucketSlug: string): string {
  const sep = leafBucketSlug.lastIndexOf("__");
  return sep >= 0 ? leafBucketSlug.slice(sep + 2) : leafBucketSlug;
}

/** Leaf `asset_groups.slug` for an account (replaces legacy `categories.slug`). */
export function bucketSlugForAccountId(accountId: number): string | null {
  const row = bucketSlugStmt.get(accountId) as { slug: string } | undefined;
  return row?.slug ?? null;
}

/** Legacy category kind for an account (`afp`, `spy`, `cuenta_corriente`, …). */
export function accountKindSlugForAccountId(accountId: number): string | null {
  const leaf = bucketSlugForAccountId(accountId);
  return leaf ? accountBucketKindSlug(leaf) : null;
}

export function requireBucketSlugForAccountId(accountId: number): string {
  const slug = bucketSlugForAccountId(accountId);
  if (!slug) throw new Error(`account ${accountId} has no asset_group_id`);
  return slug;
}

/** Top-level NW bucket for an account (walks leaf bucket ancestry). */
export function dashboardBucketSlugForAccountId(accountId: number): string | null {
  const leaf = bucketSlugForAccountId(accountId);
  if (!leaf) return null;
  return dashboardBucketForAssetGroupSlug(leaf);
}
