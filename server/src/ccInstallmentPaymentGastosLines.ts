import { monthKeyFromYmd } from "./calendarMonth.js";
import { billingMonthForStatementDate } from "./ccBillingMonth.js";
import {
  lineHasUniquePurchaseMode,
  loadCcExpenseCategoryMaps,
  normalizeCcExpenseMerchantKey,
  resolveCcExpenseCategorySlug,
} from "./ccExpenseCategories.js";
import { purchaseAmountsMatch } from "./ccCrossImportDedupe.js";
import { merchantStemForInstallmentDedupe } from "./ccInstallmentLineDedupe.js";
import type { FlowCcExpenseLineRow } from "./flowsCreditCardExpenses.js";
import type { CcExpenseLineRole } from "./ccExpensePeriodMonth.js";
import { db } from "./db.js";
import { purchaseMonthFromLine } from "./ccExpensePeriodMonth.js";

const PAYMENT_LINE_ID_OFFSET = 2_000_000_000;

export function installmentPaymentGastosLineId(paymentId: number): number {
  return -PAYMENT_LINE_ID_OFFSET - paymentId;
}

function cuotaCoverageKey(opts: {
  account_id: number;
  purchase_on: string | null;
  nro_cuota_current: number | null;
  merchant_key: string;
  amount_clp: number;
}): string {
  return [
    opts.account_id,
    opts.purchase_on ?? "",
    opts.nro_cuota_current ?? "",
    opts.merchant_key,
    opts.amount_clp,
  ].join("\t");
}

function statementCuotaCoverageKeys(lines: readonly FlowCcExpenseLineRow[]): Set<string> {
  const keys = new Set<string>();
  for (const ln of lines) {
    if (ln.line_role !== "installment_cuota" || ln.statement_line_id <= 0) continue;
    keys.add(
      cuotaCoverageKey({
        account_id: ln.account_id,
        purchase_on: ln.purchase_on,
        nro_cuota_current: ln.nro_cuota_current,
        merchant_key: ln.merchant_key,
        amount_clp: ln.amount_clp,
      })
    );
    const stem = merchantStemForInstallmentDedupe(ln.merchant);
    if (stem) {
      keys.add(
        [
          ln.account_id,
          ln.purchase_on ?? "",
          ln.nro_cuota_current ?? "",
          normalizeCcExpenseMerchantKey(stem),
          ln.amount_clp,
        ].join("\t")
      );
    }
  }
  return keys;
}

function paymentCoveredByStatementLine(
  pay: {
    purchase_on: string;
    cuota_current: number | null;
    amount_clp: number;
    merchant_key: string;
  },
  accountId: number,
  coverage: Set<string>
): boolean {
  const exact = cuotaCoverageKey({
    account_id: accountId,
    purchase_on: pay.purchase_on,
    nro_cuota_current: pay.cuota_current,
    merchant_key: pay.merchant_key,
    amount_clp: pay.amount_clp,
  });
  if (coverage.has(exact)) return true;
  for (const key of coverage) {
    const [acc, purchaseOn, cuota, merchant, amt] = key.split("\t");
    if (Number(acc) !== accountId) continue;
    if (purchaseOn !== pay.purchase_on) continue;
    if (cuota !== String(pay.cuota_current ?? "")) continue;
    if (merchant !== pay.merchant_key && !merchantsStemMatchKey(merchant, pay.merchant_key)) continue;
    if (purchaseAmountsMatch(Number(amt), pay.amount_clp)) return true;
  }
  return false;
}

function merchantsStemMatchKey(a: string, b: string): boolean {
  const sa = merchantStemForInstallmentDedupe(a);
  const sb = merchantStemForInstallmentDedupe(b);
  if (!sa || !sb) return false;
  const ua = sa.toUpperCase();
  const ub = sb.toUpperCase();
  return ua === ub || ua.startsWith(ub) || ub.startsWith(ua);
}

type PaymentRow = {
  payment_id: number;
  account_id: number;
  pay_by_date: string;
  statement_date: string | null;
  amount_clp: number;
  cuota_current: number | null;
  cuota_total: number | null;
  purchase_date: string;
  merchant: string | null;
};

