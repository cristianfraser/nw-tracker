/**
 * The gastos rule over finished expense lines: what each line adds to gasto del mes in a mode
 * (`gastosShareOfLine`), the month buckets and category stacks (`aggregateGastosFromLines`), the
 * flows overview's month rows (`gastosMonthRows`) and each big group's usage. The Expenses page's
 * spend by day (`flowsExpensesSpent.ts`) shares the same per-line rule.
 */
import { monthEndUtcYmd, ymCompare } from "./calendarMonth.js";
import {
  isCcExpenseTotalsExcludedSlug,
  type CcExpenseCategoryRow,
} from "./ccExpenseCategories.js";
import {
  gastosSumMonthForLine,
  periodMonthsForGastosLine,
  type CcInstallmentGastosMode,
} from "./ccExpensePeriodMonth.js";
import {
  BILLS_CC_EXPENSE_SLUG,
  chartCategorySlugsForFlowsExpenses,
  expenseDepositAmortizationChartAmount,
  splittableMortgageLinkOf,
  REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG,
} from "./expenseDepositLinks.js";
import type { CcExpenseBigGroupRow } from "./ccExpenseBigGroups.js";
import type {
  FlowCcExpenseCategoryChartPoint,
  FlowCcExpenseChartPoint,
  FlowCcExpenseLineRow,
  FlowCcExpenseMonthRow,
} from "./expenseLineTypes.js";
import {
  countsTowardGastosMes,
  expenseLineSignedValue,
  isGastosRefundLine,
  type GastosMesLine,
  type SignedExpenseLine,
} from "./gastosMesCounting.js";

export { splittableMortgageLinkOf };
export { countsTowardGastosMes, expenseLineSignedValue, isGastosRefundLine };
export type { GastosMesLine, SignedExpenseLine };
import { isHomeCurrency, roundToCurrency } from "./displayUnits.js";
import type { FlowCcExpenseLineRow as WireExpenseLine, LineUnitValue, Money } from "nw-tracker-contracts/dto/flows";
import { lineValueIn } from "./lineMoney.js";

/** The display unit a gastos view is built in: any core currency code. */
export type GastosUnit = string;

/**
 * A finished expense line as the gastos views read it: wire or server-side (the server's carries
 * the builder fields beside its money). Its value in a unit is `values[unit]` (`lineValueIn`).
 */
export type GastosLine = Omit<WireExpenseLine, "amount" | "converted" | "value_clp" | "name" | "name_detail" | "refund_of" | "refund_suggestion"> & {
  amount?: Money;
  values?: Record<string, LineUnitValue>;
};

/** Which level the chart groups spend by: at «category» a subcategory folds into its parent. */
export type CcExpenseCategoryLevel = "category" | "subcategory";

export const CC_INSTALLMENT_GASTOS_MODES: readonly CcInstallmentGastosMode[] = ["split", "total"];
/**
 * A finished line's value in the display unit (`lineValueIn`, the «line money» step). Throws when
 * the line has no value in the unit (no rate on file for its day).
 */
export function expenseLineGastosAmount(
  line: Pick<FlowCcExpenseLineRow, "values" | "source" | "statement_line_id">,
  unit: string
): number {
  const v = lineValueIn(line, unit);
  if (v == null) {
    throw new Error(`expense line ${line.source}:${line.statement_line_id} has no value in ${unit}`);
  }
  return v;
}

/**
 * Whether a mortgage-linked line counts in the installment mode: an installment purchase total
 * only in «Total», a cuota only in «Por cuota», anything else in both.
 */
export function mortgageLinkedLineCountsInMode(
  line: Pick<FlowCcExpenseLineRow, "line_role">,
  mode: CcInstallmentGastosMode
): boolean {
  if (line.line_role === "installment_purchase_total") return mode === "total";
  if (line.line_role === "installment_cuota") return mode === "split";
  return true;
}

