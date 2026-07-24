import { addCalendarMonths, chileTodayYmd, monthEndUtcYmd, ymCompare } from "./calendarMonth";
import type { DisplayUnit } from "./queries/keys";
import type {
  FlowCheckingIncomeLine,
  FlowIncomeChartPoint,
  FlowIncomeMonthRow,
  FlowManualIncomeLine,
  FlowsIncomeResponse,
  FlowWorkEarningRow,
  IncomeKind,
} from "./types";

export type IncomeDisplayRow =
  | ({
      kind: "checking";
      income_kind: IncomeKind;
      payroll_period_month?: string;
    } & FlowCheckingIncomeLine)
  | ({ kind: "manual"; income_kind: "other" } & FlowManualIncomeLine);

function periodMonthFromYmd(ymd: string): string | null {
  const m = /^(\d{4}-\d{2})-\d{2}$/.exec(String(ymd ?? "").trim());
  return m ? m[1]! : null;
}

function incomeKindForCheckingLine(
  line: FlowCheckingIncomeLine,
  data: FlowsIncomeResponse
): IncomeKind {
  return data.income_kind_by_movement_id[line.movement_id] ?? "other";
}

export function incomeAttributionMonthForCheckingLine(
  line: FlowCheckingIncomeLine,
  data: FlowsIncomeResponse
): string | null {
  const kind = incomeKindForCheckingLine(line, data);
  if (kind === "salary" || kind === "severance") {
    const payrollMonth = data.payroll_period_by_movement_id[line.movement_id];
    if (payrollMonth) return payrollMonth;
  }
  return periodMonthFromYmd(line.received_on);
}

function extendIncomeMonthRowsThroughToday(rows: FlowIncomeMonthRow[]): FlowIncomeMonthRow[] {
  if (rows.length === 0) return rows;
  const todayYm = chileTodayYmd().slice(0, 7);
  const last = rows[rows.length - 1]!;
  if (ymCompare(last.period_month, todayYm) >= 0) return rows;

  const extended = [...rows];
  const running = last.cumulative_clp;
  let cur = addCalendarMonths(last.period_month, 1);
  while (ymCompare(cur, todayYm) <= 0) {
    extended.push({
      period_month: cur,
      as_of_date: monthEndUtcYmd(cur),
      salary_clp: 0,
      severance_clp: 0,
      parent_gift_clp: 0,
      other_clp: 0,
      total_clp: 0,
      line_count: 0,
      cumulative_clp: running,
    });
    cur = addCalendarMonths(cur, 1);
  }
  return extended;
}

export function buildIncomeDisplayRows(data: FlowsIncomeResponse): IncomeDisplayRow[] {
  const cartola: IncomeDisplayRow[] = data.lines.map((line) => {
    const bankMonth = periodMonthFromYmd(line.received_on);
    const payrollPeriod = data.payroll_period_by_movement_id[line.movement_id];
    const payroll_period_month =
      payrollPeriod && bankMonth && payrollPeriod !== bankMonth ? payrollPeriod : undefined;
    return {
      kind: "checking",
      income_kind: incomeKindForCheckingLine(line, data),
      payroll_period_month,
      ...line,
    };
  });
  const manual: IncomeDisplayRow[] = data.manual.map((line) => ({
    kind: "manual",
    income_kind: "other",
    ...line,
  }));
  return [...cartola, ...manual].sort((a, b) => {
    const aDate = a.received_on;
    const bDate = b.received_on;
    const byDate = bDate.localeCompare(aDate);
    if (byDate !== 0) return byDate;
    const aKey = a.kind === "checking" ? a.movement_id : a.id;
    const bKey = b.kind === "checking" ? b.movement_id : b.id;
    return bKey - aKey;
  });
}

export function incomeCartolaAmount(line: FlowCheckingIncomeLine, unit: DisplayUnit): number {
  if (unit === "usd") {
    if (line.amount_usd == null) {
      throw new Error(`missing amount_usd for checking income movement ${line.movement_id}`);
    }
    return line.amount_usd;
  }
  return Math.round(line.amount_clp);
}

export function incomeManualAmount(line: FlowManualIncomeLine, unit: DisplayUnit): number {
  if (unit === "usd") {
    if (line.amount_usd == null) {
      throw new Error(`missing amount_usd for manual income entry ${line.id}`);
    }
    return line.amount_usd;
  }
  return Math.round(line.amount_clp);
}

export function isUsdSyntheticWorkEarning(row: FlowWorkEarningRow): boolean {
  return row.liquido_usd != null && row.movement_id == null;
}

export function workEarningSalaryAmount(
  row: FlowWorkEarningRow,
  unit: DisplayUnit
): number {
  if (row.liquido_usd != null) {
    if (unit === "usd") return row.liquido_usd;
    return Math.round(row.liquido_clp);
  }
  if (unit === "usd") {
    throw new Error(`missing liquido_usd for work earning ${row.id}`);
  }
  return Math.round(row.liquido_clp);
}

