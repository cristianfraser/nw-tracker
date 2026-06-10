import { bucketSlugForAccountId } from "./accountBucket.js";
import { dashboardBucketForAssetGroupSlug } from "./assetGroupTree.js";
import { db } from "./db.js";
import type { AccountRow } from "./movementUnitsPolicy.js";

/** Account identity for movement create schema / POST validation. */
export function accountRowForId(accountId: number): AccountRow | null {
  if (!Number.isFinite(accountId) || accountId <= 0) return null;
  const bucket_slug = bucketSlugForAccountId(accountId);
  if (!bucket_slug) return null;
  const row = db
    .prepare(`SELECT notes, equity_ticker FROM accounts WHERE id = ?`)
    .get(accountId) as { notes: string | null; equity_ticker: string | null } | undefined;
  return {
    bucket_slug,
    group_slug: dashboardBucketForAssetGroupSlug(bucket_slug) ?? bucket_slug,
    notes: row?.notes ?? null,
    equity_ticker: row?.equity_ticker ?? null,
  };
}
