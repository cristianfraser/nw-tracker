import { db } from "./db.js";
import {
  legacyInstallmentHPurchaseKey,
  listInstallmentPurchaseSiblingStatementLineIds,
  loadCcStatementLineExpenseCtx,
  stableCcExpensePurchaseKeyFromCtx,
  stableInstallmentHPurchaseKeyFromLedgerArgs,
} from "./ccExpenseCategories.js";
import {
  merchantsMatchForCrossDedupe,
  purchaseAmountsMatch,
} from "./ccCrossImportDedupe.js";
import { isInstallmentContractSummaryMerchant } from "./ccInstallmentLineDedupe.js";
import { parseDdMmYyToIso } from "./ccInstallmentPayBy.js";
import { recomputeCcBillingMonthBalances } from "./ccBillingBalances.js";
import { upsertCreditCardValuationsFromLedger } from "./ccCreditCardValuations.js";
import { statementKeyFromRow, type CcStatementCsvRecord } from "./ccStatementsImport.js";

const findStmtId = db.prepare(
  `SELECT id FROM cc_statements
   WHERE account_id = ? AND card_group = ? AND source_pdf = ? AND statement_date = ?`
);

const listManualPurchases = db.prepare(
  `SELECT id, card_group, purchase_date, total_amount_clp, cuotas_totales, merchant
   FROM cc_installment_purchases
   WHERE account_id = ? AND source = 'manual'`
);

const listInstallmentLinesForStatement = db.prepare(
  `SELECT l.id, l.installment_flag, l.merchant, l.transaction_date, l.posting_date,
          l.nro_cuota_total, l.nro_cuota_current, l.amount_clp, l.valor_cuota_mensual_clp
   FROM cc_statement_lines l
   WHERE l.statement_id = ? AND l.installment_flag = 1`
);

const loadStatementMeta = db.prepare(
  `SELECT id, account_id, card_group, source_pdf, period_from, period_to
   FROM cc_statements WHERE id = ?`
);

const delManualPurchase = db.prepare(
  `DELETE FROM cc_installment_purchases WHERE id = ? AND account_id = ? AND source = 'manual'`
);

const delUniqueByKey = db.prepare(
  `DELETE FROM cc_expense_unique_purchases WHERE account_id = ? AND purchase_key = ?`
);

const selUniqueCat = db.prepare(
  `SELECT category_id FROM cc_expense_unique_purchases WHERE account_id = ? AND purchase_key = ?`
);

const insLineCat = db.prepare(
  `INSERT INTO cc_expense_line_categories (statement_line_id, category_id)
   VALUES (?, ?)
   ON CONFLICT(statement_line_id) DO UPDATE SET category_id = excluded.category_id`
);

const upsertUniqueCat = db.prepare(
  `INSERT INTO cc_expense_unique_purchases (account_id, purchase_key, category_id)
   VALUES (?, ?, ?)
   ON CONFLICT(account_id, purchase_key) DO UPDATE SET category_id = excluded.category_id`
);

function purchaseIsoFromLineFields(transaction_date: string | null, posting_date: string | null): string | null {
  return (
    parseDdMmYyToIso(String(transaction_date ?? "").trim()) ??
    parseDdMmYyToIso(String(posting_date ?? "").trim()) ??
    null
  );
}

function isIsoInInclusivePeriod(iso: string, periodFrom: string | null, periodTo: string | null): boolean {
  const fromIso =
    parseDdMmYyToIso(String(periodFrom ?? "").trim()) ??
    (/^\d{4}-\d{2}-\d{2}$/.test(String(periodFrom ?? "").trim())
      ? String(periodFrom).trim()
      : null);
  const toIso =
    parseDdMmYyToIso(String(periodTo ?? "").trim()) ??
    (/^\d{4}-\d{2}-\d{2}$/.test(String(periodTo ?? "").trim())
      ? String(periodTo).trim()
      : null);
  if (!fromIso || !toIso) return false;
  return iso >= fromIso && iso <= toIso;
}

