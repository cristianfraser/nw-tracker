import type { Database } from "better-sqlite3";
import { accountBucketKindSlug } from "./accountBucket.js";
import { kindSlugForAccount } from "./portfolioGroupTree.js";
import {
  CHECKING_ACCOUNTS_BUCKET,
  leafAssetGroupIdsUnder,
} from "./assetGroupTree.js";
import { db } from "./db.js";

import { accountsWithRole, CARTOLA_CHECKING_KIND_SLUGS } from "./accountRoles.js";

/**
 * Behavior kinds for cartola checking (corriente + vista), not the `checking_accounts` nav bucket.
 * `listMovementBalanceCashAccountIds` also takes peso (`clp`) accounts filed under Checking accounts.
 */
export const MOVEMENT_BALANCE_CASH_CATEGORY_SLUGS = CARTOLA_CHECKING_KIND_SLUGS;

export function isMovementBalanceCashCategory(slug: string): boolean {
  return MOVEMENT_BALANCE_CASH_CATEGORY_SLUGS.has(accountBucketKindSlug(slug));
}

/**
 * Every account filed under Checking accounts, whatever its kind (peso or dollar cuenta corriente,
 * cuenta vista): the accounts on the asset leaves under the checking bucket, the tree the nav is
 * seeded from. Unlike {@link listMovementBalanceCashAccountIds} it does not narrow to the cartola
 * kinds.
 */
export function accountIdsUnderCheckingAccounts(dbHandle: Database = db): number[] {
  const leafIds = leafAssetGroupIdsUnder(CHECKING_ACCOUNTS_BUCKET);
  if (leafIds.length === 0) return [];
  const ph = leafIds.map(() => "?").join(",");
  return (
    dbHandle
      .prepare(`SELECT id FROM accounts WHERE asset_group_id IN (${ph}) ORDER BY id`)
      .all(...leafIds) as { id: number }[]
  ).map((r) => r.id);
}

/** The cartola checking account of `kindSlug` (the first checking member of that kind), or null. */
export function cartolaCashAccountIdOptional(kindSlug: "cuenta_corriente" | "cuenta_vista"): number | null {
  for (const accountId of listMovementBalanceCashAccountIds()) {
    if (kindSlugForAccount(accountId) === kindSlug) return accountId;
  }
  return null;
}

export function cartolaCashAccountId(bucketSlug: "cuenta_corriente" | "cuenta_vista"): number {
  const id = cartolaCashAccountIdOptional(bucketSlug);
  if (id == null) throw new Error(`${bucketSlug} account not found`);
  return id;
}

export function cuentaVistaAccountId(): number {
  return cartolaCashAccountId("cuenta_vista");
}

/**
 * The checking members (`accountRoles.ts` `checking_member`): the cartola checking accounts and the
 * peso accounts filed under Checking accounts — whose movements the gastos / income / deposit
 * readers read as bank movements.
 */
export function listMovementBalanceCashAccountIds(): number[] {
  return accountsWithRole("checking_member");
}
