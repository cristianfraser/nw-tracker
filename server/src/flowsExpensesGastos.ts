/**
 * Gastos by month and category for the Expenses page (`GET /api/flows/expenses/credit-card/gastos`).
 *
 * The page offers two installment modes (Por cuota / Total) × two category levels (Categorías /
 * Subcategorías), in the display unit, with some big groups left out of the chart. Every
 * combination of mode and level is built here; the request names the unit and the excluded
 * groups. The client picks a view and only clips it to its Rango.
 */
import { monthEndUtcYmd, ymCompare } from "./calendarMonth.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { addCalendarMonths } from "./ccYearMonth.js";
import {
  isCcExpenseTotalsExcludedSlug,
  isInstallmentCuotaZeroLine,
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
  hasSplittableMortgageExpenseDepositLink,
  REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG,
} from "./expenseDepositLinks.js";
import {
  buildFlowsExpenseLines,
  type FlowCcExpenseCategoryChartPoint,
  type FlowCcExpenseChartPoint,
  type FlowCcExpenseLineRow,
  type FlowCcExpenseMonthRow,
} from "./flowsExpenses.js";

export type GastosUnit = "clp" | "usd";

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
  /** Full-history headline: every month bucket summed (unrounded in USD). */
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

export function expenseLineGastosAmount(line: FlowCcExpenseLineRow, unit: GastosUnit): number {
  if (unit === "usd") {
    if (line.amount_usd_at_expense == null) {
      throw new Error(
        `missing amount_usd_at_expense for expense line ${line.source}:${line.statement_line_id}`
      );
    }
    return line.amount_usd_at_expense;
  }
  return line.amount_clp;
}

/** Carrying (interés + seguros) share of a mortgage-linked payment, in the unit. */
function mortgageLinkCarryingAmount(
  line: FlowCcExpenseLineRow,
  link: { payment_clp: number; carrying_clp: number },
  unit: GastosUnit
): number {
  if (unit === "usd") {
    // Same fx date as the payment line: allocate the line's USD by the carrying CLP share.
    return expenseLineGastosAmount(line, unit) * (link.carrying_clp / link.payment_clp);
  }
  return link.carrying_clp;
}

/** Amortización chart segment (negative, below axis) in the unit. */
function mortgageLinkAmortizationChartAmount(
  line: FlowCcExpenseLineRow,
  link: { payment_clp: number; amortization_clp: number },
  unit: GastosUnit
): number {
  if (unit === "usd") {
    if (link.amortization_clp <= 0) return 0;
    return -(expenseLineGastosAmount(line, unit) * (link.amortization_clp / link.payment_clp));
  }
  return expenseDepositAmortizationChartAmount(link.amortization_clp);
}