/**
 * Installment cuota lines from `cc_installment_payments` when statement PDF lines are missing
 * or sparse (e.g. Santander 4242 ledger without full reimport).
 */
export function buildInstallmentPaymentGastosLines(
  accountIds: number[],
  existingStatementLines: readonly FlowCcExpenseLineRow[]
): FlowCcExpenseLineRow[] {
  if (accountIds.length === 0) return [];

  const coverage = statementCuotaCoverageKeys(existingStatementLines);
  const { lineOverrides, merchantRules, uniquePurchases, uniquePurchaseModeKeys } =
    loadCcExpenseCategoryMaps(accountIds);

  const ph = accountIds.map(() => "?").join(",");
  const payments = db
    .prepare(
      `SELECT p.id AS payment_id, pr.account_id, p.pay_by_date, p.statement_date,
              p.amount_clp, p.cuota_current, p.cuota_total,
              pr.purchase_date, pr.merchant
       FROM cc_installment_payments p
       JOIN cc_installment_purchases pr ON pr.id = p.purchase_id
       WHERE pr.account_id IN (${ph})
         AND p.amount_clp > 0
       ORDER BY p.pay_by_date, p.id`
    )
    .all(...accountIds) as PaymentRow[];

  const lines: FlowCcExpenseLineRow[] = [];
  const seenPayment = new Set<number>();

  for (const row of payments) {
    if (seenPayment.has(row.payment_id)) continue;
    seenPayment.add(row.payment_id);

    const payByIso =
      row.pay_by_date.length >= 10 ? row.pay_by_date.slice(0, 10) : row.pay_by_date;
    const billingMonth =
      billingMonthForStatementDate(payByIso) ?? monthKeyFromYmd(payByIso);
    if (!billingMonth) continue;

    const purchaseOn =
      row.purchase_date.length >= 10 ? row.purchase_date.slice(0, 10) : row.purchase_date;
    const merchantKey = normalizeCcExpenseMerchantKey(row.merchant);
    const amount = Math.round(row.amount_clp);

    if (
      paymentCoveredByStatementLine(
        {
          purchase_on: purchaseOn,
          cuota_current: row.cuota_current,
          amount_clp: amount,
          merchant_key: merchantKey,
        },
        row.account_id,
        coverage
      )
    ) {
      continue;
    }

    const purchaseKey =
      row.cuota_total != null && row.cuota_total > 0
        ? `installment-h:${row.account_id}:${purchaseOn}:${row.cuota_total}:${merchantKey}`
        : `line-fallback:${row.account_id}:${merchantKey}:${purchaseOn}`;
    const lineId = installmentPaymentGastosLineId(row.payment_id);
    const categorySlug = resolveCcExpenseCategorySlug({
      statementLineId: lineId,
      accountId: row.account_id,
      merchantKey,
      purchaseKey,
      lineOverrides,
      merchantRules,
      uniquePurchases,
    });
    const categoryUnique = lineHasUniquePurchaseMode(
      row.account_id,
      purchaseKey,
      uniquePurchases,
      uniquePurchaseModeKeys
    );

    const expenseMonth = billingMonth;
    const purchaseMonth = purchaseMonthFromLine(purchaseOn, expenseMonth);
    const lineRole: CcExpenseLineRole = "installment_cuota";
    const stmtDate = row.statement_date?.trim() ?? "";

    lines.push({
      source: "cc",
      statement_line_id: lineId,
      account_id: row.account_id,
      expense_month: expenseMonth,
      billing_month: billingMonth,
      purchase_month: purchaseMonth,
      line_role: lineRole,
      occurred_on: payByIso,
      purchase_on: purchaseOn,
      statement_date: stmtDate,
      amount_clp: amount,
      amount_usd: null,
      merchant: row.merchant,
      installment_flag: 1,
      nro_cuota_current: row.cuota_current,
      nro_cuota_total: row.cuota_total,
      merchant_key: merchantKey,
      category_slug: categorySlug,
      category_unique: categoryUnique,
    });
  }

  return lines;
}
