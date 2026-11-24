/**
 * Gastos by month and category for the Expenses page (`GET /api/flows/expenses/gastos`).
 *
 * The page offers two installment modes (Por cuota / Total) × two category levels (Categorías /
 * Subcategorías), in the display unit, with some big groups left out of the chart. Every
 * combination of mode and level is built here; the request names the unit and the excluded
 * groups. The client picks a view and only clips it to its Rango.
 */
import { monthEndUtcYmd, ymCompare } from "./calendarMonth.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import {
  isCcExpenseTotalsExcludedSlug,
  listCcExpenseCategories,
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
import { listCcExpenseBigGroups, type CcExpenseBigGroupRow } from "./ccExpenseBigGroups.js";
import { buildFlowsExpenseLines, isPreTaxExpenseLine } from "./flowsExpenses.js";
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
import { addCalendarMonths } from "nw-tracker-contracts";
import { isHomeCurrency, roundToCurrency } from "./displayUnits.js";
import type { FlowCcExpenseLineRow as WireExpenseLine, LineUnitValue, Money } from "nw-tracker-contracts/dto/flows";
import { lineValueIn } from "./lineMoney.js";

/** The display unit a gastos view is built in: any core currency code. */
export type GastosUnit = string;

/**
 * A finished expense line as the gastos views read it: wire or server-side (the server's carries
 * the builder fields beside its money). Its value in a unit is `values[unit]` (`lineValueIn`).
 */
export type GastosLine = Omit<WireExpenseLine, "amount" | "converted" | "value_clp" | "name" | "name_detail" | "refund_of"> & {
  amount?: Money;
  values?: Record<string, LineUnitValue>;
};

/** Which level the chart groups spend by: at «category» a subcategory folds into its parent. */
export type CcExpenseCategoryLevel = "category" | "subcategory";

export const CC_INSTALLMENT_GASTOS_MODES: readonly CcInstallmentGastosMode[] = ["split", "total"];
export const CC_EXPENSE_CATEGORY_LEVELS: readonly CcExpenseCategoryLevel[] = ["category", "subcategory"];

export function gastosViewKey(mode: CcInstallmentGastosMode, level: CcExpenseCategoryLevel): string {
  return `${mode}|${level}`;
}

/** One calendar year's average monthly gastos, and the months it covers (YYYY-MM, inclusive). */
export type ExpenseYearMonthlyAverage = { from_ym: string; through_ym: string; avg: number };

export type FlowsExpensesGastosView = {
  /** The chart's stack keys, in stack order. */
  chart_category_slugs: string[];
  /** Full-history headline: every month bucket summed, rounded to the unit's minor digits. */
  total: number;
  total_real: number;
  /** Month rows, newest first, through the latest month with real spend in this mode. */
  by_month: FlowCcExpenseMonthRow[];
  /** The same rows rolled up to calendar years, newest first. */
  by_year: FlowCcExpenseMonthRow[];
  /**
   * Monthly stacks, oldest first, through the chart's end month (the same in both modes, so
   * toggling never shrinks the x-axis), without the excluded big groups.
   */
  chart_monthly_by_category: FlowCcExpenseCategoryChartPoint[];
  /** The stacks with every big group, for a stable stack order. Absent = `chart_monthly_by_category`. */
  chart_sort_monthly_by_category?: FlowCcExpenseCategoryChartPoint[];
  /** Per-year average of the chart's monthly total, keyed by year (YYYY). */
  year_averages: Record<string, ExpenseYearMonthlyAverage>;
};

export type FlowsExpensesGastosPayload = {
  unit: GastosUnit;
  excluded_big_groups: string[];
  /** Keyed `gastosViewKey(mode, level)`. */
  views: Record<string, FlowsExpensesGastosView>;
};

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

