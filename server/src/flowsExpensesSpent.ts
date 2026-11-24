/**
 * The Expenses page by the day each expense was spent (`GET /api/flows/expenses/spent` and
 * `/spent/lines`): the month-to-date chart stacked by category, the day strip under it, the
 * calendar heat map, the month × category matrix and the line list.
 *
 * A line lands on the day it was spent ({@link spentDayOfLine}): a card purchase on its purchase
 * day, a cuota («split») on the day its statement billed it, a whole installment purchase
 * («total») on its purchase day, a checking or manual line on its day. Nothing after Chile today
 * (projected cuotas wait for their day). What a line adds is the gastos rule
 * (`gastosShareOfLine`), so a month here counts the same lines «Gasto del mes» counts, only by
 * the spending day instead of the billing month. Excluded big groups leave every figure but
 * `total_real`; a mortgage payment counts its carrying and leaves out its amortization (saving).
 */
import type {
  ExpensesSpentCell,
  ExpensesSpentChartDay,
  ExpensesSpentDay,
  ExpensesSpentLinesDay,
  ExpensesSpentMonth,
  ExpensesSpentYearAverage,
  ExpensesSpentRange,
  FlowsExpensesSpentLinesResponse,
  FlowsExpensesSpentResponse,
} from "nw-tracker-contracts/dto/flows";
import { EXPENSES_SPENT_RANGES } from "nw-tracker-contracts/dto/flows";
import { addCalendarMonths } from "nw-tracker-contracts";
import { cacheKeyFlowsInputs } from "./cacheFamilies.js";
import { getAggregationCached } from "./cacheRegistry.js";
import { listCcExpenseBigGroups } from "./ccExpenseBigGroups.js";
import { listCcExpenseCategories, type CcExpenseCategoryRow } from "./ccExpenseCategories.js";
import { gastosSumMonthForLine, type CcInstallmentGastosMode } from "./ccExpensePeriodMonth.js";
import { chileCalendarAddDays, chileCalendarTodayYmd } from "./chileDate.js";
import { roundToCurrency } from "./displayUnits.js";
import { isPreTaxExpenseLine } from "./flowsExpenses.js";
import {
  bigGroupUsageByMode,
  chartCategorySlugsAtLevel,
  gastosShareOfLine,
  linesAtCategoryLevel,
  type CcExpenseCategoryLevel,
  type GastosLine,
  type GastosUnit,
} from "./flowsExpensesGastos.js";
import { cachedFlowsExpenseLines, syncFlowsInputsWithLiveUsdRates } from "./flowsMortgageCarrying.js";
import { toWireExpenseLines } from "./wireExpenseLine.js";
import { REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG } from "./expenseDepositLinks.js";

/** Months the page shows in its matrix, calendar and month stepper (through the current one). */
export const SPENT_MONTHS = 6;

const RANGE_DAYS: Record<ExpensesSpentRange, number> = { "90d": 90, "6m": 183, "1y": 366, "5y": 1827, total: 0 };

/** A request the spent endpoints cannot serve (400). */
export class ExpensesSpentRequestError extends Error {}

export type SpentOptions = {
  unit: GastosUnit;
  mode: CcInstallmentGastosMode;
  level: CcExpenseCategoryLevel;
  excludedBigGroups: ReadonlySet<string>;
  includePreTax: boolean;
};

/**
 * The day a line was spent in the mode, or null when it does not count in the mode's months
 * (`gastosSumMonthForLine`: scope and line role) or is an annulled purchase or its nota.
 */
export function spentDayOfLine(
  ln: Pick<
    GastosLine,
    | "source"
    | "line_role"
    | "occurred_on"
    | "purchase_on"
    | "expense_month"
    | "billing_month"
    | "purchase_month"
    | "gastos_scope"
    | "nota_credito_role"
  >,
  mode: CcInstallmentGastosMode
): string | null {
  if (ln.nota_credito_role === "annulled_purchase" || ln.nota_credito_role === "matched_nota") return null;
  if (!gastosSumMonthForLine(ln, mode)) return null;
  if (ln.line_role === "installment_cuota") return ln.occurred_on;
  return ln.purchase_on ?? ln.occurred_on;
}

