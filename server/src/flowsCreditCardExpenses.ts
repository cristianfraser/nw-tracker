import { monthEndUtcYmd, monthKeyFromYmd, ymCompare } from "./calendarMonth.js";

import { billingMonthForStatementDate } from "./ccBillingMonth.js";

import {

  countsTowardCcExpenseGastosMes,

  isCcExpenseTotalsExcludedSlug,

  categoryUniqueForExpenseLine,

  listCcExpenseCategories,

  loadCcExpenseCategoryMaps,

  normalizeCcExpenseMerchantKey,

  NO_CUENTA_CC_EXPENSE_SLUG,

  primaryCreditCardExpensesGroupSlug,

  registerGenericUniquePurchaseMode,

  resolveCcExpenseCategorySlug,

  resolveCcExpensePurchaseKey,

  type CcExpenseCategoryRow,

} from "./ccExpenseCategories.js";
import {
  applyAdditionalCardNoCuentaForLine,
  formatAutoAdditionalCardNote,
  isAdditionalCardExpenseLine,
  userDeclinedAutoCategoryForPurchase,
} from "./ccAdditionalCardExpenseMatch.js";

import { oneShotStatementLineIdsSupersededByInstallmentPurchases } from "./ccCrossImportDedupe.js";

import {

  redundantInstallmentSummaryLineIds,

  type CcStatementLineForInstallmentTotals,

} from "./ccInstallmentLineDedupe.js";

import {
  effectiveCcExpenseLineAmountClp,
  effectiveCcExpenseLineAmountUsd,
} from "./ccExpenseAmountClp.js";
import { expenseGastosAmountUsdAtDate } from "./flowMoneyAtDate.js";

import { parseDdMmYyToIso } from "./ccInstallmentPayBy.js";

import { db } from "./db.js";

import { enrichFlowLinesWithOriginLabels } from "./ccExpenseOriginLabel.js";
import { enrichFlowLinesWithPurchaseNotes } from "./ccExpensePurchaseNotes.js";
import {
  enrichFlowLinesWithBigGroups,
  listCcExpenseBigGroups,
  type CcExpenseBigGroupRow,
} from "./ccExpenseBigGroups.js";
import { dedupeFlowCcExpenseLines } from "./ccExpenseLineDedupe.js";
import {
  enrichLinesWithNotaDeCreditoPairing,
  pairNotaDeCreditoAnnulments,
  purchaseCountsAfterNotaPairing,
  type NotaDeCreditoRole,
} from "./ccNotaDeCreditoPairing.js";
import { buildInstallmentPaymentGastosLines } from "./ccInstallmentPaymentGastosLines.js";
import { mergeInstallmentPurchaseTotalsIntoLines } from "./ccInstallmentPurchaseTotalLines.js";
import {
  type CcExpenseLineRole,
  type CcInstallmentGastosMode,
  gastosSumMonthForLine,
  lineCountsTowardGastosSum,
  periodMonthsForGastosLine,
  purchaseMonthFromLine,
} from "./ccExpensePeriodMonth.js";

export type { CcExpenseLineRole, CcInstallmentGastosMode } from "./ccExpensePeriodMonth.js";
import { buildCheckingGastosLines } from "./flowsCheckingGastos.js";

import { listMovementBalanceCashAccountIds } from "./movementBalanceCashAccounts.js";



export { effectiveCcExpenseLineAmountClp } from "./ccExpenseAmountClp.js";

import { listCreditCardMasterAccountIds } from "./creditCardTree.js";

export { listCreditCardMasterAccountIds };



export type FlowCcExpenseLineSource = "cc" | "checking";