/** Month rows (oldest first) rolled up to calendar years (oldest first), running totals re-run; sums rounded to the unit's minor digits. */
export function rollupExpenseMonthRowsByYear(
  rows: readonly FlowCcExpenseMonthRow[],
  unit: GastosUnit
): FlowCcExpenseMonthRow[] {
  const byYear = new Map<
    string,
    Omit<FlowCcExpenseMonthRow, "gastos_acumulado" | "gastos_real_acumulado">
  >();
  for (const row of rows) {
    const year = row.period_month.slice(0, 4);
    const cur = byYear.get(year);
    if (!cur) {
      byYear.set(year, {
        period_month: `${year}-12`,
        as_of_date: `${year}-12-31`,
        gastos_mes: row.gastos_mes,
        gastos_real_mes: row.gastos_real_mes,
        abonos_mes: row.abonos_mes,
        line_count: row.line_count,
      });
      continue;
    }
    cur.gastos_mes += row.gastos_mes;
    cur.gastos_real_mes += row.gastos_real_mes;
    cur.abonos_mes += row.abonos_mes;
    cur.line_count += row.line_count;
  }
  let runningGastos = 0;
  let runningGastosReal = 0;
  return [...byYear.keys()].sort().map((year) => {
    const row = byYear.get(year)!;
    runningGastos += row.gastos_mes;
    runningGastosReal += row.gastos_real_mes;
    return {
      ...row,
      gastos_mes: roundToCurrency(row.gastos_mes, unit),
      gastos_real_mes: roundToCurrency(row.gastos_real_mes, unit),
      abonos_mes: roundToCurrency(row.abonos_mes, unit),
      gastos_acumulado: roundToCurrency(runningGastos, unit),
      gastos_real_acumulado: roundToCurrency(runningGastosReal, unit),
    };
  });
}

/** Sum of the visible stacks; the negative amortization segment counts as positive spend. */
function chartPointTotal(
  point: FlowCcExpenseCategoryChartPoint,
  categorySlugs: readonly string[],
  unit: GastosUnit
): number {
  let total = 0;
  for (const slug of categorySlugs) {
    const v = point[slug];
    if (typeof v === "number" && Number.isFinite(v)) total += v < 0 ? -v : v;
  }
  return roundToCurrency(total, unit);
}

/**
 * Average monthly gastos per calendar year, over FULL history (the client's Rango only decides
 * which part of each year's line is drawn):
 *
 * - The monthly figure is the chart's total (the stacks summed), so the average sits on the line
 *   it summarizes.
 * - Only complete months count: the current month and the future months Por cuota projects are
 *   left out, so the current year reads the average through last month.
 * - The first year starts at the first month with any spend; a month without a point inside a
 *   covered span counts as 0.
 */
export function expenseYearMonthlyAverages(
  monthlyPoints: readonly FlowCcExpenseCategoryChartPoint[],
  categorySlugs: readonly string[],
  todayYm: string,
  unit: GastosUnit
): Record<string, ExpenseYearMonthlyAverage> {
  const lastCompleteYm = addCalendarMonths(todayYm, -1);
  const totalByYm = new Map<string, number>();
  for (const p of monthlyPoints) {
    const ym = p.as_of_date.slice(0, 7);
    totalByYm.set(ym, (totalByYm.get(ym) ?? 0) + chartPointTotal(p, categorySlugs, unit));
  }
  let firstYm: string | null = null;
  for (const [ym, total] of totalByYm) {
    if (total !== 0 && ym <= lastCompleteYm && (firstYm == null || ym < firstYm)) firstYm = ym;
  }
  const out: Record<string, ExpenseYearMonthlyAverage> = {};
  if (firstYm == null) return out;

  for (let year = Number(firstYm.slice(0, 4)); year <= Number(lastCompleteYm.slice(0, 4)); year++) {
    const fromYm = `${year}-01` < firstYm ? firstYm : `${year}-01`;
    const throughYm = `${year}-12` > lastCompleteYm ? lastCompleteYm : `${year}-12`;
    let sum = 0;
    let months = 0;
    for (let ym = fromYm; ym <= throughYm; ym = addCalendarMonths(ym, 1)) {
      sum += totalByYm.get(ym) ?? 0;
      months++;
    }
    out[String(year)] = { from_ym: fromYm, through_ym: throughYm, avg: roundToCurrency(sum / months, unit) };
  }
  return out;
}

