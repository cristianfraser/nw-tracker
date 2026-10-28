import { rollupChartPointsByYear } from "./flowsDisplay";
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

/*
 * Income page display helpers. The page's month rows, day points and total are built on the
 * server (`buildFlowsIncomeAggregates`, the overview's own income rule) and only picked here;
 * the yearly rollups below re-bucket those server rows by calendar year, the flows pages'
 * convention for M/Y views.
 */

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

const INCOME_CHART_KEYS = ["salary", "severance", "parent_gift", "other", "total"] as const;

/**
 * Yearly income chart rows from monthly ones (every kind is a flow: it sums). The chart feeds it
 * through `clipMonthsThenRollup`, so a Rango that starts mid-year gives a partial first year.
 */
export function rollupIncomeChartPointsByYear(
  points: readonly FlowIncomeChartPoint[]
): FlowIncomeChartPoint[] {
  return rollupChartPointsByYear(points, INCOME_CHART_KEYS);
}
