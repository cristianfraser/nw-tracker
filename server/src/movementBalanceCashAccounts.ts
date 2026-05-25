import type { Database } from "better-sqlite3";
import { db } from "./db.js";

/** Cash accounts whose CLP balance is derived from cartola movements, not month-end valuations. */
export const MOVEMENT_BALANCE_CASH_CATEGORY_SLUGS = new Set([
  "cuenta_corriente",
  "cuenta_vista",
]);

export function isMovementBalanceCashCategory(slug: string): boolean {
  return MOVEMENT_BALANCE_CASH_CATEGORY_SLUGS.has(slug);
}

export function cartolaCashAccountIdOptional(
  categorySlug: "cuenta_corriente" | "cuenta_vista",
  dbHandle: Database = db
): number | null {
  const row = dbHandle
    .prepare(
      `SELECT a.id FROM accounts a
       JOIN categories c ON c.id = a.category_id
       WHERE c.slug = ?
       ORDER BY a.id
       LIMIT 1`
    )
    .get(categorySlug) as { id: number } | undefined;
  return row?.id ?? null;
}

export function cartolaCashAccountId(
  categorySlug: "cuenta_corriente" | "cuenta_vista",
  dbHandle: Database = db
): number {
  const id = cartolaCashAccountIdOptional(categorySlug, dbHandle);
  if (id == null) throw new Error(`${categorySlug} account not found`);
  return id;
}

export function cuentaVistaAccountId(dbHandle: Database = db): number {
  return cartolaCashAccountId("cuenta_vista", dbHandle);
}

export function listMovementBalanceCashAccountIds(dbHandle: Database = db): number[] {
  const slugs = [...MOVEMENT_BALANCE_CASH_CATEGORY_SLUGS];
  const placeholders = slugs.map(() => "?").join(", ");
  return (
    dbHandle
      .prepare(
        `SELECT a.id FROM accounts a
         JOIN categories c ON c.id = a.category_id
         WHERE c.slug IN (${placeholders})
         ORDER BY a.id`
      )
      .all(...slugs) as { id: number }[]
  ).map((r) => r.id);
}