export type FlowCcExpenseLineRow = {

  source: FlowCcExpenseLineSource;

  /** CC statement line id or checking movement id. */

  statement_line_id: number;

  account_id: number;

  /** Calendar month bucket for gastos (YYYY-MM). */

  expense_month: string;

  /** Facturación month for CC lines; same as expense_month for checking. */

  billing_month: string;

  /** Statement close (CC) or movement date (checking), ISO. */

  occurred_on: string;

  /** Purchase / transaction date (ISO). */

  purchase_on: string | null;

  /** Raw statement close (DD/MM/YYYY); empty for checking. */

  statement_date: string;

  amount_clp: number;

  /** Original USD when the charge is on a USD statement (or USD-only line). */
  amount_usd: number | null;

  /** USD for gastos display: native USD or CLP ÷ FX on purchase / movement date. */
  amount_usd_at_expense: number | null;

  merchant: string | null;

  merchant_key: string;

  category_slug: string;

  category_unique: boolean;

  installment_flag: number;

  nro_cuota_current: number | null;

  nro_cuota_total: number | null;

  /** Calendar month of purchase (YYYY-MM). */
  purchase_month: string;

  line_role: CcExpenseLineRole;

  /** Set when a NOTA DE CREDITO annuls or adjusts prior card charges. */
  nota_credito_role?: NotaDeCreditoRole;

  /** Statement line id used for category / unique PATCH (installment purchase totals). */
  category_statement_line_id?: number | null;

  /** Stable purchase identity (cuota, one-shot, synthetic total). */
  purchase_key: string;

  /** User note for this purchase (shared across cuotas / synthetic total). */
  purchase_notes: string;

  /** Optional big expense group (trip, remodeling, etc.). */
  big_group_slug: string | null;

  /** Display label for origin column (card last4 or account name). */
  origin_label: string;

  /** Physical card that made the charge (CLP statement line); null = primary / unknown. */
  origin_card_last4: string | null;

  /** Statement billing card (`cc_statements.card_last4`); null for checking / synthetic lines. */
  primary_card_last4: string | null;

};

export type FlowCcExpenseLineRowDraft = Omit<
  FlowCcExpenseLineRow,
  "origin_label" | "purchase_key" | "purchase_notes" | "big_group_slug"
> & {
  /** Checking-only: distinct purchase_key for deposit-paired portion of a movement. */
  checking_purchase_portion?: "deposit";
  /** Ephemeral auto-match note merged into purchase_notes at enrich time. */
  auto_deposit_match_note?: string;
  auto_additional_card_note?: string;
};