export function buildFlowsExpensesGastosViews(
  lines: readonly GastosLine[],
  categories: readonly Pick<CcExpenseCategoryRow, "slug" | "parent_slug">[],
  unit: GastosUnit,
  excludedBigGroupSlugs: ReadonlySet<string>,
  todayYm: string
): FlowsExpensesGastosPayload {
  // The chart's x-axis ends where Por cuota's real spend ends, in both modes: Total keeps the
  // future months that only carry projected cuotas so the toggle never shrinks the axis.
  const splitEnd = latestRealSpendMonth(aggregateGastosFromLines(lines, [], "split", undefined, unit).by_month);

  const views: Record<string, FlowsExpensesGastosView> = {};
  for (const level of CC_EXPENSE_CATEGORY_LEVELS) {
    const levelLines = linesAtCategoryLevel(lines, categories, level);
    const slugs = chartCategorySlugsAtLevel(categories, level);
    for (const mode of CC_INSTALLMENT_GASTOS_MODES) {
      const table = aggregateGastosFromLines(levelLines, slugs, mode, undefined, unit);
      const chart =
        excludedBigGroupSlugs.size > 0
          ? aggregateGastosFromLines(levelLines, slugs, mode, excludedBigGroupSlugs, unit)
          : table;

      // Table rows beyond the latest real spend are dropped: in Total mode the cuota lines
      // leave $0 future buckets.
      const latestNonEmpty = latestRealSpendMonth(table.by_month);
      const chartEnd =
        mode === "split" || splitEnd == null || (latestNonEmpty != null && splitEnd <= latestNonEmpty)
          ? latestNonEmpty
          : splitEnd;
      const throughChartEnd = (points: readonly FlowCcExpenseCategoryChartPoint[]) =>
        points.filter((p) => chartEnd == null || p.as_of_date.slice(0, 7) <= chartEnd);

      const by_month = table.by_month.filter(
        (r) => latestNonEmpty == null || r.period_month <= latestNonEmpty
      );
      const chartPoints = throughChartEnd(chart.chart_monthly_by_category);
      views[gastosViewKey(mode, level)] = {
        chart_category_slugs: slugs,
        total: table.total,
        total_real: table.total_real,
        by_month,
        by_year: rollupExpenseMonthRowsByYear([...by_month].reverse(), unit).reverse(),
        chart_monthly_by_category: chartPoints,
        ...(chart !== table
          ? { chart_sort_monthly_by_category: throughChartEnd(table.chart_monthly_by_category) }
          : {}),
        year_averages: expenseYearMonthlyAverages(chartPoints, slugs, todayYm, unit),
      };
    }
  }
  return { unit, excluded_big_groups: [...excludedBigGroupSlugs].sort(), views };
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

/**
 * The Expenses page's gastos: spending from net pay, so the deductions taken from a payslip
 * ({@link isPreTaxExpenseLine}) are left out unless `includePreTax`. The flows overview builds its
 * own views over every line (`flowsOverview.ts`), where they count.
 */
export function buildFlowsExpensesGastosPayload(
  unit: GastosUnit,
  excludedBigGroupSlugs: ReadonlySet<string>,
  includePreTax: boolean,
  allLines: FlowCcExpenseLineRow[] = buildFlowsExpenseLines()
): FlowsExpensesGastosPayload & {
  include_pre_tax: boolean;
  big_group_usage: Record<CcInstallmentGastosMode, BigGroupUsage[]>;
} {
  const lines = includePreTax ? allLines : allLines.filter((l) => !isPreTaxExpenseLine(l));
  return {
    include_pre_tax: includePreTax,
    ...buildFlowsExpensesGastosViews(
      lines,
      listCcExpenseCategories(),
      unit,
      excludedBigGroupSlugs,
      chileCalendarTodayYmd().slice(0, 7)
    ),
    big_group_usage: bigGroupUsageByMode(lines, listCcExpenseBigGroups(), unit),
  };
}