/** Positive lines, and refunds, that count toward gasto del mes in the mode. */
export function countsTowardGastosMes(line: FlowCcExpenseLineRow, mode: CcInstallmentGastosMode): boolean {
  if (line.nota_credito_role === "annulled_purchase" || line.nota_credito_role === "matched_nota") {
    return false;
  }
  // Small fee adjustments affect gastos totals only, not compras / cuotas.
  if (line.nota_credito_role === "unmatched_nota") return false;
  // A refund (`checking_refund`) is spending coming back: it counts, negatively, in its category.
  if (line.amount_clp <= 0 && line.checking_refund !== true) return false;
  if (isCcExpenseTotalsExcludedSlug(line.category_slug)) return false;
  if (isInstallmentCuotaZeroLine(line)) return false;
  const scope = line.gastos_scope ?? "both";
  if (scope === "excluded") return false;
  if (scope === "total_only") return mode === "total";
  if (scope === "split_only") return mode === "split";
  if (line.line_role === "installment_purchase_total") return mode === "total";
  if (line.line_role === "installment_cuota") return mode === "split";
  return true;
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
  lines: readonly FlowCcExpenseLineRow[],
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

    if (ln.nota_credito_role === "unmatched_nota") {
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
      if (amount > 0 || ln.checking_refund === true) {
        sumBucket.gastosReal += amount;
        const skipChartCategory =
          ln.big_group_slug != null && excludedBigGroupSlugs?.has(ln.big_group_slug) === true;
        const link = ln.expense_deposit_links?.find((l) => l.depto_cuota != null);
        if (hasSplittableMortgageExpenseDepositLink(link)) {
          if (
            (ln.line_role !== "installment_purchase_total" || mode === "total") &&
            (ln.line_role !== "installment_cuota" || mode === "split")
          ) {
            const carrying = mortgageLinkCarryingAmount(ln, link, unit);
            sumBucket.gastos += carrying;
            if (!skipChartCategory) {
              if (carrying > 0) addToCategory(sumMonth, BILLS_CC_EXPENSE_SLUG, carrying);
              addToCategory(
                sumMonth,
                REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG,
                mortgageLinkAmortizationChartAmount(ln, link, unit)
              );
            }
          }
        } else if (countsTowardGastosMes(ln, mode)) {
          sumBucket.gastos += amount;
          if (!skipChartCategory) addToCategory(sumMonth, ln.category_slug, amount);
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
  let total = 0;
  let totalReal = 0;
  const byMonthAsc: FlowCcExpenseMonthRow[] = [];

  for (const periodMonth of monthsAsc) {
    const bucket = byMonthSum.get(periodMonth)!;
    total += bucket.gastos;
    totalReal += bucket.gastosReal;
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
    by_month: [...byMonthAsc].reverse(),
    chart_monthly,
    chart_monthly_by_category,
    total: unit === "clp" ? Math.round(total) : total,
    total_real: unit === "clp" ? Math.round(totalReal) : totalReal,
  };
}

/** Lines with each category replaced by the one it is stacked under at the level. */
export function linesAtCategoryLevel(
  lines: readonly FlowCcExpenseLineRow[],
  categories: readonly Pick<CcExpenseCategoryRow, "slug" | "parent_slug">[],
  level: CcExpenseCategoryLevel
): readonly FlowCcExpenseLineRow[] {
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
    if (row.gastos_real_mes_clp !== 0 && (latest == null || row.period_month > latest)) {
      latest = row.period_month;
    }
  }
  return latest;
}

/** Month rows (oldest first) rolled up to calendar years (oldest first), running totals re-run. */
export function rollupExpenseMonthRowsByYear(
  rows: readonly FlowCcExpenseMonthRow[]
): FlowCcExpenseMonthRow[] {
  const byYear = new Map<
    string,
    Omit<FlowCcExpenseMonthRow, "gastos_acumulado_clp" | "gastos_real_acumulado_clp">
  >();
  for (const row of rows) {
    const year = row.period_month.slice(0, 4);
    const cur = byYear.get(year);
    if (!cur) {
      byYear.set(year, {
        period_month: `${year}-12`,
        as_of_date: `${year}-12-31`,
        gastos_mes_clp: row.gastos_mes_clp,
        gastos_real_mes_clp: row.gastos_real_mes_clp,
        abonos_mes_clp: row.abonos_mes_clp,
        line_count: row.line_count,
      });
      continue;
    }
    cur.gastos_mes_clp += row.gastos_mes_clp;
    cur.gastos_real_mes_clp += row.gastos_real_mes_clp;
    cur.abonos_mes_clp += row.abonos_mes_clp;
    cur.line_count += row.line_count;
  }
  let runningGastos = 0;
  let runningGastosReal = 0;
  return [...byYear.keys()].sort().map((year) => {
    const row = byYear.get(year)!;
    runningGastos += row.gastos_mes_clp;
    runningGastosReal += row.gastos_real_mes_clp;
    return {
      ...row,
      gastos_acumulado_clp: Math.round(runningGastos),
      gastos_real_acumulado_clp: Math.round(runningGastosReal),
    };
  });
}

/** Sum of the visible stacks; the negative amortization segment counts as positive spend. */
function chartPointTotal(point: FlowCcExpenseCategoryChartPoint, categorySlugs: readonly string[]): number {
  let total = 0;
  for (const slug of categorySlugs) {
    const v = point[slug];
    if (typeof v === "number" && Number.isFinite(v)) total += v < 0 ? -v : v;
  }
  return Math.round(total);
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
  todayYm: string
): Record<string, ExpenseYearMonthlyAverage> {
  const lastCompleteYm = addCalendarMonths(todayYm, -1);
  const totalByYm = new Map<string, number>();
  for (const p of monthlyPoints) {
    const ym = p.as_of_date.slice(0, 7);
    totalByYm.set(ym, (totalByYm.get(ym) ?? 0) + chartPointTotal(p, categorySlugs));
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
    out[String(year)] = { from_ym: fromYm, through_ym: throughYm, avg: Math.round(sum / months) };
  }
  return out;
}

export function buildFlowsExpensesGastosViews(
  lines: readonly FlowCcExpenseLineRow[],
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
        by_year: rollupExpenseMonthRowsByYear([...by_month].reverse()).reverse(),
        chart_monthly_by_category: chartPoints,
        ...(chart !== table
          ? { chart_sort_monthly_by_category: throughChartEnd(table.chart_monthly_by_category) }
          : {}),
        year_averages: expenseYearMonthlyAverages(chartPoints, slugs, todayYm),
      };
    }
  }
  return { unit, excluded_big_groups: [...excludedBigGroupSlugs].sort(), views };
}

export function buildFlowsExpensesGastosPayload(
  unit: GastosUnit,
  excludedBigGroupSlugs: ReadonlySet<string>
): FlowsExpensesGastosPayload {
  return buildFlowsExpensesGastosViews(
    buildFlowsExpenseLines(),
    listCcExpenseCategories(),
    unit,
    excludedBigGroupSlugs,
    chileCalendarTodayYmd().slice(0, 7)
  );
}