/** One line placed on its day, with what it adds there. */
type SpentEntry<L> = {
  line: L;
  /** The line's index in the input. */
  index: number;
  day: string;
  /** Gasto-del-mes share (0 for a line that is spend but does not count, or is in an excluded big group). */
  gastos: number;
  real: number;
  stacks: Array<readonly [string, number]>;
  /** Whether the line is listed: it counts toward gastos and is not in an excluded big group. */
  listed: boolean;
};

function spentEntries<L extends GastosLine>(
  lines: readonly L[],
  opts: SpentOptions,
  todayYmd: string
): SpentEntry<L>[] {
  const out: SpentEntry<L>[] = [];
  lines.forEach((ln, index) => {
    if (!opts.includePreTax && isPreTaxExpenseLine(ln)) return;
    const day = spentDayOfLine(ln, opts.mode);
    if (day == null || day > todayYmd) return;
    const share = gastosShareOfLine(ln, opts.mode, opts.unit);
    if (share.kind !== "spend") return;
    const excluded = ln.big_group_slug != null && opts.excludedBigGroups.has(ln.big_group_slug);
    // A mortgage payment's amortization is saving, not spend: the month-to-date views leave out
    // the segment the monthly chart draws below zero.
    const stacks = share.stacks.filter(([slug]) => slug !== REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG);
    const listed = !excluded && stacks.length > 0;
    out.push({
      line: ln,
      index,
      day,
      gastos: excluded ? 0 : share.gastos,
      real: share.real,
      stacks: excluded ? [] : stacks,
      listed,
    });
  });
  return out;
}

/**
 * Heat levels by quartile of the days that spent something: 0 for nothing (or a net refund), 1–4
 * for the quarter of the spending days (ranked by amount) the day falls in.
 */
export function heatLevels(totals: readonly number[]): Array<0 | 1 | 2 | 3 | 4> {
  const spent = totals.filter((t) => t > 0).sort((a, b) => a - b);
  const n = spent.length;
  return totals.map((t) => {
    if (t <= 0) return 0;
    // Rank = how many spending days spent at most this much.
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (spent[mid]! <= t) lo = mid + 1;
      else hi = mid;
    }
    return Math.min(4, Math.max(1, Math.ceil((4 * lo) / n))) as 1 | 2 | 3 | 4;
  });
}

function* daysFrom(fromYmd: string, throughYmd: string): Generator<string> {
  for (let d = fromYmd; d <= throughYmd; d = chileCalendarAddDays(d, 1)) yield d;
}

export function parseSpentRange(raw: unknown): ExpensesSpentRange {
  const r = String(raw ?? "6m");
  if (!(EXPENSES_SPENT_RANGES as readonly string[]).includes(r)) {
    throw new ExpensesSpentRequestError(`range must be one of ${EXPENSES_SPENT_RANGES.join(", ")}, got ${r}`);
  }
  return r as ExpensesSpentRange;
}

