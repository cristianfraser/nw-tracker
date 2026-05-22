import { monthEndUtcYmd, ymCompare } from "./calendarMonth.js";
import { billingMonthForStatementDate } from "./ccBillingMonth.js";
import {
  countsTowardCcExpenseGastosMes,
  lineHasUniquePurchaseMode,
  listCcExpenseCategories,
  loadCcExpenseCategoryMaps,
  NO_CUENTA_CC_EXPENSE_SLUG,
  normalizeCcExpenseMerchantKey,
  primaryCreditCardExpensesGroupSlug,
  resolveCcExpenseCategorySlug,
  resolveCcExpensePurchaseKey,
  type CcExpenseCategoryRow,
} from "./ccExpenseCategories.js";
import {
  isInstallmentContractSummaryMerchant,
  redundantInstallmentSummaryLineIds,
  type CcStatementLineForInstallmentTotals,
} from "./ccInstallmentLineDedupe.js";
import { effectiveCcExpenseLineAmountClp } from "./ccExpenseAmountClp.js";
import { parseDdMmYyToIso } from "./ccInstallmentPayBy.js";
import { db } from "./db.js";

export { effectiveCcExpenseLineAmountClp } from "./ccExpenseAmountClp.js";
import { listCreditCardGroupOperationalAccountIds } from "./ccExpenseCategories.js";

export { listCreditCardGroupOperationalAccountIds };

export type FlowCcExpenseLineRow = {
  statement_line_id: number;
  account_id: number;
  /** Facturación month (YYYY-MM) — grouping key. */
  billing_month: string;
  /** Statement close date (ISO). */
  occurred_on: string;
  /** Original purchase / transaction date (ISO), display only. */
  purchase_on: string | null;
  /** Raw statement close (DD/MM/YYYY from import). */
  statement_date: string;
  amount_clp: number;
  merchant: string | null;
  installment_flag: number;
  nro_cuota_current: number | null;
  nro_cuota_total: number | null;
};

export type FlowCcExpenseMonthRow = {
  period_month: string;
  as_of_date: string;
  /** Sum of positive charges excluding `no_cuenta`. */
  gastos_mes_clp: number;
  /** All positive charges in the month (includes `no_cuenta`). */
  gastos_real_mes_clp: number;
  /** Sum of negative line amounts (abonos, MONTO CANCELADO, etc.). */
  abonos_mes_clp: number;
  gastos_acumulado_clp: number;
  gastos_real_acumulado_clp: number;
  line_count: number;
};

export type FlowCcExpenseChartPoint = {
  as_of_date: string;
  gastos_clp: number;
};

/** Stacked bar chart: one numeric field per category slug (positive gastos only). */
export type FlowCcExpenseCategoryChartPoint = {
  as_of_date: string;
  [categorySlug: string]: string | number;
};

export type FlowsCreditCardExpensesPayload = {
  /** `credit_card_groups.slug` (e.g. santander). */
  group_slug: string;
  account_ids: number[];
  categories: CcExpenseCategoryRow[];
  lines: FlowCcExpenseLineRow[];
  by_month: FlowCcExpenseMonthRow[];
  chart_monthly: FlowCcExpenseChartPoint[];
  chart_monthly_by_category: FlowCcExpenseCategoryChartPoint[];
  /** Positive charges excluding `no_cuenta`. */
  total_clp: number;
  /** All positive charges. */
  total_real_clp: number;
};

function isoFromDdMmYyyy(raw: string | null | undefined): string | null {
  const t = String(raw ?? "").trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  return parseDdMmYyToIso(t);
}

