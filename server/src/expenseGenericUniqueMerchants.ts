import { db } from "./db.js";
import { dbStateMemo } from "./dbStateMemo.js";
import { InputError } from "./inputError.js";

export type ExpenseGenericUniqueMerchantRow = {
  id: number;
  merchant_key: string;
  sort_order: number;
};

/**
 * The generic merchant keys, memoized on database state (`dbStateMemo`): any write of this
 * connection, another connection's write (a script, the ingest service) or the day turn drops it.
 */
export function exactGenericUniqueMerchantKeys(): ReadonlySet<string> {
  return dbStateMemo("expense_generic_unique_merchant_keys", null, () => {
    const rows = db
      .prepare(`SELECT merchant_key FROM cc_expense_generic_unique_merchants`)
      .all() as { merchant_key: string }[];
    return new Set(rows.map((r) => r.merchant_key));
  });
}

export function isExactGenericUniqueMerchantKey(key: string): boolean {
  return exactGenericUniqueMerchantKeys().has(key);
}

export function listExpenseGenericUniqueMerchants(): ExpenseGenericUniqueMerchantRow[] {
  return db
    .prepare(
      `SELECT id, merchant_key, sort_order
       FROM cc_expense_generic_unique_merchants
       ORDER BY sort_order, merchant_key, id`
    )
    .all() as ExpenseGenericUniqueMerchantRow[];
}

export function createExpenseGenericUniqueMerchant(
  merchantKey: string
): ExpenseGenericUniqueMerchantRow {
  const key = merchantKey.trim();
  if (!key) {
    throw new InputError("merchant_key required");
  }
  const existing = db
    .prepare(`SELECT id FROM cc_expense_generic_unique_merchants WHERE merchant_key = ?`)
    .get(key) as { id: number } | undefined;
  if (existing) {
    throw new InputError("merchant_key already exists", 409);
  }

  const maxSort = db
    .prepare(`SELECT COALESCE(MAX(sort_order), 0) AS m FROM cc_expense_generic_unique_merchants`)
    .get() as { m: number };
  const sortOrder = maxSort.m + 10;

  const result = db
    .prepare(
      `INSERT INTO cc_expense_generic_unique_merchants (merchant_key, sort_order)
       VALUES (?, ?)`
    )
    .run(key, sortOrder);

  return db
    .prepare(
      `SELECT id, merchant_key, sort_order
       FROM cc_expense_generic_unique_merchants WHERE id = ?`
    )
    .get(Number(result.lastInsertRowid)) as ExpenseGenericUniqueMerchantRow;
}

export function updateExpenseGenericUniqueMerchant(
  id: number,
  merchantKey: string
): ExpenseGenericUniqueMerchantRow {
  const key = merchantKey.trim();
  if (!key) {
    throw new InputError("merchant_key required");
  }
  const current = db
    .prepare(`SELECT id FROM cc_expense_generic_unique_merchants WHERE id = ?`)
    .get(id) as { id: number } | undefined;
  if (!current) {
    throw new InputError("not found", 404);
  }
  const clash = db
    .prepare(
      `SELECT id FROM cc_expense_generic_unique_merchants WHERE merchant_key = ? AND id != ?`
    )
    .get(key, id) as { id: number } | undefined;
  if (clash) {
    throw new InputError("merchant_key already exists", 409);
  }

  db.prepare(`UPDATE cc_expense_generic_unique_merchants SET merchant_key = ? WHERE id = ?`).run(
    key,
    id
  );

  return db
    .prepare(
      `SELECT id, merchant_key, sort_order
       FROM cc_expense_generic_unique_merchants WHERE id = ?`
    )
    .get(id) as ExpenseGenericUniqueMerchantRow;
}

export function deleteExpenseGenericUniqueMerchant(id: number): void {
  const result = db
    .prepare(`DELETE FROM cc_expense_generic_unique_merchants WHERE id = ?`)
    .run(id);
  if (result.changes === 0) {
    throw new InputError("not found", 404);
  }
}
