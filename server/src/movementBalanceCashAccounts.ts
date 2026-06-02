import type { Database } from "better-sqlite3";
import { accountBucketKindSlug } from "./accountBucket.js";
import { kindSlugForAccount } from "./portfolioGroupTree.js";
import {
  CHECKING_ACCOUNTS_BUCKET,
  leafAssetGroupIdsUnder,
} from "./assetGroupTree.js";
import { db } from "./db.js";

/** Behavior kinds for cartola checking (corriente + vista), not the `checking_accounts` nav bucket. */
export const MOVEMENT_BALANCE_CASH_CATEGORY_SLUGS = new Set([
  "cuenta_corriente",
  "cuenta_vista",
]);

const CHECKING_ACCOUNTS_NAV_SLUG = "checking_accounts";

export function isMovementBalanceCashCategory(slug: string): boolean {
  return MOVEMENT_BALANCE_CASH_CATEGORY_SLUGS.has(accountBucketKindSlug(slug));
}

function isMovementBalanceCashKindSlug(kindSlug: string): boolean {
  return MOVEMENT_BALANCE_CASH_CATEGORY_SLUGS.has(kindSlug);
}

function checkingLeafAssetGroupIds(dbHandle: Database): number[] {
  const leafIds = leafAssetGroupIdsUnder(CHECKING_ACCOUNTS_BUCKET);
  if (leafIds.length === 0) return [];
  const ph = leafIds.map(() => "?").join(",");
  const rows = dbHandle
    .prepare(`SELECT id, slug FROM asset_groups WHERE id IN (${ph})`)
    .all(...leafIds) as { id: number; slug: string }[];
  return rows
    .filter((r) => isMovementBalanceCashCategory(r.slug))
    .map((r) => r.id);
}

function accountIdsOnCheckingAssetLeaves(dbHandle: Database): number[] {
  const groupIds = checkingLeafAssetGroupIds(dbHandle);
  if (groupIds.length === 0) return [];
  const ph = groupIds.map(() => "?").join(",");
  return (
    dbHandle
      .prepare(
        `SELECT a.id FROM accounts a
         WHERE a.asset_group_id IN (${ph})
           AND (a.account_kind IS NULL OR a.account_kind != 'liability_view')
           AND (a.notes IS NULL OR a.notes != 'import:excel|key=stocks')
         ORDER BY a.id`
      )
      .all(...groupIds) as { id: number }[]
  ).map((r) => r.id);
}

function accountIdsLinkedToCheckingNav(dbHandle: Database): number[] {
  return (
    dbHandle
      .prepare(
        `SELECT DISTINCT a.id FROM accounts a
         INNER JOIN portfolio_group_items i ON i.account_id = a.id AND i.item_kind = 'account'
         INNER JOIN portfolio_groups pg ON pg.id = i.group_id AND pg.slug = ?
         WHERE (a.account_kind IS NULL OR a.account_kind != 'liability_view')
         ORDER BY a.id`
      )
      .all(CHECKING_ACCOUNTS_NAV_SLUG) as { id: number }[]
  ).map((r) => r.id);
}

export function cartolaCashAccountIdOptional(
  kindSlug: "cuenta_corriente" | "cuenta_vista",
  dbHandle: Database = db
): number | null {
  for (const accountId of listMovementBalanceCashAccountIds(dbHandle)) {
    const k = kindSlugForAccount(accountId);
    if (k === kindSlug) return accountId;
  }
  const legacyPortfolio = dbHandle
    .prepare(
      `SELECT a.id FROM accounts a
       JOIN portfolio_groups pg ON pg.id = a.primary_portfolio_group_id
       WHERE pg.kind_slug = ?
       ORDER BY a.id
       LIMIT 1`
    )
    .get(kindSlug) as { id: number } | undefined;
  if (legacyPortfolio) return legacyPortfolio.id;
  const legacyAsset = dbHandle
    .prepare(
      `SELECT a.id FROM accounts a
       JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE g.slug = ? OR g.slug = ?
       ORDER BY a.id
       LIMIT 1`
    )
    .get(kindSlug, `${CHECKING_ACCOUNTS_BUCKET}__${kindSlug}`) as { id: number } | undefined;
  return legacyAsset?.id ?? null;
}

export function cartolaCashAccountId(
  bucketSlug: "cuenta_corriente" | "cuenta_vista",
  dbHandle: Database = db
): number {
  const id = cartolaCashAccountIdOptional(bucketSlug, dbHandle);
  if (id == null) throw new Error(`${bucketSlug} account not found`);
  return id;
}

export function cuentaVistaAccountId(dbHandle: Database = db): number {
  return cartolaCashAccountId("cuenta_vista", dbHandle);
}

export function listMovementBalanceCashAccountIds(dbHandle: Database = db): number[] {
  const ids = new Set<number>();
  for (const id of accountIdsLinkedToCheckingNav(dbHandle)) ids.add(id);
  for (const id of accountIdsOnCheckingAssetLeaves(dbHandle)) ids.add(id);

  const slugs = [...MOVEMENT_BALANCE_CASH_CATEGORY_SLUGS];
  const ph = slugs.map(() => "?").join(",");
  const legacyKinds = (
    dbHandle
      .prepare(
        `SELECT DISTINCT a.id FROM accounts a
         JOIN portfolio_groups pg ON pg.id = a.primary_portfolio_group_id
         WHERE pg.kind_slug IN (${ph})
         ORDER BY a.id`
      )
      .all(...slugs) as { id: number }[]
  ).map((r) => r.id);
  for (const id of legacyKinds) ids.add(id);

  const legacyTopLevel = (
    dbHandle
      .prepare(
        `SELECT a.id FROM accounts a
         JOIN asset_groups g ON g.id = a.asset_group_id
         WHERE g.slug IN (${ph})
         ORDER BY a.id`
      )
      .all(...slugs) as { id: number }[]
  ).map((r) => r.id);
  for (const id of legacyTopLevel) ids.add(id);

  return [...ids]
    .filter((id) => {
      const k = kindSlugForAccount(id);
      return k != null && isMovementBalanceCashKindSlug(k);
    })
    .sort((a, b) => a - b);
}

/** All cartola checking accounts (corriente + vista) that feed Expenses gastos. */
export function listCheckingAccountIdsForExpenses(dbHandle: Database = db): number[] {
  return listMovementBalanceCashAccountIds(dbHandle);
}
