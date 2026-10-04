import { loadMergedDisplayDepositInflowEvents } from "./accountDeposits.js";
import { getAccountMonthlyPerformance } from "./accountPerformance.js";
import { monthEndUtcYmd } from "./calendarMonth.js";
import { chileWallClockAt } from "./chileDate.js";
import { db } from "./db.js";
import { flowEventInUnit } from "./flowsDeposits.js";
import { fxForLiveMtm } from "./fxLive.js";
import {
  benchmarkLevelSeries,
  type BenchmarkLevelSeries,
  type BenchmarkRow,
} from "./benchmarkLevels.js";
import { getGroupConsolidatedTables } from "./groupConsolidatedTables.js";
import {
  computePeriodReturns,
  type PeriodReturnKey,
  type PeriodReturnsPayload,
} from "./periodReturns.js";
import {
  bucketValueInUnitAt,
  convertLegToUnit,
  includeShortHorizonAccount,
  type ShortHorizonAccountRef,
  withShortHorizonCells,
} from "./periodReturnsShortHorizon.js";
import { windowIrr } from "./irr.js";
import { isInvestmentPerformanceAccount } from "./portfolioGroupTree.js";
import { convertTs, listAccountsForGroupTab, type TsUnit } from "./valuationTimeseries.js";

/**
 * The Rentabilidad table's comparison row: for each window, a shadow portfolio that starts with
 * what the account (or group) was worth at the window start and receives the same deposits and
 * withdrawals on the same days, all in the benchmark. Its P/L is what the money would have
 * made there; `delta_pl` = the real P/L the table shows − that.
 *
 * Shadow units: u = V_start ÷ L(start), + flow ÷ L(day) per flow; end value u × L(end); P/L =
 * end − V_start − Σ flows. A withdrawal larger than the shadow holds leaves it short (negative
 * units, i.e. borrowing at the benchmark's return) — the identity still holds.
 *
 * `benchmark_pct` is the benchmark's own return over the window, L(end) ÷ L(start) − 1: the
 * return a flow-adjusted (time-weighted) chain of the shadow gives back, so it compares with
 * the real `pct`. Levels are in the display unit, each at its own day's rate.
 *
 * Windows match the real cells: 1D/1W start on their anchor day; month windows on the
 * month-end before their first month (the value there = that month's `prior_closing`, the
 * figure the real P/L starts from); a window the benchmark does not reach back to is null.
 */

export type BenchmarkComparisonCell = {
  period: PeriodReturnKey;
  benchmark_pct: number | null;
  /** Annualized benchmark return, on exactly the windows the real cell annualizes. */
  benchmark_annualized_pct: number | null;
  shadow_pl: number | null;
  /** Real P/L − shadow P/L (positive: the real money did better). */
  delta_pl: number | null;
  /**
   * Internal rates of return of the real money and of its shadow over the window
   * ({@link windowIrr}): the same starting value and flows, each side's own end value.
   * Annualized when `irr_annualized` (windows of a year or more), else over the window.
   * The real one needs no benchmark level.
   */
  real_irr_pct: number | null;
  shadow_irr_pct: number | null;
  irr_annualized: boolean;
  /** Day the benchmark return is measured from (the first flow when the window starts empty). */
  window_start_date: string | null;
};

export type BenchmarkComparisonPayload = {
  unit: TsUnit;
  benchmark: { slug: string; label_i18n_key: string };
  as_of_date: string;
  /** First day the benchmark has a level (null: no data). */
  benchmark_first_date: string | null;
  periods: BenchmarkComparisonCell[];
};

export type ShadowFlow = { ymd: string; amount: number };

export type ShadowResult = {
  benchmark_pct: number;
  shadow_pl: number;
  /** Day the benchmark return is measured from: the window start, or the first flow when it starts empty. */
  base_ymd: string;
};

/**
 * Pure shadow over one window. `level` is in the display unit; flows are dated within
 * (startYmd, endYmd]. A window that starts empty (`vStart` 0 — TOTAL, or an account opened
 * inside it) measures the benchmark from its first flow, so a benchmark whose history begins
 * after the window's nominal start but before the first money still compares. Null when the
 * benchmark has no level at the start (or first flow), the end, or any flow day.
 */
