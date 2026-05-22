import { db } from "./db.js";
import {
  loadCcStatementLineExpenseCtx,
  stableCcExpensePurchaseKeyFromCtx,
  type CcStatementLineExpenseCtx,
} from "./ccExpenseCategories.js";

export type CcExpenseCategorySnapshot = {
  lineCategoryByParserRowId: Map<string, number>;
  uniqueCategoryByStablePurchaseKey: Map<string, number | null>;
};

/** Copy merchant rules from legacy combined CC master (id 15) onto per-card accounts. */
export function propagateCcExpenseMerchantRulesFromLegacy(
  targetAccountId: number,
  legacyAccountId = 15
): number {
  const r = db
    .prepare(
      `INSERT OR IGNORE INTO cc_expense_merchant_categories (account_id, merchant_key, category_id)
       SELECT ?, mc.merchant_key, mc.category_id
       FROM cc_expense_merchant_categories mc
       WHERE mc.account_id = ?`
    )
    .run(targetAccountId, legacyAccountId);
  return r.changes;
}

/** Capture assignments before statement lines are deleted (reimport). */
export function snapshotCcExpenseCategories(accountId: number): CcExpenseCategorySnapshot {
  const lineCategoryByParserRowId = new Map<string, number>();
  const lineRows = db
    .prepare(
      `SELECT l.parser_row_id, lc.category_id
       FROM cc_expense_line_categories lc
       JOIN cc_statement_lines l ON l.id = lc.statement_line_id
       JOIN cc_statements s ON s.id = l.statement_id
       WHERE s.account_id = ?
         AND l.parser_row_id IS NOT NULL
         AND TRIM(l.parser_row_id) != ''`
    )
    .all(accountId) as { parser_row_id: string; category_id: number }[];

  for (const r of lineRows) {
    lineCategoryByParserRowId.set(String(r.parser_row_id).trim(), r.category_id);
  }

  const uniqueCategoryByStablePurchaseKey = new Map<string, number | null>();
  const uniqueRows = db
    .prepare(
      `SELECT purchase_key, category_id FROM cc_expense_unique_purchases WHERE account_id = ?`
    )
    .all(accountId) as { purchase_key: string; category_id: number | null }[];

  const lineIds = db
    .prepare(
      `SELECT l.id FROM cc_statement_lines l
       JOIN cc_statements s ON s.id = l.statement_id
       WHERE s.account_id = ?`
    )
    .all(accountId) as { id: number }[];

  const stableKeysSeen = new Set<string>();
  for (const { id } of lineIds) {
    const ctx = loadCcStatementLineExpenseCtx(id);
    if (!ctx) continue;
    const stableKey = stableCcExpensePurchaseKeyFromCtx(ctx);
    stableKeysSeen.add(stableKey);
  }

  for (const u of uniqueRows) {
    const stableKey = migrateStoredPurchaseKeyToStable(accountId, u.purchase_key, stableKeysSeen);
    if (!stableKey) continue;
    uniqueCategoryByStablePurchaseKey.set(stableKey, u.category_id);
  }

  return { lineCategoryByParserRowId, uniqueCategoryByStablePurchaseKey };
}

function migrateStoredPurchaseKeyToStable(
  accountId: number,
  storedKey: string,
  stableKeysSeen: Set<string>
): string | null {
  if (storedKey.startsWith("installment-h:") || storedKey.startsWith("line-pr:")) {
    return storedKey;
  }
  if (storedKey.startsWith("installment-pr:")) {
    return storedKey;
  }
  if (storedKey.startsWith("line:")) {
    const oldId = Number(storedKey.slice("line:".length));
    if (!Number.isFinite(oldId)) return null;
    const ctx = loadCcStatementLineExpenseCtx(oldId);
    if (!ctx || ctx.account_id !== accountId) return null;
    return stableCcExpensePurchaseKeyFromCtx(ctx);
  }
  if (storedKey.startsWith("installment:")) {
    const purchaseId = Number(storedKey.slice("installment:".length));
    if (!Number.isFinite(purchaseId)) return null;
    const parserRows = db
      .prepare(
        `SELECT parser_row_id FROM cc_installment_payments
         WHERE purchase_id = ?
           AND parser_row_id IS NOT NULL
           AND parser_row_id NOT LIKE 'synthetic:%'
         LIMIT 1`
      )
      .get(purchaseId) as { parser_row_id: string } | undefined;
    if (!parserRows) return null;
    const line = db
      .prepare(
        `SELECT l.id FROM cc_statement_lines l
         JOIN cc_statements s ON s.id = l.statement_id
         WHERE s.account_id = ? AND l.parser_row_id = ?`
      )
      .get(accountId, parserRows.parser_row_id) as { id: number } | undefined;
    if (!line) return null;
    const ctx = loadCcStatementLineExpenseCtx(line.id);
    return ctx ? stableCcExpensePurchaseKeyFromCtx(ctx) : null;
  }
  if (stableKeysSeen.has(storedKey)) return storedKey;
  return null;
}

/** Re-apply assignments after new statement lines are inserted. */
export function restoreCcExpenseCategories(
  accountId: number,
  snap: CcExpenseCategorySnapshot
): { lineCategories: number; uniquePurchases: number } {
  const insLine = db.prepare(
    `INSERT INTO cc_expense_line_categories (statement_line_id, category_id)
     VALUES (?, ?)
     ON CONFLICT(statement_line_id) DO UPDATE SET category_id = excluded.category_id`
  );
  const upsertUnique = db.prepare(
    `INSERT INTO cc_expense_unique_purchases (account_id, purchase_key, category_id)
     VALUES (?, ?, ?)
     ON CONFLICT(account_id, purchase_key) DO UPDATE SET category_id = excluded.category_id`
  );
  const delOrphanLineKeys = db.prepare(
    `DELETE FROM cc_expense_unique_purchases
     WHERE account_id = ?
       AND (purchase_key LIKE 'line:%' OR purchase_key LIKE 'installment:%')`
  );

  let lineCategories = 0;
  let uniquePurchases = 0;

  const tx = db.transaction(() => {
    delOrphanLineKeys.run(accountId);

    const newLines = db
      .prepare(
        `SELECT l.id, l.parser_row_id
         FROM cc_statement_lines l
         JOIN cc_statements s ON s.id = l.statement_id
         WHERE s.account_id = ?
           AND l.parser_row_id IS NOT NULL
           AND TRIM(l.parser_row_id) != ''`
      )
      .all(accountId) as { id: number; parser_row_id: string }[];

    for (const l of newLines) {
      const catId = snap.lineCategoryByParserRowId.get(String(l.parser_row_id).trim());
      if (catId == null) continue;
      insLine.run(l.id, catId);
      lineCategories += 1;
    }

    for (const [purchaseKey, categoryId] of snap.uniqueCategoryByStablePurchaseKey) {
      upsertUnique.run(accountId, purchaseKey, categoryId);
      uniquePurchases += 1;
    }
  });
  tx();

  return { lineCategories, uniquePurchases };
}
