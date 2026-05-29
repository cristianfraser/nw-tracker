import type { Database } from "better-sqlite3";
import { accountBucketKindSlug } from "./accountBucket.js";
import { db } from "./db.js";

/** Cash accounts whose CLP balance is derived from cartola movements, not month-end valuations. */
export const MOVEMENT_BALANCE_CASH_CATEGORY_SLUGS = new Set([
  "cuenta_corriente",
  "cuenta_vista",
]);

export function isMovementBalanceCashCategory(slug: string): boolean {
  return MOVEMENT_BALANCE_CASH_CATEGORY_SLUGS.has(accountBucketKindSlug(slug));
}

export function cartolaCashAccountIdOptional(
  bucketSlug: "cuenta_corriente" | "cuenta_vista",
  dbHandle: Database = db
): number | null {
  const row = dbHandle
    .prepare(
      `SELECT a.id FROM accounts a
       JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE (g.slug = ? OR g.slug LIKE '%__' || ?)
       ORDER BY a.id
       LIMIT 1`
    )
    .get(bucketSlug, bucketSlug) as { id: number } | undefined;
  return row?.id ?? null;
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
  const slugs = [...MOVEMENT_BALANCE_CASH_CATEGORY_SLUGS];
  const clauses = slugs.map(() => "(g.slug = ? OR g.slug LIKE '%__' || ?)").join(" OR ");
  const params = slugs.flatMap((s) => [s, s]);
  return (
    dbHandle
      .prepare(
        `SELECT a.id FROM accounts a
         JOIN asset_groups g ON g.id = a.asset_group_id
         WHERE ${clauses}
         ORDER BY a.id`
      )
      .all(...params) as { id: number }[]
  ).map((r) => r.id);
}
