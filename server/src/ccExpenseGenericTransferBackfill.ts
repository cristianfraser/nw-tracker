import { db } from "./db.js";
import {
  isGenericTransferMerchantKey,
  loadCcStatementLineExpenseCtx,
  normalizeCcExpenseMerchantKey,
  stableCcExpensePurchaseKeyFromCtx,
} from "./ccExpenseCategories.js";
import { cartolaDescriptionFromNote, checkingGastosMovementPurchaseKey } from "./flowsCheckingGastos.js";
import { listCreditCardGroupMasterAccountIds } from "./creditCardTree.js";
import { cartolaCashAccountIdOptional } from "./movementBalanceCashAccounts.js";

/**
 * One-time data fix: generic TRANSFERENCIA/TRANSF purchases get a persisted Único row
 * (not a runtime default). Removes comercio-wide rules on generic transfer merchant keys.
 */
export function backfillGenericTransferUniquePurchases(): {
  inserted: number;
  merchant_rules_removed: number;
} {
  const insertIgnore = db.prepare(
    `INSERT OR IGNORE INTO cc_expense_unique_purchases (account_id, purchase_key, category_id)
     VALUES (?, ?, ?)`
  );
  const lineCategory = db.prepare(
    `SELECT category_id FROM cc_expense_line_categories WHERE statement_line_id = ?`
  );
  const hasUnique = db.prepare(
    `SELECT 1 AS o FROM cc_expense_unique_purchases WHERE account_id = ? AND purchase_key = ?`
  );
  const delMerchantRule = db.prepare(
    `DELETE FROM cc_expense_merchant_categories WHERE account_id = ? AND merchant_key = ?`
  );

  let inserted = 0;
  const seen = new Set<string>();

  const ccLines = db
    .prepare(
      `SELECT l.id AS statement_line_id
       FROM cc_statement_lines l
       JOIN cc_statements s ON s.id = l.statement_id
       WHERE l.merchant IS NOT NULL AND TRIM(l.merchant) != ''`
    )
    .all() as { statement_line_id: number }[];

  for (const { statement_line_id } of ccLines) {
    const ctx = loadCcStatementLineExpenseCtx(statement_line_id);
    if (!ctx) continue;
    const merchantKey = normalizeCcExpenseMerchantKey(ctx.merchant);
    if (!isGenericTransferMerchantKey(merchantKey)) continue;

    const purchaseKey = stableCcExpensePurchaseKeyFromCtx(ctx);
    const dedupe = `${ctx.account_id}|${purchaseKey}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);

    if (hasUnique.get(ctx.account_id, purchaseKey)) continue;

    const lc = lineCategory.get(statement_line_id) as { category_id: number } | undefined;
    const catId = lc?.category_id ?? null;
    if (insertIgnore.run(ctx.account_id, purchaseKey, catId).changes > 0) {
      inserted += 1;
    }
  }

  const checkingId = cartolaCashAccountIdOptional("cuenta_corriente");
  if (checkingId != null) {
    const movements = db
      .prepare(
        `SELECT id, note FROM movements
         WHERE account_id = ? AND amount_clp < 0`
      )
      .all(checkingId) as { id: number; note: string | null }[];

    for (const mv of movements) {
      const description = cartolaDescriptionFromNote(mv.note);
      const merchantKey = normalizeCcExpenseMerchantKey(description);
      if (!isGenericTransferMerchantKey(merchantKey)) continue;

      for (const portion of ["gastos", "deposit"] as const) {
        const purchaseKey = checkingGastosMovementPurchaseKey(mv.id, portion);
        const dedupe = `${checkingId}|${purchaseKey}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        if (hasUnique.get(checkingId, purchaseKey)) continue;
        if (insertIgnore.run(checkingId, purchaseKey, null).changes > 0) {
          inserted += 1;
        }
      }
    }
  }

  let merchant_rules_removed = 0;
  const accountIds = new Set<number>([
    ...listCreditCardGroupMasterAccountIds("santander"),
    ...listCreditCardGroupMasterAccountIds("bci"),
  ]);
  if (checkingId != null) accountIds.add(checkingId);

  for (const accountId of accountIds) {
    const rules = db
      .prepare(
        `SELECT merchant_key FROM cc_expense_merchant_categories WHERE account_id = ?`
      )
      .all(accountId) as { merchant_key: string }[];
    for (const { merchant_key } of rules) {
      if (!isGenericTransferMerchantKey(merchant_key)) continue;
      merchant_rules_removed += delMerchantRule.run(accountId, merchant_key).changes;
    }
  }

  return { inserted, merchant_rules_removed };
}