export function buildFlowsCreditCardExpensesPayload(): FlowsCreditCardExpensesPayload {
  const accountIds = listCreditCardGroupOperationalAccountIds();
  if (accountIds.length === 0) {
    return {
      group_slug: primaryCreditCardExpensesGroupSlug(),
      account_ids: [],
      lines: [],
      by_month: [],
      categories: listCcExpenseCategories(),
      chart_monthly_by_category: [],
      total_clp: 0,
      total_real_clp: 0,
    };
  }

  const categories = listCcExpenseCategories();
  const chartCategorySlugs = categories
    .map((c) => c.slug)
    .filter((slug) => slug !== NO_CUENTA_CC_EXPENSE_SLUG);
  const { lineOverrides, merchantRules, uniquePurchases } =
    loadCcExpenseCategoryMaps(accountIds);

  const ph = accountIds.map(() => "?").join(",");
  const dbLines = db
    .prepare(
      `SELECT l.id AS statement_line_id, s.id AS statement_id, s.account_id, s.statement_date,
              s.currency AS statement_currency,
              l.transaction_date, l.posting_date,
              l.amount_clp, l.amount_usd, l.merchant, l.installment_flag,
              l.nro_cuota_current, l.nro_cuota_total,
              l.valor_cuota_mensual_clp, l.valor_cuota_mensual_usd
       FROM cc_statement_lines l
       JOIN cc_statements s ON s.id = l.statement_id
       WHERE s.account_id IN (${ph})
         AND (
           l.amount_clp IS NOT NULL
           OR (l.amount_usd IS NOT NULL AND l.amount_usd != 0)
           OR (l.installment_flag = 1 AND l.valor_cuota_mensual_clp IS NOT NULL AND l.valor_cuota_mensual_clp != 0)
           OR (l.installment_flag = 1 AND l.valor_cuota_mensual_usd IS NOT NULL AND l.valor_cuota_mensual_usd != 0)
         )
       ORDER BY s.statement_date DESC, l.id DESC`
    )
    .all(...accountIds) as {
    statement_line_id: number;
    statement_id: number;
    account_id: number;
    statement_date: string;
    statement_currency: string;
    transaction_date: string | null;
    posting_date: string | null;
    amount_clp: number | null;
    amount_usd: number | null;
    merchant: string | null;
    installment_flag: number;
    nro_cuota_current: number | null;
    nro_cuota_total: number | null;
    valor_cuota_mensual_clp: number | null;
    valor_cuota_mensual_usd: number | null;
  }[];

  const redundantSummaryIds = redundantInstallmentSummaryLineIds(
    dbLines.map((r) => {
      const fxDateIso = isoFromDdMmYyyy(r.statement_date);
      return {
        statement_line_id: r.statement_line_id,
        account_id: r.account_id,
        statement_date: r.statement_date,
        merchant: r.merchant,
        installment_flag: r.installment_flag,
        amount_clp: r.amount_clp,
        amount_usd: r.amount_usd,
        valor_cuota_mensual_clp: r.valor_cuota_mensual_clp,
        valor_cuota_mensual_usd: r.valor_cuota_mensual_usd,
        statement_currency: r.statement_currency,
        fx_date_iso: fxDateIso,
      } satisfies CcStatementLineForInstallmentTotals;
    })
  );

  const lines: FlowCcExpenseLineRow[] = [];
  const byMonthSum = new Map<
    string,
    { gastos: number; gastosReal: number; abonos: number; line_count: number }
  >();
  const byMonthCategory = new Map<string, Map<string, number>>();

  for (const row of dbLines) {
    if (redundantSummaryIds.has(row.statement_line_id)) continue;

    const statementDateIso = isoFromDdMmYyyy(row.statement_date);
    if (!statementDateIso) continue;

    const billingMonth = billingMonthForStatementDate(statementDateIso);
    if (!billingMonth) continue;

    const amount = effectiveCcExpenseLineAmountClp(row, statementDateIso);
    if (amount == null || amount === 0) continue;

    const purchaseOn =
      isoFromDdMmYyyy(row.transaction_date) ?? isoFromDdMmYyyy(row.posting_date);

    const merchantKey = normalizeCcExpenseMerchantKey(row.merchant);
    const purchaseKey = resolveCcExpensePurchaseKey(row.statement_line_id);
    const categorySlug = resolveCcExpenseCategorySlug({
      statementLineId: row.statement_line_id,
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
      uniquePurchases
    );

    lines.push({
      statement_line_id: row.statement_line_id,
      account_id: row.account_id,
      billing_month: billingMonth,
      occurred_on: statementDateIso,
      purchase_on: purchaseOn,
      statement_date: row.statement_date,
      amount_clp: amount,
      merchant: row.merchant,
      installment_flag: row.installment_flag ? 1 : 0,
      nro_cuota_current: row.nro_cuota_current,
      nro_cuota_total: row.nro_cuota_total,
      merchant_key: merchantKey,
      category_slug: categorySlug,
      category_unique: categoryUnique,
    });

    const bucket = byMonthSum.get(billingMonth) ?? {
      gastos: 0,
      gastosReal: 0,
      abonos: 0,
      line_count: 0,
    };
    if (amount > 0) {
      bucket.gastosReal += amount;
      if (
        countsTowardCcExpenseGastosMes(categorySlug, {
          installment_flag: row.installment_flag,
          nro_cuota_current: row.nro_cuota_current,
        })
      ) {
        bucket.gastos += amount;
        const catBucket = byMonthCategory.get(billingMonth) ?? new Map<string, number>();
        catBucket.set(categorySlug, (catBucket.get(categorySlug) ?? 0) + amount);
        byMonthCategory.set(billingMonth, catBucket);
      }
    } else {
      bucket.abonos += amount;
    }
    bucket.line_count += 1;
    byMonthSum.set(billingMonth, bucket);
  }

  const monthsAsc = [...byMonthSum.keys()].sort(ymCompare);
  let runningGastos = 0;
  let runningGastosReal = 0;
  const byMonthAsc: FlowCcExpenseMonthRow[] = [];
  for (const periodMonth of monthsAsc) {
    const bucket = byMonthSum.get(periodMonth)!;
    const gastosMes = Math.round(bucket.gastos);
    const gastosRealMes = Math.round(bucket.gastosReal);
    runningGastos += gastosMes;
    runningGastosReal += gastosRealMes;
    byMonthAsc.push({
      period_month: periodMonth,
      as_of_date: monthEndUtcYmd(periodMonth),
      gastos_mes_clp: gastosMes,
      gastos_real_mes_clp: gastosRealMes,
      abonos_mes_clp: Math.round(bucket.abonos),
      gastos_acumulado_clp: Math.round(runningGastos),
      gastos_real_acumulado_clp: Math.round(runningGastosReal),
      line_count: bucket.line_count,
    });
  }

  const by_month = [...byMonthAsc].reverse();
  const chart_monthly: FlowCcExpenseChartPoint[] = byMonthAsc.map((m) => ({
    as_of_date: m.as_of_date,
    gastos_clp: m.gastos_mes_clp,
  }));

  const chart_monthly_by_category: FlowCcExpenseCategoryChartPoint[] = byMonthAsc.map((m) => {
    const point: FlowCcExpenseCategoryChartPoint = { as_of_date: m.as_of_date };
    const catSums = byMonthCategory.get(m.period_month) ?? new Map<string, number>();
    for (const slug of chartCategorySlugs) {
      point[slug] = Math.round(catSums.get(slug) ?? 0);
    }
    return point;
  });

  return {
    group_slug: primaryCreditCardExpensesGroupSlug(),
    account_ids: accountIds,
    categories,
    lines,
    by_month,
    chart_monthly,
    chart_monthly_by_category,
    total_clp: Math.round(
      lines
        .filter(
          (r) =>
            r.amount_clp > 0 &&
            countsTowardCcExpenseGastosMes(r.category_slug, {
              installment_flag: r.installment_flag,
              nro_cuota_current: r.nro_cuota_current,
            })
        )
        .reduce((s, r) => s + r.amount_clp, 0)
    ),
    total_real_clp: Math.round(
      lines.filter((r) => r.amount_clp > 0).reduce((s, r) => s + r.amount_clp, 0)
    ),
  };
}