export function shadowOverWindow(
  vStart: number,
  startYmd: string,
  endYmd: string,
  flows: readonly ShadowFlow[],
  level: (ymd: string) => number | null
): ShadowResult | null {
  const inWindow = flows
    .filter((f) => f.ymd > startYmd && f.ymd <= endYmd && f.amount !== 0)
    .sort((a, b) => a.ymd.localeCompare(b.ymd));
  const baseYmd = vStart === 0 && inWindow.length > 0 ? inWindow[0]!.ymd : startYmd;
  const lBase = level(baseYmd);
  const lEnd = level(endYmd);
  if (lBase == null || lEnd == null || !(lBase > 0) || !(lEnd > 0)) return null;
  let units = vStart / lBase;
  let flowSum = 0;
  for (const f of inWindow) {
    const l = level(f.ymd);
    if (l == null || !(l > 0)) return null;
    units += f.amount / l;
    flowSum += f.amount;
  }
  return {
    benchmark_pct: lEnd / lBase - 1,
    shadow_pl: units * lEnd - vStart - flowSum,
    base_ymd: baseYmd,
  };
}

/** The benchmark's native level converted to `unit` on its own day (live fx today). */
export function levelInUnit(
  series: BenchmarkLevelSeries,
  unit: TsUnit,
  now: Date
): (ymd: string) => number | null {
  const cache = new Map<string, number | null>();
  return (ymd) => {
    if (cache.has(ymd)) return cache.get(ymd)!;
    const native = series.levelAt(ymd);
    let out: number | null = null;
    if (native != null) {
      if (series.currency === "usd" && unit === "usd") {
        out = native;
      } else {
        let clp = native;
        if (series.currency === "usd") {
          const fx = fxForLiveMtm(ymd, now);
          if (fx == null || !(fx.clp_per_usd > 0)) throw new Error(`benchmark: no USD/CLP on or before ${ymd}`);
          clp = native * fx.clp_per_usd;
        }
        out = unit === "uf" ? convertTs(clp, ymd, "uf") : convertLegToUnit(clp, ymd, unit, now);
        if (!Number.isFinite(out)) throw new Error(`benchmark: no ${unit} rate on or before ${ymd}`);
      }
    }
    cache.set(ymd, out);
    return out;
  };
}

function prevMonthKey(mk: string): string {
  const [y, m] = mk.split("-").map(Number);
  return m === 1 ? `${y! - 1}-12` : `${y}-${String(m! - 1).padStart(2, "0")}`;
}