function contractAmountClpFromLine(line: {
  amount_clp: number | null;
  valor_cuota_mensual_clp: number | null;
}): number {
  const a = Math.abs(line.amount_clp ?? 0);
  const v = Math.abs(line.valor_cuota_mensual_clp ?? 0);
  return Math.max(a, v);
}

function manualMatchesInstallmentLine(
  manual: {
    purchase_date: string;
    total_amount_clp: number;
    cuotas_totales: number;
    merchant: string | null;
  },
  line: {
    merchant: string | null;
    transaction_date: string | null;
    posting_date: string | null;
    nro_cuota_total: number | null;
    nro_cuota_current: number | null;
    amount_clp: number | null;
    valor_cuota_mensual_clp: number | null;
  }
): boolean {
  if (!merchantsMatchForCrossDedupe(manual.merchant, line.merchant)) return false;
  const lineNt = line.nro_cuota_total;
  if (lineNt != null && lineNt > 0 && manual.cuotas_totales !== lineNt) return false;
  const contractAmt = contractAmountClpFromLine(line);
  if (!purchaseAmountsMatch(manual.total_amount_clp, contractAmt)) return false;

  const lineIso = purchaseIsoFromLineFields(line.transaction_date, line.posting_date);
  if (lineIso && lineIso === manual.purchase_date) return true;

  const cur = line.nro_cuota_current;
  const isContractResumen = cur == null || cur === 0;
  return isContractResumen && purchaseAmountsMatch(manual.total_amount_clp, contractAmt);
}

function resolveCategoryIdForManualPurchase(accountId: number, manualId: number, manualKey: string | null): number | null {
  if (manualKey) {
    const r = selUniqueCat.get(accountId, manualKey) as { category_id: number } | undefined;
    if (r?.category_id != null) return r.category_id;
    // Fall back to the pre-amount (legacy) installment-h key so categories stored before the
    // key gained the total-amount segment still resolve.
    const legacy = legacyInstallmentHPurchaseKey(manualKey);
    if (legacy) {
      const rLegacy = selUniqueCat.get(accountId, legacy) as { category_id: number } | undefined;
      if (rLegacy?.category_id != null) return rLegacy.category_id;
    }
  }
  const instKey = `installment:${manualId}`;
  const r2 = selUniqueCat.get(accountId, instKey) as { category_id: number } | undefined;
  return r2?.category_id ?? null;
}

function applyCategoryToMatchedLines(accountId: number, matchedLineId: number, categoryId: number): void {
  const siblingIds = listInstallmentPurchaseSiblingStatementLineIds(matchedLineId);
  const seen = new Set<number>();
  for (const lineId of siblingIds) {
    if (seen.has(lineId)) continue;
    seen.add(lineId);
    insLineCat.run(lineId, categoryId);
    const ctx = loadCcStatementLineExpenseCtx(lineId);
    if (!ctx || ctx.account_id !== accountId) continue;
    const stable = stableCcExpensePurchaseKeyFromCtx(ctx);
    upsertUniqueCat.run(accountId, stable, categoryId);
  }
}

function deleteManualPurchaseExpenseKeys(accountId: number, manualId: number, manualKey: string | null): void {
  if (manualKey) delUniqueByKey.run(accountId, manualKey);
  delUniqueByKey.run(accountId, `installment:${manualId}`);
}

export type CcManualInstallmentReconcileResult = {
  statements_considered: number;
  matched: number;
  deleted: number;
  categories_transferred: number;
};

/**
 * Resolves statement DB ids touched by this import batch (PDF sources only).
 */
export function collectStatementIdsFromImportRecords(
  accountId: number,
  records: readonly CcStatementCsvRecord[]
): number[] {
  const keys = new Set<string>();
  for (const r of records) {
    const src = String(r.source_pdf ?? "").trim();
    if (!src || src.startsWith("import:web-paste")) continue;
    keys.add(statementKeyFromRow(r));
  }
  const ids: number[] = [];
  for (const k of keys) {
    const parts = k.split("\t");
    const card_group = parts[0] ?? "A";
    const source_pdf = parts[1] ?? "";
    const statement_date = parts[2] ?? "";
    const row = findStmtId.get(accountId, card_group, source_pdf, statement_date) as
      | { id: number }
      | undefined;
    if (row) ids.push(row.id);
  }
  return ids;
}