/** Carrying (interés + seguros) share of a mortgage-linked payment, in the unit. */
export function mortgageLinkCarryingAmount(
  line: Pick<FlowCcExpenseLineRow, "values" | "source" | "statement_line_id">,
  link: { payment_clp: number; carrying_clp: number },
  unit: GastosUnit
): number {
  if (!isHomeCurrency(unit)) {
    // Same fx date as the payment line: allocate the line's value by the carrying CLP share.
    return expenseLineGastosAmount(line, unit) * (link.carrying_clp / link.payment_clp);
  }
  return link.carrying_clp;
}

/** Amortización chart segment (negative, below axis) in the unit. */
function mortgageLinkAmortizationChartAmount(
  line: Pick<FlowCcExpenseLineRow, "values" | "source" | "statement_line_id">,
  link: { payment_clp: number; amortization_clp: number },
  unit: GastosUnit
): number {
  if (!isHomeCurrency(unit)) {
    if (link.amortization_clp <= 0) return 0;
    return -(expenseLineGastosAmount(line, unit) * (link.amortization_clp / link.payment_clp));
  }
  return expenseDepositAmortizationChartAmount(link.amortization_clp);
}

/**
 * What one line adds to its gastos month in a mode (the line already counts in the mode's month,
 * `gastosSumMonthForLine`, and is not an annulled purchase or its nota): a positive line or a
 * refund is spend — all of it in «total real», its gasto-del-mes share in `gastos` and the chart
 * stacks it lands in (a mortgage-linked payment: carrying in bills, amortization below zero) —;
 * any other negative line is an abono. The gastos views and the spent-day views read this one rule.
 */
export type GastosLineShare =
  | { kind: "spend"; real: number; gastos: number; stacks: Array<readonly [string, number]> }
  | { kind: "abono"; amount: number };

export function gastosShareOfLine(
  ln: GastosLine,
  mode: CcInstallmentGastosMode,
  unit: GastosUnit,
  amount: number = expenseLineGastosAmount(ln, unit)
): GastosLineShare {
  if (!(amount > 0 || isGastosRefundLine(ln))) return { kind: "abono", amount };
  const link = splittableMortgageLinkOf(ln);
  if (link) {
    if (!mortgageLinkedLineCountsInMode(ln, mode)) return { kind: "spend", real: amount, gastos: 0, stacks: [] };
    const carrying = mortgageLinkCarryingAmount(ln, link, unit);
    const stacks: Array<readonly [string, number]> = [];
    if (carrying > 0) stacks.push([BILLS_CC_EXPENSE_SLUG, carrying]);
    stacks.push([REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG, mortgageLinkAmortizationChartAmount(ln, link, unit)]);
    return { kind: "spend", real: amount, gastos: carrying, stacks };
  }
  if (countsTowardGastosMes(ln, mode)) {
    return { kind: "spend", real: amount, gastos: amount, stacks: [[ln.category_slug, amount]] };
  }
  return { kind: "spend", real: amount, gastos: 0, stacks: [] };
}

export type GastosAggregate = {
  by_month: FlowCcExpenseMonthRow[];
  chart_monthly: FlowCcExpenseChartPoint[];
  chart_monthly_by_category: FlowCcExpenseCategoryChartPoint[];
  total: number;
  total_real: number;
};

/**
 * Month buckets and category stacks. `total` / `total_real` are the sums of the month buckets —
 * the Expenses headline — so the headline and the table count every line by the same rule.
 * Lines carry the category they are stacked under (see {@link linesAtCategoryLevel}).
 */
