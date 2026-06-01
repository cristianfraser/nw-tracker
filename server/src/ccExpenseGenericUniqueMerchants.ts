import { db } from "./db.js";

export type CcExpenseGenericUniqueMerchantRow = {
  id: number;
  merchant_key: string;
  sort_order: number;
};

let cachedKeys: Set<string> | null = null;

export function invalidateCcExpenseGenericUniqueMerchantCache(): void {
  cachedKeys = null;
}

export function exactGenericUniqueMerchantKeys(): Set<string> {
  if (!cachedKeys) {
    const rows = db
      .prepare(`SELECT merchant_key FROM cc_expense_generic_unique_merchants`)
      .all() as { merchant_key: string }[];
    cachedKeys = new Set(rows.map((r) => r.merchant_key));
  }
  return cachedKeys;
}

export function isExactGenericUniqueMerchantKey(key: string): boolean {
  return exactGenericUniqueMerchantKeys().has(key);
}

export function listCcExpenseGenericUniqueMerchants(): CcExpenseGenericUniqueMerchantRow[] {
  return db
    .prepare(
      `SELECT id, merchant_key, sort_order
       FROM cc_expense_generic_unique_merchants
       ORDER BY sort_order, merchant_key, id`
    )
    .all() as CcExpenseGenericUniqueMerchantRow[];
}

export function createCcExpenseGenericUniqueMerchant(
  merchantKey: string
): CcExpenseGenericUniqueMerchantRow {
  const key = merchantKey.trim();
  if (!key) {
    throw new Error("merchant_key required");
  }
  const existing = db
    .prepare(`SELECT id FROM cc_expense_generic_unique_merchants WHERE merchant_key = ?`)
    .get(key) as { id: number } | undefined;
  if (existing) {
    throw new Error("merchant_key already exists");
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
  invalidateCcExpenseGenericUniqueMerchantCache();

  return db
    .prepare(
      `SELECT id, merchant_key, sort_order
       FROM cc_expense_generic_unique_merchants WHERE id = ?`
    )
    .get(Number(result.lastInsertRowid)) as CcExpenseGenericUniqueMerchantRow;
}

export function updateCcExpenseGenericUniqueMerchant(
  id: number,
  merchantKey: string
): CcExpenseGenericUniqueMerchantRow {
  const key = merchantKey.trim();
  if (!key) {
    throw new Error("merchant_key required");
  }
  const current = db
    .prepare(`SELECT id FROM cc_expense_generic_unique_merchants WHERE id = ?`)
    .get(id) as { id: number } | undefined;
  if (!current) {
    throw new Error("not found");
  }
  const clash = db
    .prepare(
      `SELECT id FROM cc_expense_generic_unique_merchants WHERE merchant_key = ? AND id != ?`
    )
    .get(key, id) as { id: number } | undefined;
  if (clash) {
    throw new Error("merchant_key already exists");
  }

  db.prepare(`UPDATE cc_expense_generic_unique_merchants SET merchant_key = ? WHERE id = ?`).run(
    key,
    id
  );
  invalidateCcExpenseGenericUniqueMerchantCache();

  return db
    .prepare(
      `SELECT id, merchant_key, sort_order
       FROM cc_expense_generic_unique_merchants WHERE id = ?`
    )
    .get(id) as CcExpenseGenericUniqueMerchantRow;
}

export function deleteCcExpenseGenericUniqueMerchant(id: number): void {
  const result = db
    .prepare(`DELETE FROM cc_expense_generic_unique_merchants WHERE id = ?`)
    .run(id);
  if (result.changes === 0) {
    throw new Error("not found");
  }
  invalidateCcExpenseGenericUniqueMerchantCache();
}