/** The page's payload over finished lines (pure: lines, categories and today are inputs). */
export function buildExpensesSpentPayload(
  lines: readonly GastosLine[],
  categories: readonly Pick<CcExpenseCategoryRow, "slug" | "parent_slug">[],
  opts: SpentOptions,
  range: ExpensesSpentRange,
  todayYmd: string
): Omit<FlowsExpensesSpentResponse, "big_group_usage"> {
  const round = (v: number) => roundToCurrency(v, opts.unit);
  const entries = spentEntries(linesAtCategoryLevel(lines, categories, opts.level), opts, todayYmd);
  const allSlugs = chartCategorySlugsAtLevel(categories, opts.level);
  const slugIndex = new Map(allSlugs.map((s, i) => [s, i]));

  // Per day: each category's spend and the gasto total.
  const byDay = new Map<string, { stacks: number[]; gastos: number }>();
  for (const e of entries) {
    if (e.stacks.length === 0 && e.gastos === 0) continue;
    let d = byDay.get(e.day);
    if (!d) {
      d = { stacks: allSlugs.map(() => 0), gastos: 0 };
      byDay.set(e.day, d);
    }
    d.gastos += e.gastos;
    for (const [slug, v] of e.stacks) {
      const i = slugIndex.get(slug);
      if (i == null) throw new Error(`spent: category ${slug} is not a chart category at ${opts.level}`);
      d.stacks[i]! += v;
    }
  }

  const currentMonth = todayYmd.slice(0, 7);
  const firstMonth = addCalendarMonths(currentMonth, -(SPENT_MONTHS - 1));
  const monthKeys = Array.from({ length: SPENT_MONTHS }, (_, i) => addCalendarMonths(firstMonth, i));

  // Categories with spend in the shown months, or in the chart's range, keep their place.
  const firstSpendDay = [...byDay.keys()].sort()[0] ?? todayYmd;
  const rangeDays = RANGE_DAYS[range];
  const chartFrom = rangeDays === 0 ? firstSpendDay : chileCalendarAddDays(todayYmd, -(rangeDays - 1));
  const shownFrom = chartFrom < `${firstMonth}-01` ? chartFrom : `${firstMonth}-01`;
  const used = allSlugs.map(() => false);
  for (const [day, d] of byDay) {
    if (day < shownFrom) continue;
    d.stacks.forEach((v, i) => {
      if (v !== 0) used[i] = true;
    });
  }
  const keep = allSlugs.map((_, i) => i).filter((i) => used[i]);
  const category_slugs = keep.map((i) => allSlugs[i]!);

  // Month-to-date chart, cumulative from the 1st of the chart's first month.
  const chart: ExpensesSpentChartDay[] = [];
  const day_strip_totals: number[] = [];
  let running = keep.map(() => 0);
  let runningGastos = 0;
  let runningMonth = "";
  for (const day of daysFrom(`${chartFrom.slice(0, 7)}-01`, todayYmd)) {
    if (day.slice(0, 7) !== runningMonth) {
      runningMonth = day.slice(0, 7);
      running = keep.map(() => 0);
      runningGastos = 0;
    }
    const d = byDay.get(day);
    if (d) {
      keep.forEach((i, k) => (running[k]! += d.stacks[i]!));
      runningGastos += d.gastos;
    }
    if (day < chartFrom) continue;
    chart.push({ day, stacks: running.map(round), total: round(runningGastos) });
    day_strip_totals.push(round(d?.gastos ?? 0));
  }
  const stripLevels = heatLevels(day_strip_totals);
  const day_strip: ExpensesSpentDay[] = chart.map((c, i) => ({
    day: c.day,
    total: day_strip_totals[i]!,
    level: stripLevels[i]!,
  }));

  // Months: totals, per-category cells, days with heat levels over all the shown months.
  const monthAgg = new Map(
    monthKeys.map((m) => [m, { gastos: 0, real: 0, lines: 0, cats: keep.map(() => 0) }])
  );
  for (const e of entries) {
    const agg = monthAgg.get(e.day.slice(0, 7));
    if (!agg) continue;
    agg.real += e.real;
    if (e.listed) agg.lines += 1;
  }
  for (const [day, d] of byDay) {
    const agg = monthAgg.get(day.slice(0, 7));
    if (!agg) continue;
    agg.gastos += d.gastos;
    keep.forEach((i, k) => (agg.cats[k]! += d.stacks[i]!));
  }
  const monthDays = monthKeys.map((m) => [...daysFrom(`${m}-01`, todayYmd)].filter((d) => d.startsWith(m)));
  const calendarTotals = monthDays.flat().map((d) => round(byDay.get(d)?.gastos ?? 0));
  const calendarLevels = heatLevels(calendarTotals);
  const maxCell = Math.max(0, ...[...monthAgg.values()].flatMap((a) => a.cats));
  const maxMonth = Math.max(0, ...[...monthAgg.values()].map((a) => a.gastos));
  const bar = (v: number, max: number) => (max > 0 && v > 0 ? Math.round((v / max) * 1000) / 1000 : 0);
  let cursor = 0;
  const months: ExpensesSpentMonth[] = monthKeys.map((m, mi) => {
    const agg = monthAgg.get(m)!;
    const cells: ExpensesSpentCell[] = agg.cats.map((v) => ({ value: round(v), bar: bar(v, maxCell) }));
    const days: ExpensesSpentDay[] = monthDays[mi]!.map((day) => {
      const k = cursor++;
      return { day, total: calendarTotals[k]!, level: calendarLevels[k]! };
    });
    return {
      month: m,
      total: round(agg.gastos),
      total_real: round(agg.real),
      line_count: agg.lines,
      cells,
      total_bar: bar(agg.gastos, maxMonth),
      days,
    };
  });

  // Per year on the chart: the average monthly gasto over its complete months.
  const gastosByMonth = new Map<string, number>();
  for (const [day, d] of byDay) gastosByMonth.set(day.slice(0, 7), (gastosByMonth.get(day.slice(0, 7)) ?? 0) + d.gastos);
  const lastCompleteYm = addCalendarMonths(currentMonth, -1);
  const firstSpendYm = [...gastosByMonth.entries()]
    .filter(([ym, v]) => v !== 0 && ym <= lastCompleteYm)
    .map(([ym]) => ym)
    .sort()[0];
  const year_averages: ExpensesSpentYearAverage[] = [];
  if (firstSpendYm != null) {
    const firstYear = Math.max(Number(firstSpendYm.slice(0, 4)), Number(chartFrom.slice(0, 4)));
    for (let year = firstYear; year <= Number(lastCompleteYm.slice(0, 4)); year++) {
      const fromYm = `${year}-01` < firstSpendYm ? firstSpendYm : `${year}-01`;
      const throughYm = `${year}-12` > lastCompleteYm ? lastCompleteYm : `${year}-12`;
      let sum = 0;
      let count = 0;
      for (let ym = fromYm; ym <= throughYm; ym = addCalendarMonths(ym, 1)) {
        sum += gastosByMonth.get(ym) ?? 0;
        count++;
      }
      year_averages.push({ year: String(year), from_ym: fromYm, through_ym: throughYm, avg: round(sum / count) });
    }
  }

  return {
    unit: opts.unit,
    mode: opts.mode,
    level: opts.level,
    include_pre_tax: opts.includePreTax,
    excluded_big_groups: [...opts.excludedBigGroups].sort(),
    range,
    today: todayYmd,
    category_slugs,
    chart,
    day_strip,
    months,
    year_averages,
  };
}

