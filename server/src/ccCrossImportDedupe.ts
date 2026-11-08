import {
  findOneShotLinesOfPlan,
  findPlanForOneShotLine,
  merchantsMatchForCrossDedupe,
  oneShotLinesSupersededByPlans,
  purchaseDateIsoFromLine,
  type CardPlanForMatching,
} from "./cards/purchases.js";
import { db } from "./db.js";
import { stableInstallmentHPurchaseKeyFromLedgerArgs } from "./ccExpenseCategories.js";
import { purchaseAmountsMatch } from "./matching/installmentAmount.js";
import { normalizeTransactionDateIso } from "./ccInstallmentPayBy.js";
import { recomputeCcBillingMonthBalances } from "./ccBillingBalances.js";
import { upsertCreditCardValuationsFromLedger } from "./ccCreditCardValuations.js";

export const selLineCategory = db.prepare<[number]>(
  `SELECT category_id FROM cc_expense_line_categories WHERE statement_line_id = ?`
);

export const upsertUniqueCat = db.prepare(
  `INSERT INTO cc_expense_unique_purchases (account_id, purchase_key, category_id)
   VALUES (?, ?, ?)
   ON CONFLICT(account_id, purchase_key) DO NOTHING`
);

export { purchaseAmountsMatch };

export function shouldSkipOneShotStatementImport(
  accountId: number,
  merchant: string | null,
  purchaseDateIso: string | null,
  amountClp: number
): boolean {
  return findPlanForOneShotLine(accountId, merchant, purchaseDateIso, amountClp) != null;
}

const dbOneShotCandidates = db.prepare<[number, number]>(
  `SELECT l.id, l.merchant, l.transaction_date, l.posting_date
   FROM cc_statement_lines l
   JOIN cc_statements s ON s.id = l.statement_id
   WHERE s.account_id = ? AND l.installment_flag = 0 AND l.amount_clp = ?`
);

// PDF statement imports scan with web-paste statements excluded: the merge's own supersede
// deletes the open bucket's in-period lines right after the line loop, so a bucket line must
// never count as "already imported" — the 2026-08 ·0101 facturación lost 9 purchases
// (1.xxx.xxx CLP) to exactly that skip+delete pair. The listing kinds are `ccStatementSourceKind.ts`'s.
const dbOneShotCandidatesNoWebPaste = db.prepare<[number, number]>(
  `SELECT l.id, l.merchant, l.transaction_date, l.posting_date
   FROM cc_statement_lines l
   JOIN cc_statements s ON s.id = l.statement_id
   WHERE s.account_id = ? AND l.installment_flag = 0 AND l.amount_clp = ?
     AND s.source_kind NOT IN ('listing_open', 'listing_other')`
);

/**
 * Returns true when an existing one-shot line has the same date, same CLP amount, and a
 * fuzzy-matching merchant — catches re-imports where the bank truncated the merchant name.
 * `excludeLineIds`: the lines this import has written into the same statement. Two lines one
 * statement prints are two charges, so a line written from it a moment ago is never the same
 * purchase: «CASTANO 890» and «CASTANO LAS CONDES 890» of 08/09/2017 are both on the 22/09/2017
 * ·0274 statement, which only adds up with both. A line already on file (a re-import of the
 * statement) still counts.
 */
export function oneShotLineFuzzyMatchExists(
  accountId: number,
  merchant: string | null,
  purchaseDateIso: string | null,
  amountClp: number,
  opts?: { excludeWebPasteSources?: boolean; excludeLineIds?: ReadonlySet<number> }
): boolean {
  if (!purchaseDateIso || amountClp <= 0) return false;
  const stmt = opts?.excludeWebPasteSources ? dbOneShotCandidatesNoWebPaste : dbOneShotCandidates;
  const rows = stmt.all(accountId, amountClp) as {
    id: number;
    merchant: string | null;
    transaction_date: string | null;
    posting_date: string | null;
  }[];
  for (const row of rows) {
    if (opts?.excludeLineIds?.has(row.id)) continue;
    const rowDateIso = purchaseDateIsoFromLine(row.transaction_date, row.posting_date);
    if (rowDateIso !== purchaseDateIso) continue;
    if (merchantsMatchForCrossDedupe(row.merchant, merchant)) return true;
  }
  return false;
}

const delLines = db.prepare(`DELETE FROM cc_statement_lines WHERE id = ?`);