export function workEarningLiquidoDisplayAmount(
  row: FlowWorkEarningRow,
  unit: DisplayUnit
): number {
  if (row.liquido_usd != null && unit === "usd") return row.liquido_usd;
  return Math.round(row.liquido_clp);
}

export function incomeKindLabel(t: (key: string) => string, kind: IncomeKind): string {
  return t(`income.chart.${kind}`);
}

export function rollupIncomeMonthRowsByYear(rows: readonly FlowIncomeMonthRow[]): FlowIncomeMonthRow[] {
  const byYear = new Map<string, Omit<FlowIncomeMonthRow, "cumulative_clp">>();
  for (const row of rows) {
    const year = row.period_month.slice(0, 4);
    const cur = byYear.get(year);
    if (!cur) {
      byYear.set(year, {
        period_month: `${year}-12`,
        as_of_date: `${year}-12-31`,
        salary_clp: row.salary_clp,
        severance_clp: row.severance_clp,
        parent_gift_clp: row.parent_gift_clp,
        other_clp: row.other_clp,
        total_clp: row.total_clp,
        line_count: row.line_count,
      });
      continue;
    }
    cur.salary_clp += row.salary_clp;
    cur.severance_clp += row.severance_clp;
    cur.parent_gift_clp += row.parent_gift_clp;
    cur.other_clp += row.other_clp;
    cur.total_clp += row.total_clp;
    cur.line_count += row.line_count;
  }
  let running = 0;
  return [...byYear.keys()].sort().map((year) => {
    const row = byYear.get(year)!;
    running += row.total_clp;
    return { ...row, cumulative_clp: Math.round(running) };
  });
}