export function aggregateGastosFromLines(
  lines: readonly GastosLine[],
  chartCategorySlugs: readonly string[],
  mode: CcInstallmentGastosMode = "split",
  excludedBigGroupSlugs?: ReadonlySet<string>,
  unit: GastosUnit = "clp"
): GastosAggregate {
  type MonthBucket = { gastos: number; gastosReal: number; abonos: number; line_count: number };

  const byMonthSum = new Map<string, MonthBucket>();
  const byMonthCategory = new Map<string, Map<string, number>>();

  const touchBucket = (month: string): MonthBucket => {
    const existing = byMonthSum.get(month);
    if (existing) return existing;
    const fresh: MonthBucket = { gastos: 0, gastosReal: 0, abonos: 0, line_count: 0 };
    byMonthSum.set(month, fresh);
    return fresh;
  };
  const addToCategory = (month: string, slug: string, amount: number): void => {
    const catBucket = byMonthCategory.get(month) ?? new Map<string, number>();
    catBucket.set(slug, (catBucket.get(slug) ?? 0) + amount);
    byMonthCategory.set(month, catBucket);
  };

  for (const ln of lines) {
    const sumMonth = gastosSumMonthForLine(ln, mode);
    const amount = expenseLineGastosAmount(ln, unit);

    if (ln.nota_credito_role === "annulled_purchase" || ln.nota_credito_role === "matched_nota") {
      for (const periodMonth of periodMonthsForGastosLine(ln)) {
        touchBucket(periodMonth).line_count += 1;
      }
      continue;
    }

    if (sumMonth) {
      const sumBucket = touchBucket(sumMonth);
      const share = gastosShareOfLine(ln, mode, unit, amount);
      if (share.kind === "spend") {
        sumBucket.gastosReal += share.real;
        sumBucket.gastos += share.gastos;
        const skipChartCategory =
          ln.big_group_slug != null && excludedBigGroupSlugs?.has(ln.big_group_slug) === true;
        if (!skipChartCategory) {
          for (const [slug, v] of share.stacks) addToCategory(sumMonth, slug, v);
        }
      } else {
        sumBucket.abonos += share.amount;
      }
    }

    for (const periodMonth of periodMonthsForGastosLine(ln)) {
      touchBucket(periodMonth).line_count += 1;
    }
  }

  const round = (v: number) => roundToCurrency(v, unit);
  const monthsAsc = [...byMonthSum.keys()].sort(ymCompare);
  let runningGastos = 0;
  let runningGastosReal = 0;
  let total = 0;
  let totalReal = 0;
  const byMonthAsc: FlowCcExpenseMonthRow[] = [];

  for (const periodMonth of monthsAsc) {
    const bucket = byMonthSum.get(periodMonth)!;
    total += bucket.gastos;
    totalReal += bucket.gastosReal;
    const gastosMes = round(bucket.gastos);
    const gastosRealMes = round(bucket.gastosReal);
    runningGastos += gastosMes;
    runningGastosReal += gastosRealMes;
    byMonthAsc.push({
      period_month: periodMonth,
      as_of_date: monthEndUtcYmd(periodMonth),
      gastos_mes: gastosMes,
      gastos_real_mes: gastosRealMes,
      abonos_mes: round(bucket.abonos),
      gastos_acumulado: round(runningGastos),
      gastos_real_acumulado: round(runningGastosReal),
      line_count: bucket.line_count,
    });
  }

  const chart_monthly: FlowCcExpenseChartPoint[] = byMonthAsc.map((m) => ({
    as_of_date: m.as_of_date,
    gastos: m.gastos_mes,
  }));
  const chart_monthly_by_category: FlowCcExpenseCategoryChartPoint[] = byMonthAsc.map((m) => {
    const point: FlowCcExpenseCategoryChartPoint = { as_of_date: m.as_of_date };
    const catSums = byMonthCategory.get(m.period_month) ?? new Map<string, number>();
    for (const slug of chartCategorySlugs) {
      point[slug] = round(catSums.get(slug) ?? 0);
    }
    return point;
  });

  return {
    by_month: [...byMonthAsc].reverse(),
    chart_monthly,
    chart_monthly_by_category,
    total: round(total),
    total_real: round(totalReal),
  };
}

