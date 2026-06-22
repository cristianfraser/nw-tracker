import { addCalendarMonths, chileTodayYmd, monthEndUtcYmd, ymCompare } from "./calendarMonth";
import type { DisplayUnit } from "./queries/keys";
import type {
  FlowCheckingIncomeLine,
  FlowIncomeChartPoint,
  FlowIncomeMonthRow,
  FlowManualIncomeLine,
  FlowsIncomeResponse,
} from "./types";

export type IncomeDisplayRow =
  | ({ kind: "checking" } & FlowCheckingIncomeLine)
  | ({ kind: "manual" } & FlowManualIncomeLine);

function periodMonthFromYmd(ymd: string): string | null {
  const m = /^(\d{4}-\d{2})-\d{2}$/.exec(String(ymd ?? "").trim());
  return m ? m[1]! : null;
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
      cartola_clp: 0,
      manual_clp: 0,
      total_clp: 0,
      line_count: 0,
      cumulative_clp: running,
    });
    cur = addCalendarMonths(cur, 1);
  }
  return extended;
}

export function buildIncomeDisplayRows(data: FlowsIncomeResponse): IncomeDisplayRow[] {
  const cartola: IncomeDisplayRow[] = data.lines.map((line) => ({ kind: "checking", ...line }));
  const manual: IncomeDisplayRow[] = data.manual.map((line) => ({ kind: "manual", ...line }));
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

export function rollupIncomeMonthRowsByYear(rows: readonly FlowIncomeMonthRow[]): FlowIncomeMonthRow[] {
  const byYear = new Map<string, Omit<FlowIncomeMonthRow, "cumulative_clp">>();
  for (const row of rows) {
    const year = row.period_month.slice(0, 4);
    const cur = byYear.get(year);
    if (!cur) {
      byYear.set(year, {
        period_month: `${year}-12`,
        as_of_date: `${year}-12-31`,
        cartola_clp: row.cartola_clp,
        manual_clp: row.manual_clp,
        total_clp: row.total_clp,
        line_count: row.line_count,
      });
      continue;
    }
    cur.cartola_clp += row.cartola_clp;
    cur.manual_clp += row.manual_clp;
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
  type MonthBucket = { cartola: number; manual: number; line_count: number };

  const byMonth = new Map<string, MonthBucket>();

  const touch = (month: string): MonthBucket => {
    const existing = byMonth.get(month);
    if (existing) return existing;
    const fresh: MonthBucket = { cartola: 0, manual: 0, line_count: 0 };
    byMonth.set(month, fresh);
    return fresh;
  };

  for (const line of data.lines) {
    const month = periodMonthFromYmd(line.received_on);
    if (!month) continue;
    const bucket = touch(month);
    bucket.cartola += incomeCartolaAmount(line, unit);
    bucket.line_count += 1;
  }

  for (const line of data.manual) {
    const month = periodMonthFromYmd(line.received_on);
    if (!month) continue;
    const bucket = touch(month);
    bucket.manual += incomeManualAmount(line, unit);
    bucket.line_count += 1;
  }

  const monthsAsc = [...byMonth.keys()].sort(ymCompare);
  let running = 0;
  const byMonthAsc: FlowIncomeMonthRow[] = [];

  for (const periodMonth of monthsAsc) {
    const bucket = byMonth.get(periodMonth)!;
    const cartolaClp = Math.round(bucket.cartola);
    const manualClp = Math.round(bucket.manual);
    const totalClp = cartolaClp + manualClp;
    running += totalClp;
    byMonthAsc.push({
      period_month: periodMonth,
      as_of_date: monthEndUtcYmd(periodMonth),
      cartola_clp: cartolaClp,
      manual_clp: manualClp,
      total_clp: totalClp,
      line_count: bucket.line_count,
      cumulative_clp: Math.round(running),
    });
  }

  const byMonthThroughToday = extendIncomeMonthRowsThroughToday(byMonthAsc);

  const chart_monthly: FlowIncomeChartPoint[] = byMonthThroughToday.map((m) => ({
    as_of_date: m.as_of_date,
    cartola: m.cartola_clp,
    manual: m.manual_clp,
    total: m.total_clp,
  }));

  const byYear = new Map<string, { cartola: number; manual: number; total: number }>();
  for (const point of chart_monthly) {
    const year = point.as_of_date.slice(0, 4);
    const cur = byYear.get(year) ?? { cartola: 0, manual: 0, total: 0 };
    cur.cartola += point.cartola;
    cur.manual += point.manual;
    cur.total += point.total;
    byYear.set(year, cur);
  }

  const chart_yearly: FlowIncomeChartPoint[] = [...byYear.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((year) => {
      const sums = byYear.get(year)!;
      return {
        as_of_date: `${year}-12-31`,
        cartola: Math.round(sums.cartola),
        manual: Math.round(sums.manual),
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