export type FlowCcExpenseMonthRow = {

  period_month: string;

  as_of_date: string;

  /** Sum of positive charges excluding `no_cuenta` and `deposits`. */

  gastos_mes_clp: number;

  /** All positive charges in the month (includes excluded categories). */

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

  big_groups: CcExpenseBigGroupRow[];

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



export function resolveExpenseMonth(
  purchaseOn: string | null,
  statementDateIso: string | null,
  billingMonth: string,
  opts?: { installment?: boolean }
): string {
  if (opts?.installment) return billingMonth;
  return (
    (purchaseOn ? monthKeyFromYmd(purchaseOn) : null) ??
    (statementDateIso ? monthKeyFromYmd(statementDateIso) : null) ??
    billingMonth
  );
}



type MonthBucket = {

  gastos: number;

  gastosReal: number;

  abonos: number;

  line_count: number;

};



export function aggregateGastosFromLines(

  lines: readonly FlowCcExpenseLineRow[],

  chartCategorySlugs: readonly string[],

  mode: CcInstallmentGastosMode = "split",

  excludedBigGroupSlugs?: ReadonlySet<string>

): {

  by_month: FlowCcExpenseMonthRow[];

  chart_monthly: FlowCcExpenseChartPoint[];

  chart_monthly_by_category: FlowCcExpenseCategoryChartPoint[];

} {

  const byMonthSum = new Map<string, MonthBucket>();

  const byMonthCategory = new Map<string, Map<string, number>>();



  const touchBucket = (month: string): MonthBucket => {
    const existing = byMonthSum.get(month);
    if (existing) return existing;
    const fresh: MonthBucket = { gastos: 0, gastosReal: 0, abonos: 0, line_count: 0 };
    byMonthSum.set(month, fresh);
    return fresh;
  };

  const pairing = pairNotaDeCreditoAnnulments(lines);

  for (const ln of lines) {
    const sumMonth = gastosSumMonthForLine(ln, mode);
    const amount = ln.amount_clp;
    const lineId = ln.statement_line_id;
    const countsCategory = countsTowardCcExpenseGastosMes(ln.category_slug, {
      installment_flag: ln.installment_flag,
      nro_cuota_current: ln.nro_cuota_current,
    });

    if (pairing.annulledPurchaseIds.has(lineId) || pairing.matchedNotaIds.has(lineId)) {
      for (const periodMonth of periodMonthsForGastosLine(ln)) {
        touchBucket(periodMonth).line_count += 1;
      }
      continue;
    }

    if (pairing.unmatchedNotaIds.has(lineId)) {
      if (sumMonth) {
        touchBucket(sumMonth).gastos += amount;
      }
      for (const periodMonth of periodMonthsForGastosLine(ln)) {
        touchBucket(periodMonth).line_count += 1;
      }
      continue;
    }

    if (sumMonth) {
      const sumBucket = touchBucket(sumMonth);
      if (amount > 0) {
        sumBucket.gastosReal += amount;
        if (
          purchaseCountsAfterNotaPairing(ln) &&
          lineCountsTowardGastosSum(ln, mode, countsCategory)
        ) {
          sumBucket.gastos += amount;
          const skipChartCategory =
            ln.big_group_slug != null &&
            excludedBigGroupSlugs?.has(ln.big_group_slug) === true;
          if (!skipChartCategory) {
            const catBucket = byMonthCategory.get(sumMonth) ?? new Map<string, number>();
            catBucket.set(ln.category_slug, (catBucket.get(ln.category_slug) ?? 0) + amount);
            byMonthCategory.set(sumMonth, catBucket);
          }
        }
      } else {
        sumBucket.abonos += amount;
      }
    }

    for (const periodMonth of periodMonthsForGastosLine(ln)) {
      touchBucket(periodMonth).line_count += 1;
    }
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



  return { by_month, chart_monthly, chart_monthly_by_category };

}



function computeFlowsExpenseTotals(
  lines: readonly FlowCcExpenseLineRow[],
  mode: CcInstallmentGastosMode = "split"
): { total_clp: number; total_real_clp: number } {
  let total_clp = 0;
  let total_real_clp = 0;
  for (const r of lines) {
    if (r.nota_credito_role === "annulled_purchase" || r.nota_credito_role === "matched_nota") {
      continue;
    }
    if (r.nota_credito_role === "unmatched_nota") {
      total_clp += r.amount_clp;
      if (r.amount_clp > 0) total_real_clp += r.amount_clp;
      continue;
    }
    if (r.amount_clp <= 0) continue;
    const countsCategory = countsTowardCcExpenseGastosMes(r.category_slug, {
      installment_flag: r.installment_flag,
      nro_cuota_current: r.nro_cuota_current,
    });
    if (
      purchaseCountsAfterNotaPairing(r) &&
      lineCountsTowardGastosSum(r, mode, countsCategory)
    ) {
      total_clp += r.amount_clp;
    }
    if (gastosSumMonthForLine(r, mode)) {
      total_real_clp += r.amount_clp;
    }
  }
  return { total_clp: Math.round(total_clp), total_real_clp: Math.round(total_real_clp) };
}



export function buildCcExpenseLines(
  accountIds: number[],
  opts?: { dedupeDisplay?: boolean }
): FlowCcExpenseLineRowDraft[] {
  const dedupeDisplay = opts?.dedupeDisplay !== false;

  const { lineOverrides, merchantRules, uniquePurchases, uniquePurchaseModeKeys } =

    loadCcExpenseCategoryMaps(accountIds);



  const userClearedUniqueAtLoad = new Set(uniquePurchaseModeKeys);

  const ph = accountIds.map(() => "?").join(",");

  const dbLines = db

    .prepare(

      `SELECT l.id AS statement_line_id, s.id AS statement_id, s.account_id, s.statement_date,

              s.currency AS statement_currency, s.card_last4 AS primary_card_last4,

              l.transaction_date, l.posting_date, l.origin_card_last4,

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

    primary_card_last4: string | null;

    origin_card_last4: string | null;

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



  const supersededByInstallmentPurchases = new Set<number>();

  for (const accountId of accountIds) {

    for (const id of oneShotStatementLineIdsSupersededByInstallmentPurchases(accountId)) {

      supersededByInstallmentPurchases.add(id);

    }

  }



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

        nro_cuota_current: r.nro_cuota_current,

        nro_cuota_total: r.nro_cuota_total,

        statement_currency: r.statement_currency,

        fx_date_iso: fxDateIso,

      } satisfies CcStatementLineForInstallmentTotals;

    })

  );



  const lines: FlowCcExpenseLineRowDraft[] = [];



  for (const row of dbLines) {

    if (redundantSummaryIds.has(row.statement_line_id)) continue;

    if (supersededByInstallmentPurchases.has(row.statement_line_id)) continue;



    const statementDateIso = isoFromDdMmYyyy(row.statement_date);

    if (!statementDateIso) continue;



    const billingMonth = billingMonthForStatementDate(statementDateIso);

    if (!billingMonth) continue;



    const amount = effectiveCcExpenseLineAmountClp(row, statementDateIso);

    if (amount == null || amount === 0) continue;

    const amountUsd = effectiveCcExpenseLineAmountUsd(row);

    const purchaseOn =

      isoFromDdMmYyyy(row.transaction_date) ?? isoFromDdMmYyyy(row.posting_date);

    const expenseFxDate = purchaseOn ?? statementDateIso;
    const amountUsdAtExpense =
      amount == null
        ? null
        : expenseGastosAmountUsdAtDate(amount, amountUsd, expenseFxDate);

    const isInstallment = row.installment_flag === 1;
    const expenseMonth = resolveExpenseMonth(purchaseOn, statementDateIso, billingMonth, {
      installment: isInstallment,
    });
    const purchaseMonth = purchaseMonthFromLine(purchaseOn, expenseMonth);
    const lineRole: CcExpenseLineRole = isInstallment ? "installment_cuota" : "purchase";

    const merchantKey = normalizeCcExpenseMerchantKey(row.merchant);

    const purchaseKey = resolveCcExpensePurchaseKey(row.statement_line_id);

    registerGenericUniquePurchaseMode(
      row.account_id,
      purchaseKey,
      merchantKey,
      uniquePurchaseModeKeys,
      { statementLineId: row.statement_line_id }
    );

    const categorySlug = resolveCcExpenseCategorySlug({

      statementLineId: row.statement_line_id,

      accountId: row.account_id,

      merchantKey,

      purchaseKey,

      lineOverrides,

      merchantRules,

      uniquePurchases,

      uniquePurchaseModeKeys,

    });

    let resolvedCategorySlug = categorySlug;
    let categoryUnique = categoryUniqueForExpenseLine(
      row.account_id,
      purchaseKey,
      merchantKey,
      uniquePurchases,
      uniquePurchaseModeKeys
    );
    let autoAdditionalCardNote: string | undefined;

    const purchaseMapKey = `${row.account_id}|${purchaseKey}`;
    const userClearedUnique = userClearedUniqueAtLoad.has(purchaseMapKey);
    const existingUniqueSlug = uniquePurchases.get(purchaseMapKey);
    if (
      !isInstallment &&
      isAdditionalCardExpenseLine(row.origin_card_last4, row.primary_card_last4) &&
      !userClearedUnique &&
      existingUniqueSlug == null &&
      !userDeclinedAutoCategoryForPurchase(row.account_id, purchaseKey)
    ) {
      const additionalCard = applyAdditionalCardNoCuentaForLine({
        accountId: row.account_id,
        statementLineId: row.statement_line_id,
        originCardLast4: row.origin_card_last4,
        primaryCardLast4: row.primary_card_last4,
        skipIfUserCleared: true,
      });
      if (additionalCard.applied) {
        resolvedCategorySlug = NO_CUENTA_CC_EXPENSE_SLUG;
        categoryUnique = true;
        uniquePurchases.set(purchaseMapKey, NO_CUENTA_CC_EXPENSE_SLUG);
        const origin = String(row.origin_card_last4 ?? "").trim();
        const primary = String(row.primary_card_last4 ?? "").trim();
        const note = formatAutoAdditionalCardNote({ originLast4: origin, primaryLast4: primary });
        if (note) autoAdditionalCardNote = note;
      }
    }



    lines.push({

      source: "cc",

      statement_line_id: row.statement_line_id,

      account_id: row.account_id,

      expense_month: expenseMonth,

      billing_month: billingMonth,

      purchase_month: purchaseMonth,

      line_role: lineRole,

      occurred_on: statementDateIso,

      purchase_on: purchaseOn,

      statement_date: row.statement_date,

      amount_clp: amount,

      amount_usd: amountUsd,

      amount_usd_at_expense: amountUsdAtExpense,

      merchant: row.merchant,

      installment_flag: isInstallment ? 1 : 0,

      nro_cuota_current: row.nro_cuota_current,

      nro_cuota_total: row.nro_cuota_total,

      merchant_key: merchantKey,

      category_slug: resolvedCategorySlug,

      category_unique: categoryUnique,

      origin_card_last4: row.origin_card_last4,

      primary_card_last4: row.primary_card_last4,

      ...(autoAdditionalCardNote ? { auto_additional_card_note: autoAdditionalCardNote } : {}),

    });

  }

  const statementLines = dedupeDisplay ? dedupeFlowCcExpenseLines(lines) : lines;
  const withLedgerCuotas = [
    ...statementLines,
    ...buildInstallmentPaymentGastosLines(accountIds, statementLines),
  ];
  const cuotaLines = dedupeDisplay ? dedupeFlowCcExpenseLines(withLedgerCuotas) : withLedgerCuotas;
  return mergeInstallmentPurchaseTotalsIntoLines(cuotaLines, accountIds, {
    lineOverrides,
    merchantRules,
    uniquePurchases,
    uniquePurchaseModeKeys,
  });
}

function loadCheckingGastosLinesForExpenses(): FlowCcExpenseLineRowDraft[] {
  const accountIds = listMovementBalanceCashAccountIds();
  if (accountIds.length === 0) return [];

  const { merchantRules, uniquePurchases, uniquePurchaseModeKeys } =
    loadCcExpenseCategoryMaps(accountIds);

  const lines: FlowCcExpenseLineRowDraft[] = [];
  for (const accountId of accountIds) {
    lines.push(
      ...buildCheckingGastosLines({
        accountId,
        merchantRules,
        uniquePurchases,
        uniquePurchaseModeKeys,
      })
    );
  }
  return lines;
}

export function buildFlowsCreditCardExpensesPayload(): FlowsCreditCardExpensesPayload {

  const accountIds = listCreditCardMasterAccountIds();

  const categories = listCcExpenseCategories();

  const chartCategorySlugs = categories

    .map((c) => c.slug)

    .filter((slug) => !isCcExpenseTotalsExcludedSlug(slug));



  if (accountIds.length === 0) {
    const checkingLines = enrichFlowLinesWithOriginLabels(
      enrichFlowLinesWithBigGroups(
        enrichFlowLinesWithPurchaseNotes(loadCheckingGastosLinesForExpenses())
      )
    );
    const agg = aggregateGastosFromLines(checkingLines, chartCategorySlugs);
    const totals = computeFlowsExpenseTotals(checkingLines);

    return {

      group_slug: primaryCreditCardExpensesGroupSlug(),

      account_ids: [],

      categories,

      big_groups: listCcExpenseBigGroups(),

      lines: checkingLines,

      ...agg,

      ...totals,

    };

  }



  const ccLines = buildCcExpenseLines(accountIds);
  const checkingLines = loadCheckingGastosLinesForExpenses();
  const lines = enrichFlowLinesWithOriginLabels(
    enrichFlowLinesWithBigGroups(
      enrichFlowLinesWithPurchaseNotes(
        enrichLinesWithNotaDeCreditoPairing([...ccLines, ...checkingLines])
      )
    )
  );

  const { by_month, chart_monthly, chart_monthly_by_category } = aggregateGastosFromLines(

    lines,

    chartCategorySlugs

  );

  const totals = computeFlowsExpenseTotals(lines);



  return {

    group_slug: primaryCreditCardExpensesGroupSlug(),

    account_ids: accountIds,

    categories,

    big_groups: listCcExpenseBigGroups(),

    lines,

    by_month,

    chart_monthly,

    chart_monthly_by_category,

    ...totals,

  };

}