/** Lines with each category replaced by the one it is stacked under at the level. */
export function linesAtCategoryLevel<L extends GastosLine>(
  lines: readonly L[],
  categories: readonly Pick<CcExpenseCategoryRow, "slug" | "parent_slug">[],
  level: CcExpenseCategoryLevel
): readonly L[] {
  if (level === "subcategory") return lines;
  const parentOf = new Map(
    categories.filter((c) => c.parent_slug != null).map((c) => [c.slug, c.parent_slug!])
  );
  return lines.map((l) => {
    const slug = parentOf.get(l.category_slug);
    return slug == null ? l : { ...l, category_slug: slug };
  });
}

/** The chart's stack keys at a level (at «category», only the top-level categories). */
export function chartCategorySlugsAtLevel(
  categories: readonly Pick<CcExpenseCategoryRow, "slug" | "parent_slug">[],
  level: CcExpenseCategoryLevel
): string[] {
  const atLevel = level === "subcategory" ? categories : categories.filter((c) => c.parent_slug == null);
  return chartCategorySlugsForFlowsExpenses(
    atLevel.map((c) => c.slug).filter((slug) => !isCcExpenseTotalsExcludedSlug(slug))
  );
}

/** Latest month (YYYY-MM) with any real spend in the rows. */
function latestRealSpendMonth(rows: readonly FlowCcExpenseMonthRow[]): string | null {
  let latest: string | null = null;
  for (const row of rows) {
    if (row.gastos_real_mes !== 0 && (latest == null || row.period_month > latest)) {
      latest = row.period_month;
    }
  }
  return latest;
}

/**
 * Gasto del mes per month in a mode (newest first), through the latest month with real spend: in
 * «Total» the cuota lines leave $0 future buckets, which are dropped. The flows overview's
 * expenses leg.
 */
export function gastosMonthRows(
  lines: readonly GastosLine[],
  mode: CcInstallmentGastosMode,
  unit: GastosUnit
): FlowCcExpenseMonthRow[] {
  const rows = aggregateGastosFromLines(lines, [], mode, undefined, unit).by_month;
  const latest = latestRealSpendMonth(rows);
  return rows.filter((r) => latest == null || r.period_month <= latest);
}

/** A big group's spend in the display unit and how many purchases it holds. */
export type BigGroupUsage = {
  slug: string;
  label: string;
  total: number;
  purchase_count: number;
};

/**
 * The big groups that hold spend, per installment mode (2026-10-28): Σ of the lines (in the unit) that
 * count toward gasto del mes in the mode, purchases counted by (account, purchase key), sorted by
 * label. The Expenses page's «Grandes gastos» section and its chart filter pick it; they used to
 * sum the lines on the client.
 */
export function bigGroupUsageByMode(
  lines: readonly GastosLine[],
  catalog: readonly Pick<CcExpenseBigGroupRow, "slug" | "label">[],
  unit: GastosUnit
): Record<CcInstallmentGastosMode, BigGroupUsage[]> {
  const labelBySlug = new Map(catalog.map((g) => [g.slug, g.label]));
  const usageFor = (mode: CcInstallmentGastosMode): BigGroupUsage[] => {
    const totals = new Map<string, number>();
    const purchases = new Map<string, Set<string>>();
    for (const ln of lines) {
      const slug = ln.big_group_slug;
      if (!slug || !countsTowardGastosMes(ln, mode)) continue;
      totals.set(slug, (totals.get(slug) ?? 0) + expenseLineGastosAmount(ln, unit));
      const set = purchases.get(slug) ?? new Set<string>();
      set.add(`${ln.account_id}|${ln.purchase_key}`);
      purchases.set(slug, set);
    }
    const label = (slug: string) => labelBySlug.get(slug) ?? slug;
    return [...totals.keys()]
      .sort((a, b) => label(a).localeCompare(label(b), "es"))
      .map((slug) => ({
        slug,
        label: label(slug),
        total: roundToCurrency(totals.get(slug) ?? 0, unit),
        purchase_count: purchases.get(slug)?.size ?? 0,
      }));
  };
  return { split: usageFor("split"), total: usageFor("total") };
}