function daysBetween(a: string, b: string): number {
  return (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000;
}

export type ComparisonMonthlyRow = { as_of_date: string; prior_closing: number | null };

export function computeBenchmarkComparison(input: {
  benchmark: BenchmarkRow;
  real: PeriodReturnsPayload;
  /** The monthly rows the real cells chain (any order). */
  monthly: readonly ComparisonMonthlyRow[];
  accounts: readonly ShortHorizonAccountRef[];
  unit: TsUnit;
  now?: Date;
}): BenchmarkComparisonPayload {
  const now = input.now ?? new Date();
  const { unit, benchmark, real } = input;
  const todayYmd = chileWallClockAt(now).ymd;
  const series = benchmarkLevelSeries(benchmark, todayYmd, now);
  const level = levelInUnit(series, unit, now);

  const accounts = input.accounts.filter(includeShortHorizonAccount);
  const eventsById = loadMergedDisplayDepositInflowEvents(accounts.map((a) => a.account_id));
  const flows: ShadowFlow[] = [];
  for (const a of accounts) {
    for (const e of eventsById.get(a.account_id) ?? []) {
      if (e.amt === 0) continue;
      flows.push({ ymd: e.occurred_on, amount: flowEventInUnit(e, unit) });
    }
  }

  const priorByMonth = new Map<string, number | null>();
  for (const r of input.monthly) priorByMonth.set(r.as_of_date.slice(0, 7), r.prior_closing);

  const periods: BenchmarkComparisonCell[] = real.periods.map((cell) => {
    const empty: BenchmarkComparisonCell = {
      period: cell.period,
      benchmark_pct: null,
      benchmark_annualized_pct: null,
      shadow_pl: null,
      delta_pl: null,
      real_irr_pct: null,
      shadow_irr_pct: null,
      irr_annualized: false,
      window_start_date: null,
    };
    let startYmd: string;
    let vStart: number | null;
    if (cell.window_start_date) {
      startYmd = cell.window_start_date;
      vStart = bucketValueInUnitAt(accounts, startYmd, unit, now);
    } else if (cell.window_start_month) {
      if (!priorByMonth.has(cell.window_start_month)) {
        throw new Error(`benchmark comparison: no monthly row for ${cell.window_start_month}`);
      }
      startYmd = monthEndUtcYmd(prevMonthKey(cell.window_start_month));
      vStart = priorByMonth.get(cell.window_start_month) ?? 0;
    } else {
      return empty;
    }
    if (vStart == null || !Number.isFinite(vStart)) return { ...empty, window_start_date: startYmd };

    let flowSum = 0;
    for (const f of flows) if (f.ymd > startYmd && f.ymd <= todayYmd) flowSum += f.amount;
    const irrFor = (pl: number | null) =>
      pl == null ? null : windowIrr(vStart, startYmd, todayYmd, flows, vStart + flowSum + pl);
    const realIrr = irrFor(cell.nominal_pl);
    const s = shadowOverWindow(vStart, startYmd, todayYmd, flows, level);
    if (s == null) {
      return {
        ...empty,
        real_irr_pct: realIrr?.pct ?? null,
        irr_annualized: realIrr?.annualized ?? false,
        window_start_date: startYmd,
      };
    }
    const shadowIrr = irrFor(s.shadow_pl);
    // Annualized on exactly the cells the real row annualizes, over the days the benchmark
    // return actually spans.
    const days = daysBetween(s.base_ymd, todayYmd);
    const annualized =
      cell.annualized_pct != null && days > 365 && s.benchmark_pct > -1
        ? Math.pow(1 + s.benchmark_pct, 365.25 / days) - 1
        : null;
    return {
      period: cell.period,
      benchmark_pct: s.benchmark_pct,
      benchmark_annualized_pct: annualized,
      shadow_pl: s.shadow_pl,
      delta_pl: cell.nominal_pl != null ? cell.nominal_pl - s.shadow_pl : null,
      real_irr_pct: realIrr?.pct ?? null,
      shadow_irr_pct: shadowIrr?.pct ?? null,
      irr_annualized: (realIrr ?? shadowIrr)?.annualized ?? false,
      window_start_date: s.base_ymd,
    };
  });

  return {
    unit,
    benchmark: { slug: benchmark.slug, label_i18n_key: benchmark.label_i18n_key },
    as_of_date: todayYmd,
    benchmark_first_date: series.first_ymd,
    periods,
  };
}

/** The comparison for one account's Rentabilidad table (null: the account has no table). */
export function benchmarkComparisonForAccount(
  accountId: number,
  benchmark: BenchmarkRow,
  unit: TsUnit,
  now: Date = new Date()
): BenchmarkComparisonPayload | null {
  if (!isInvestmentPerformanceAccount(accountId)) return null;
  const acc = db
    .prepare(
      `SELECT a.name, a.import_key, g.slug AS bucket_slug
       FROM accounts a JOIN asset_groups g ON g.id = a.asset_group_id WHERE a.id = ?`
    )
    .get(accountId) as { name: string; import_key: string | null; bucket_slug: string } | undefined;
  if (!acc) return null;
  const perf = getAccountMonthlyPerformance(accountId, unit);
  if (perf == null || perf.monthly.length === 0) return null;
  const ref: ShortHorizonAccountRef = {
    account_id: accountId,
    name: acc.name,
    bucket_slug: acc.bucket_slug,
    import_key: acc.import_key,
    exclude_from_group_totals: 0,
  };
  const real = withShortHorizonCells(computePeriodReturns(perf.monthly, unit), [ref], unit, now);
  if (real == null) return null;
  return computeBenchmarkComparison({ benchmark, real, monthly: perf.monthly, accounts: [ref], unit, now });
}

/** The comparison for a group page's Rentabilidad table (null: the group has no table). */
export function benchmarkComparisonForGroup(
  groupSlug: string,
  benchmark: BenchmarkRow,
  unit: TsUnit,
  now: Date = new Date()
): BenchmarkComparisonPayload | null {
  const tables = getGroupConsolidatedTables(groupSlug, unit);
  if (tables.period_returns == null) return null;
  return computeBenchmarkComparison({
    benchmark,
    real: tables.period_returns,
    monthly: tables.consolidated_monthly,
    accounts: listAccountsForGroupTab(groupSlug),
    unit,
    now,
  });
}