/**
 * After PDF statements and installment ledger are merged: delete manual purchases that
 * duplicate a statement installment line (date + amount + merchant, purchase date inside
 * statement facturación period), and carry category assignments to the PDF-backed lines.
 */
export function reconcileManualInstallmentPurchasesForStatements(
  accountId: number,
  statementIds: readonly number[]
): CcManualInstallmentReconcileResult {
  if (statementIds.length === 0) {
    return { statements_considered: 0, matched: 0, deleted: 0, categories_transferred: 0 };
  }

  let matched = 0;
  let deleted = 0;
  let categoriesTransferred = 0;

  const run = db.transaction(() => {
    const manuals = listManualPurchases.all(accountId) as {
      id: number;
      card_group: string;
      purchase_date: string;
      total_amount_clp: number;
      cuotas_totales: number;
      merchant: string | null;
    }[];

    const consumedLineIds = new Set<number>();
    const consumedManualIds = new Set<number>();

    for (const stmtId of statementIds) {
      const st = loadStatementMeta.get(stmtId) as
        | {
            id: number;
            account_id: number;
            card_group: string;
            source_pdf: string;
            period_from: string | null;
            period_to: string | null;
          }
        | undefined;
      if (!st || st.account_id !== accountId) continue;
      if (String(st.source_pdf ?? "").trim().startsWith("import:web-paste")) continue;

      const lines = listInstallmentLinesForStatement.all(stmtId) as {
        id: number;
        installment_flag: number;
        merchant: string | null;
        transaction_date: string | null;
        posting_date: string | null;
        nro_cuota_total: number | null;
        nro_cuota_current: number | null;
        amount_clp: number | null;
        valor_cuota_mensual_clp: number | null;
      }[];

      for (const manual of manuals) {
        if (consumedManualIds.has(manual.id)) continue;
        if (String(manual.card_group ?? "A").trim() !== String(st.card_group ?? "A").trim()) continue;
        if (!isIsoInInclusivePeriod(manual.purchase_date, st.period_from, st.period_to)) continue;

        const manualKey = stableInstallmentHPurchaseKeyFromLedgerArgs({
          accountId,
          purchaseDateIso: manual.purchase_date,
          cuotasTotales: manual.cuotas_totales,
          totalAmountClp: manual.total_amount_clp,
          merchant: manual.merchant,
        });

        let hitLineId: number | null = null;
        for (const line of lines) {
          if (consumedLineIds.has(line.id)) continue;
          if (isInstallmentContractSummaryMerchant(String(line.merchant ?? ""))) continue;
          if (!manualMatchesInstallmentLine(manual, line)) continue;
          hitLineId = line.id;
          break;
        }
        if (hitLineId == null) continue;

        consumedLineIds.add(hitLineId);
        consumedManualIds.add(manual.id);
        matched += 1;

        const categoryId = resolveCategoryIdForManualPurchase(accountId, manual.id, manualKey);
        if (categoryId != null) {
          applyCategoryToMatchedLines(accountId, hitLineId, categoryId);
          categoriesTransferred += 1;
        }

        deleteManualPurchaseExpenseKeys(accountId, manual.id, manualKey);
        delManualPurchase.run(manual.id, accountId);
        deleted += 1;
      }
    }
  });

  run();

  if (deleted > 0) {
    upsertCreditCardValuationsFromLedger(accountId);
    recomputeCcBillingMonthBalances(accountId);
  }

  return {
    statements_considered: statementIds.length,
    matched,
    deleted,
    categories_transferred: categoriesTransferred,
  };
}

export function reconcileManualInstallmentPurchasesAfterStatementImport(
  accountId: number,
  records: readonly CcStatementCsvRecord[]
): CcManualInstallmentReconcileResult {
  const ids = collectStatementIdsFromImportRecords(accountId, records);
  return reconcileManualInstallmentPurchasesForStatements(accountId, ids);
}