export type SpentLinesSelection = { month: string; day: string | null; category: string | null };

/** The listed lines of a month (or a day of it, or one category at the level), newest day first. */
export function selectSpentLines<L extends GastosLine>(
  lines: readonly L[],
  categories: readonly Pick<CcExpenseCategoryRow, "slug" | "parent_slug">[],
  opts: SpentOptions,
  sel: SpentLinesSelection,
  todayYmd: string
): { total: number; days: Array<{ day: string; total: number; lines: L[] }> } {
  if (sel.day != null && !sel.day.startsWith(sel.month)) {
    throw new ExpensesSpentRequestError(`day ${sel.day} is not in month ${sel.month}`);
  }
  // Fold the category for the filter only; the listed line keeps its own leaf category.
  const folded = linesAtCategoryLevel(lines, categories, opts.level);
  const byDay = new Map<string, { total: number; lines: L[] }>();
  let total = 0;
  const entries = spentEntries(folded, opts, todayYmd);
  entries.forEach((e) => {
    if (!e.listed || !e.day.startsWith(sel.month)) return;
    if (sel.day != null && e.day !== sel.day) return;
    if (sel.category != null && e.line.category_slug !== sel.category) return;
    const original = lines[e.index]!;
    const d = byDay.get(e.day) ?? { total: 0, lines: [] };
    d.total += e.gastos;
    d.lines.push(original);
    byDay.set(e.day, d);
    total += e.gastos;
  });
  const round = (v: number) => roundToCurrency(v, opts.unit);
  return {
    total: round(total),
    days: [...byDay.entries()]
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([day, d]) => ({ day, total: round(d.total), lines: d.lines })),
  };
}

