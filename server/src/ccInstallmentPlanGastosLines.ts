import {
  categoryUniqueForExpenseLine,
  loadCcExpenseCategoryMaps,
  normalizeCcExpenseMerchantKey,
  registerGenericUniquePurchaseMode,
  resolveCcExpenseCategorySlug,
  stableInstallmentHPurchaseKeyFromLedgerArgs,
} from "./ccExpenseCategories.js";
import { ccLedgerMonthEndIso, installmentPlanBreakdownByMonth } from "./ccInstallmentLedgerDb.js";
import {
  installmentCuotaCoverageKeys,
  installmentCuotaSlotCovered,
} from "./ccInstallmentPaymentGastosLines.js";
import type { FlowCcExpenseLineRowDraft } from "./flowsCreditCardExpenses.js";
import { expenseGastosAmountUsdAtDate } from "./flowMoneyAtDate.js";
import { purchaseMonthFromLine } from "./ccExpensePeriodMonth.js";
import { db } from "./db.js";

const PLAN_LINE_ID_OFFSET = 3_000_000_000;

export function installmentPlanGastosLineId(purchaseDbId: number, installmentIndex: number): number {
  return -PLAN_LINE_ID_OFFSET - purchaseDbId * 1_000 - installmentIndex;
}

/** Returns the cc_installment_purchases.id encoded in a plan gastos line id, or null if not a plan line. */
export function purchaseIdFromPlanGastosLineId(lineId: number): number | null {
  if (lineId >= -PLAN_LINE_ID_OFFSET) return null;
  return Math.floor((-lineId - PLAN_LINE_ID_OFFSET) / 1_000);
}

type PurchaseMeta = {
  id: number;
  account_id: number;
  canonical_row_id: string;
  purchase_date: string;
  merchant: string | null;
  cuotas_totales: number;
  total_amount_clp: number;
};

function loadPurchaseMetaByCanonicalId(accountIds: number[]): Map<string, PurchaseMeta> {
  if (accountIds.length === 0) return new Map();
  const ph = accountIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT id, account_id, canonical_row_id, purchase_date, merchant, cuotas_totales, total_amount_clp
       FROM cc_installment_purchases
       WHERE account_id IN (${ph})`
    )
    .all(...accountIds) as PurchaseMeta[];
  const out = new Map<string, PurchaseMeta>();
  for (const row of rows) {
    out.set(row.canonical_row_id, row);
  }
  return out;
}

/**
 * Scheduled installment cuotas from the purchase plan when no statement PDF or
 * ledger payment row covers that slot (e.g. open billing month before next PDF).
 */
export function buildInstallmentPlanGastosLines(
  accountIds: number[],
  existingLines: readonly FlowCcExpenseLineRowDraft[]
): FlowCcExpenseLineRowDraft[] {
  if (accountIds.length === 0) return [];

  const coverage = installmentCuotaCoverageKeys(existingLines);
  const purchaseByCanonicalId = loadPurchaseMetaByCanonicalId(accountIds);
  const { lineOverrides, merchantRules, uniquePurchases, uniquePurchaseModeKeys } =
    loadCcExpenseCategoryMaps(accountIds);

  const lines: FlowCcExpenseLineRowDraft[] = [];

  for (const accountId of accountIds) {
    const breakdownByMonth = installmentPlanBreakdownByMonth(accountId);
    for (const [billingMonth, breakdown] of breakdownByMonth) {
      const occurredOn = ccLedgerMonthEndIso(billingMonth);
      for (const slot of breakdown) {
        const purchase = purchaseByCanonicalId.get(slot.purchase_id);
        if (!purchase || purchase.account_id !== accountId) continue;

        const purchaseOn =
          purchase.purchase_date.length >= 10
            ? purchase.purchase_date.slice(0, 10)
            : purchase.purchase_date;
        const merchant = slot.label.trim() || purchase.merchant;
        const merchantKey = normalizeCcExpenseMerchantKey(merchant);
        const amount = Math.round(slot.amount_clp);
        const cuotaCurrent = slot.installment_index + 1;
        const cuotaTotal = slot.installment_count;

        if (
          installmentCuotaSlotCovered(
            {
              purchase_on: purchaseOn,
              cuota_current: cuotaCurrent,
              amount_clp: amount,
              merchant_key: merchantKey,
            },
            accountId,
            coverage
          )
        ) {
          continue;
        }

        const purchaseKey =
          stableInstallmentHPurchaseKeyFromLedgerArgs({
            accountId,
            purchaseDateIso: purchaseOn,
            cuotasTotales: cuotaTotal,
            totalAmountClp: purchase.total_amount_clp,
            merchant,
          }) ?? `installment-h:${accountId}:${purchaseOn}:${cuotaTotal}:${merchantKey}`;
        const lineId = installmentPlanGastosLineId(purchase.id, slot.installment_index);
        registerGenericUniquePurchaseMode(
          accountId,
          purchaseKey,
          merchantKey,
          uniquePurchaseModeKeys,
          { statementLineId: lineId }
        );
        const categorySlug = resolveCcExpenseCategorySlug({
          statementLineId: lineId,
          accountId,
          merchantKey,
          purchaseKey,
          lineOverrides,
          merchantRules,
          uniquePurchases,
          uniquePurchaseModeKeys,
        });
        const categoryUnique = categoryUniqueForExpenseLine(
          accountId,
          purchaseKey,
          merchantKey,
          uniquePurchases,
          uniquePurchaseModeKeys
        );

        const purchaseMonth = purchaseMonthFromLine(purchaseOn, billingMonth);
        lines.push({
          source: "cc",
          statement_line_id: lineId,
          account_id: accountId,
          expense_month: billingMonth,
          billing_month: billingMonth,
          purchase_month: purchaseMonth,
          line_role: "installment_cuota",
          occurred_on: occurredOn,
          purchase_on: purchaseOn,
          statement_date: "",
          amount_clp: amount,
          amount_usd: null,
          amount_usd_at_expense: expenseGastosAmountUsdAtDate(amount, null, purchaseOn ?? occurredOn),
          merchant,
          installment_flag: 1,
          installment_total_clp: purchase.total_amount_clp,
          nro_cuota_current: cuotaCurrent,
          nro_cuota_total: cuotaTotal,
          merchant_key: merchantKey,
          category_slug: categorySlug,
          category_unique: categoryUnique,
          origin_card_last4: null,
          primary_card_last4: null,
        });
      }
    }
  }

  return lines;
}