/**
 * Earliest transaction date among these lines — read BEFORE deleting them. Removing evidence
 * changes past balances just as adding it does, so the stamps written after that date are
 * contradicted too.
 */
export function earliestTransactionDateForLineIds(lineIds: number[]): string | null {
  let out: string | null = null;
  const sel = db.prepare(`SELECT transaction_date FROM cc_statement_lines WHERE id = ?`);
  for (const id of lineIds) {
    const row = sel.get(id) as { transaction_date: string | null } | undefined;
    const iso = normalizeTransactionDateIso(row?.transaction_date ?? null);
    if (iso && (out == null || iso < out)) out = iso;
  }
  return out;
}

export function deleteStatementLinesByIds(lineIds: number[]): number {
  let n = 0;
  for (const id of lineIds) {
    n += delLines.run(id).changes;
  }
  return n;
}

export type CcCrossImportDedupeResult = {
  removed_line_ids: number[];
  removed_count: number;
};

export function removeOneShotLinesSupersededByInstallmentPurchases(
  accountId: number,
  opts?: { recompute?: boolean }
): CcCrossImportDedupeResult {
  const superseded = oneShotLinesSupersededByPlans(accountId);
  for (const [lineId, purchase] of superseded) {
    const cat = selLineCategory.get(lineId) as { category_id: number } | undefined;
    if (cat?.category_id != null) {
      const purchaseKey = stableInstallmentHPurchaseKeyFromLedgerArgs({
        accountId,
        purchaseDateIso: purchase.purchase_date,
        cuotasTotales: purchase.cuotas_totales,
        totalAmountClp: purchase.total_amount_clp,
        merchant: purchase.merchant,
      });
      upsertUniqueCat.run(accountId, purchaseKey, cat.category_id);
    }
  }
  const ids = [...superseded.keys()];
  const removedFrom = earliestTransactionDateForLineIds(ids);
  const removed_count = deleteStatementLinesByIds(ids);
  if (opts?.recompute !== false && removed_count > 0) {
    upsertCreditCardValuationsFromLedger(accountId, { affectedEvidenceFromYmd: removedFrom });
    recomputeCcBillingMonthBalances(accountId);
  }
  return { removed_line_ids: ids, removed_count };
}

export function removeOneShotLinesForInstallmentPurchase(
  accountId: number,
  purchaseId: number
): CcCrossImportDedupeResult {
  const purchase = db
    .prepare(
      `SELECT id, purchase_date, total_amount_clp, cuotas_totales, merchant, twin_index
       FROM cc_installment_purchases WHERE id = ? AND account_id = ?`
    )
    .get(purchaseId, accountId) as CardPlanForMatching | undefined;
  if (!purchase) return { removed_line_ids: [], removed_count: 0 };
  const ids = findOneShotLinesOfPlan(accountId, purchase);
  const removedFrom = earliestTransactionDateForLineIds(ids);
  const removed_count = deleteStatementLinesByIds(ids);
  if (removed_count > 0) {
    upsertCreditCardValuationsFromLedger(accountId, { affectedEvidenceFromYmd: removedFrom });
    recomputeCcBillingMonthBalances(accountId);
  }
  return { removed_line_ids: ids, removed_count };
}

export function backfillCcCrossImportDedupe(accountId?: number): {
  accounts: number;
  removed_total: number;
  by_account: { account_id: number; removed_count: number; removed_line_ids: number[] }[];
} {
  const accountIds =
    accountId != null
      ? [accountId]
      : (
          db
            .prepare(
              `SELECT DISTINCT account_id AS id FROM cc_installment_purchases
               UNION
               SELECT DISTINCT s.account_id AS id FROM cc_statements s`
            )
            .all() as { id: number }[]
        ).map((r) => r.id);

  const by_account: {
    account_id: number;
    removed_count: number;
    removed_line_ids: number[];
  }[] = [];
  let removed_total = 0;
  for (const id of accountIds) {
    const r = removeOneShotLinesSupersededByInstallmentPurchases(id);
    if (r.removed_count > 0) {
      by_account.push({
        account_id: id,
        removed_count: r.removed_count,
        removed_line_ids: r.removed_line_ids,
      });
      removed_total += r.removed_count;
    }
  }
  return { accounts: accountIds.length, removed_total, by_account };
}