export function aggregateIncomeFromPayload(
  data: FlowsIncomeResponse,
  unit: DisplayUnit = "clp"
): {
  by_month: FlowIncomeMonthRow[];
  chart_monthly: FlowIncomeChartPoint[];
  chart_yearly: FlowIncomeChartPoint[];
  total: number;
  all_rows: IncomeDisplayRow[];
} {
  type MonthBucket = {
    salary: number;
    severance: number;
    parent_gift: number;
    other: number;
    line_count: number;
  };

  const byMonth = new Map<string, MonthBucket>();

  const touch = (month: string): MonthBucket => {
    const existing = byMonth.get(month);
    if (existing) return existing;
    const fresh: MonthBucket = { salary: 0, severance: 0, parent_gift: 0, other: 0, line_count: 0 };
    byMonth.set(month, fresh);
    return fresh;
  };

  const addToBucket = (month: string, kind: IncomeKind, amount: number) => {
    const bucket = touch(month);
    if (kind === "salary") bucket.salary += amount;
    else if (kind === "severance") bucket.severance += amount;
    else if (kind === "parent_gift") bucket.parent_gift += amount;
    else bucket.other += amount;
    bucket.line_count += 1;
  };

  for (const line of data.lines) {
    const month = incomeAttributionMonthForCheckingLine(line, data);
    if (!month) continue;
    addToBucket(month, incomeKindForCheckingLine(line, data), incomeCartolaAmount(line, unit));
  }

  for (const line of data.manual) {
    const month = periodMonthFromYmd(line.received_on);
    if (!month) continue;
    addToBucket(month, "other", incomeManualAmount(line, unit));
  }

  for (const row of data.work_earnings) {
    if (row.earning_type !== "salary" || !isUsdSyntheticWorkEarning(row)) continue;
    addToBucket(row.period_month, "salary", workEarningSalaryAmount(row, unit));
  }

  const monthsAsc = [...byMonth.keys()].sort(ymCompare);
  let running = 0;
  const byMonthAsc: FlowIncomeMonthRow[] = [];

  for (const periodMonth of monthsAsc) {
    const bucket = byMonth.get(periodMonth)!;
    const salaryClp = Math.round(bucket.salary);
    const severanceClp = Math.round(bucket.severance);
    const parentGiftClp = Math.round(bucket.parent_gift);
    const otherClp = Math.round(bucket.other);
    const totalClp = salaryClp + severanceClp + parentGiftClp + otherClp;
    running += totalClp;
    byMonthAsc.push({
      period_month: periodMonth,
      as_of_date: monthEndUtcYmd(periodMonth),
      salary_clp: salaryClp,
      severance_clp: severanceClp,
      parent_gift_clp: parentGiftClp,
      other_clp: otherClp,
      total_clp: totalClp,
      line_count: bucket.line_count,
      cumulative_clp: Math.round(running),
    });
  }

  const byMonthThroughToday = extendIncomeMonthRowsThroughToday(byMonthAsc);

  const chart_monthly: FlowIncomeChartPoint[] = byMonthThroughToday.map((m) => ({
    as_of_date: m.as_of_date,
    salary: m.salary_clp,
    severance: m.severance_clp,
    parent_gift: m.parent_gift_clp,
    other: m.other_clp,
    total: m.total_clp,
  }));

  const byYear = new Map<
    string,
    { salary: number; severance: number; parent_gift: number; other: number; total: number }
  >();
  for (const point of chart_monthly) {
    const year = point.as_of_date.slice(0, 4);
    const cur = byYear.get(year) ?? {
      salary: 0,
      severance: 0,
      parent_gift: 0,
      other: 0,
      total: 0,
    };
    cur.salary += point.salary;
    cur.severance += point.severance;
    cur.parent_gift += point.parent_gift;
    cur.other += point.other;
    cur.total += point.total;
    byYear.set(year, cur);
  }

  const chart_yearly: FlowIncomeChartPoint[] = [...byYear.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((year) => {
      const sums = byYear.get(year)!;
      return {
        as_of_date: `${year}-12-31`,
        salary: Math.round(sums.salary),
        severance: Math.round(sums.severance),
        parent_gift: Math.round(sums.parent_gift),
        other: Math.round(sums.other),
        total: Math.round(sums.total),
      };
    });

  const total = byMonthAsc.reduce((sum, m) => sum + m.total_clp, 0);

  return {
    by_month: [...byMonthThroughToday].reverse(),
    chart_monthly,
    chart_yearly,
    total: unit === "clp" ? Math.round(total) : total,
    all_rows: buildIncomeDisplayRows(data),
  };
}

/**
 * Per-calendar-day income chart points (Diario). Unlike the monthly view, day grain buckets
 * by the actual arrival date (`received_on` / wire date), not payroll-month attribution —
 * income is spiky on pay days, matching the daily-series deposit-day convention. The chart's
 * calendar-day densify fills the empty days; Σ(day points in a month) reconciles to the
 * received-date month total (not the payroll-attributed monthly chart, which shifts salary).
 */
export function aggregateIncomeChartPointsByDay(
  data: FlowsIncomeResponse,
  unit: DisplayUnit = "clp"
): FlowIncomeChartPoint[] {
  type DayBucket = { salary: number; severance: number; parent_gift: number; other: number };
  const byDay = new Map<string, DayBucket>();
  const add = (day: string, kind: IncomeKind, amount: number) => {
    let b = byDay.get(day);
    if (!b) {
      b = { salary: 0, severance: 0, parent_gift: 0, other: 0 };
      byDay.set(day, b);
    }
    if (kind === "salary") b.salary += amount;
    else if (kind === "severance") b.severance += amount;
    else if (kind === "parent_gift") b.parent_gift += amount;
    else b.other += amount;
  };

  for (const line of data.lines) {
    add(
      line.received_on.slice(0, 10),
      incomeKindForCheckingLine(line, data),
      incomeCartolaAmount(line, unit)
    );
  }
  for (const line of data.manual) {
    add(line.received_on.slice(0, 10), "other", incomeManualAmount(line, unit));
  }
  for (const row of data.work_earnings) {
    if (row.earning_type !== "salary" || !isUsdSyntheticWorkEarning(row)) continue;
    const day = (row.wire_received_on ?? monthEndUtcYmd(row.period_month)).slice(0, 10);
    add(day, "salary", workEarningSalaryAmount(row, unit));
  }

  return [...byDay.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((day) => {
      const b = byDay.get(day)!;
      const round = (v: number) => (unit === "clp" ? Math.round(v) : v);
      const salary = round(b.salary);
      const severance = round(b.severance);
      const parent_gift = round(b.parent_gift);
      const other = round(b.other);
      return {
        as_of_date: day,
        salary,
        severance,
        parent_gift,
        other,
        total: salary + severance + parent_gift + other,
      };
    });
}

export function paginateRowsByYear<T extends { received_on: string }>(
  rows: readonly T[]
): { pageNumber: number; data: T[] }[] {
  const byYear = new Map<string, T[]>();
  for (const row of rows) {
    const year = row.received_on.slice(0, 4);
    const bucket = byYear.get(year) ?? [];
    bucket.push(row);
    byYear.set(year, bucket);
  }
  const yearsAsc = [...byYear.keys()].sort((a, b) => Number(a) - Number(b));
  return yearsAsc.map((year, pageNumber) => ({
    pageNumber,
    data: byYear.get(year) ?? [],
  }));
}

export function paginateMonthRowsByYear(
  rows: readonly FlowIncomeMonthRow[]
): { pageNumber: number; data: FlowIncomeMonthRow[] }[] {
  const byYear = new Map<string, FlowIncomeMonthRow[]>();
  for (const row of rows) {
    const year = row.period_month.slice(0, 4);
    const bucket = byYear.get(year) ?? [];
    bucket.push(row);
    byYear.set(year, bucket);
  }
  const yearsAsc = [...byYear.keys()].sort((a, b) => Number(a) - Number(b));
  return yearsAsc.map((year, pageNumber) => ({
    pageNumber,
    data: byYear.get(year) ?? [],
  }));
}