const YEAR_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const YMD_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** The options both spent endpoints share, from the query (400 on anything malformed). */
export function parseSpentOptions(query: Record<string, unknown>, unit: GastosUnit): SpentOptions {
  const mode = String(query.mode ?? "split");
  if (mode !== "split" && mode !== "total") throw new ExpensesSpentRequestError(`mode must be split or total, got ${mode}`);
  const level = String(query.level ?? "category");
  if (level !== "category" && level !== "subcategory") {
    throw new ExpensesSpentRequestError(`level must be category or subcategory, got ${level}`);
  }
  const preTax = String(query.include_pre_tax ?? "0");
  if (preTax !== "0" && preTax !== "1") throw new ExpensesSpentRequestError(`include_pre_tax must be 0 or 1, got ${preTax}`);
  const excludedBigGroups = new Set(
    String(query.exclude_big_groups ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  );
  return { unit, mode, level, excludedBigGroups, includePreTax: preTax === "1" };
}

export function parseSpentLinesSelection(query: Record<string, unknown>): SpentLinesSelection {
  const month = String(query.month ?? "");
  if (!YEAR_MONTH_RE.test(month)) throw new ExpensesSpentRequestError(`month must be YYYY-MM, got ${month}`);
  const dayRaw = query.day;
  const day = dayRaw == null || dayRaw === "" ? null : String(dayRaw);
  if (day != null && !YMD_RE.test(day)) throw new ExpensesSpentRequestError(`day must be YYYY-MM-DD, got ${day}`);
  const catRaw = query.category;
  const category = catRaw == null || catRaw === "" ? null : String(catRaw);
  return { month, day, category };
}

function optionsKey(opts: SpentOptions): string {
  return `${opts.unit}|${opts.mode}|${opts.level}|${opts.includePreTax ? 1 : 0}|${[...opts.excludedBigGroups].sort().join(",")}`;
}

/** `GET /api/flows/expenses/spent`, cached beside the expense lines. */
/**
 * `GET /api/flows/expenses/spent` from the finished expense lines: spending from net pay, so the
 * payslip deductions ({@link isPreTaxExpenseLine}) are left out unless `includePreTax`.
 */
export function buildExpensesSpentResponse(
  allLines: readonly GastosLine[],
  opts: SpentOptions,
  range: ExpensesSpentRange,
  today: string
): FlowsExpensesSpentResponse {
  const lines = opts.includePreTax ? allLines : allLines.filter((l) => !isPreTaxExpenseLine(l));
  return {
    ...buildExpensesSpentPayload(lines, listCcExpenseCategories(), opts, range, today),
    big_group_usage: bigGroupUsageByMode(lines, listCcExpenseBigGroups(), opts.unit)[opts.mode],
  };
}

export function cachedExpensesSpentPayload(opts: SpentOptions, range: ExpensesSpentRange): FlowsExpensesSpentResponse {
  syncFlowsInputsWithLiveUsdRates();
  const today = chileCalendarTodayYmd();
  return getAggregationCached(cacheKeyFlowsInputs(`spent|${optionsKey(opts)}|${range}|${today}`), () =>
    buildExpensesSpentResponse(cachedFlowsExpenseLines(), opts, range, today)
  );
}

/** `GET /api/flows/expenses/spent/lines`, cached beside the expense lines. */
export function cachedExpensesSpentLines(opts: SpentOptions, sel: SpentLinesSelection): FlowsExpensesSpentLinesResponse {
  syncFlowsInputsWithLiveUsdRates();
  const today = chileCalendarTodayYmd();
  const selKey = `${sel.month}|${sel.day ?? ""}|${sel.category ?? ""}`;
  return getAggregationCached(cacheKeyFlowsInputs(`spent_lines|${optionsKey(opts)}|${selKey}|${today}`), () => {
    const categories = listCcExpenseCategories();
    const picked = selectSpentLines(cachedFlowsExpenseLines(), categories, opts, sel, today);
    const days: ExpensesSpentLinesDay[] = picked.days.map((d) => ({
      day: d.day,
      total: d.total,
      lines: toWireExpenseLines(d.lines, opts.unit),
    }));
    return {
      unit: opts.unit,
      month: sel.month,
      day: sel.day,
      category: sel.category,
      total: picked.total,
      line_count: days.reduce((n, d) => n + d.lines.length, 0),
      days,
      categories,
      big_groups: listCcExpenseBigGroups(),
    };
  });
}
