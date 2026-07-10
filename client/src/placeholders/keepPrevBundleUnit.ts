import type { DashboardBundle, PortfolioGroupBundle } from "../queries/fetchers";
import type { DisplayUnit } from "../queries/keys";
import type {
  AccountDetailBundleResponse,
  AccountMonthlyPerformanceResponse,
  AccountValuationTimeseriesResponse,
  ConsolidatedMonthlyPerfRow,
  DashboardResponse,
  FxLatest,
  GroupMonthlyPerformanceResponse,
  PeriodReturnsPayload,
  TimeseriesBlock,
  ValuationTimeseriesResponse,
} from "../types";
import { synthesizeMissingUsdOnDashboardAccountRows } from "./perturbCachedAmount";

/**
 * Keep the previous display unit's chart on screen during a CLP↔USD switch, converted to the
 * target unit via a single FX rate (same approximation the card strip uses), instead of blinking
 * to the flat-zero placeholder bundle. The real bundle snaps in exact once it resolves.
 *
 * Only monetary point-series are scaled; the patrimonio USD-milestones chart is left untouched
 * (it is always CLP and toggle-independent — scaling it would corrupt the milestone levels).
 */

const DATE_KEY = "as_of_date";

/** `clp_per_usd` from the prior bundle's fx (dashboard only), else the session-cached fx. */
export function resolveClpPerUsdForKeepPrev(
  bundleFx: FxLatest | null | undefined,
  cachedFx: FxLatest | undefined
): number | null {
  const fromBundle = bundleFx?.clp_per_usd;
  if (fromBundle != null && Number.isFinite(fromBundle) && fromBundle > 0) return fromBundle;
  const fromCache = cachedFx?.clp_per_usd;
  if (fromCache != null && Number.isFinite(fromCache) && fromCache > 0) return fromCache;
  return null;
}

/** Multiplier converting a value from the *other* unit into `targetUnit` (two-unit system). */
function unitScaleFactor(targetUnit: DisplayUnit, clpPerUsd: number): number {
  return targetUnit === "usd" ? 1 / clpPerUsd : clpPerUsd;
}

function tsUnit(targetUnit: DisplayUnit): "clp" | "usd" {
  return targetUnit === "usd" ? "usd" : "clp";
}

type Point = Record<string, string | number | null>;

function scalePoints(points: readonly Point[], factor: number): Point[] {
  return points.map((p) => {
    const out: Point = {};
    for (const key in p) {
      const v = p[key];
      out[key] = key !== DATE_KEY && typeof v === "number" && Number.isFinite(v) ? v * factor : v;
    }
    return out;
  });
}

function scaleBlock(block: TimeseriesBlock, factor: number): TimeseriesBlock {
  return { ...block, points: scalePoints(block.points, factor) };
}

function scaleDepositSeries<T extends { as_of_date: string; deposited: number }>(
  series: T[] | undefined,
  factor: number
): T[] | undefined {
  if (!series) return series;
  return series.map((p) => ({
    ...p,
    deposited: Number.isFinite(p.deposited) ? p.deposited * factor : p.deposited,
  }));
}

function scaleValuationTs(
  ts: ValuationTimeseriesResponse,
  targetUnit: DisplayUnit,
  factor: number
): ValuationTimeseriesResponse {
  return {
    ...ts,
    unit: tsUnit(targetUnit),
    ...(ts.overview
      ? { overview: { lines: ts.overview.lines, points: scalePoints(ts.overview.points, factor) } }
      : {}),
    ...(ts.accounts_ex_property
      ? { accounts_ex_property: scaleBlock(ts.accounts_ex_property, factor) }
      : {}),
    ...(ts.accounts_in_group
      ? { accounts_in_group: scaleBlock(ts.accounts_in_group, factor) }
      : {}),
    ...(ts.group_allocation_pie
      ? {
          group_allocation_pie: ts.group_allocation_pie.map((s) => ({
            ...s,
            value: Number.isFinite(s.value) ? s.value * factor : s.value,
          })),
        }
      : {}),
    // patrimonio_usd_milestones_chart is intentionally left as-is (always CLP, toggle-independent).
  };
}

function scalePerf(
  perf: GroupMonthlyPerformanceResponse,
  targetUnit: DisplayUnit,
  factor: number
): GroupMonthlyPerformanceResponse {
  return { ...perf, unit: tsUnit(targetUnit), points: scalePoints(perf.points, factor) };
}

/**
 * CLP bundles omit USD fields (server gates them behind `includeUsd`), so a CLP→USD switch must
 * synthesize the USD fields the dashboard charts read (allocation pie, inversiones deposits).
 * USD→CLP needs nothing: CLP fields are always present.
 */
function scaleDashboardDash(
  dash: DashboardResponse,
  targetUnit: DisplayUnit,
  factor: number
): DashboardResponse {
  if (targetUnit !== "usd") return dash;
  return {
    ...dash,
    allocation: dash.allocation.map((a) => ({
      ...a,
      value_usd:
        a.value_usd != null && Number.isFinite(a.value_usd)
          ? a.value_usd
          : Number.isFinite(a.value_clp)
            ? a.value_clp * factor
            : a.value_usd,
    })),
    ...(dash.inversiones_deposits_chart
      ? {
          inversiones_deposits_chart: {
            ...dash.inversiones_deposits_chart,
            monthly_usd:
              dash.inversiones_deposits_chart.monthly_usd ??
              scaleDepositSeries(dash.inversiones_deposits_chart.monthly_clp, factor),
            yearly_usd:
              dash.inversiones_deposits_chart.yearly_usd ??
              scaleDepositSeries(dash.inversiones_deposits_chart.yearly_clp, factor),
          },
        }
      : {}),
  };
}

/** Convert a held prior-unit dashboard bundle to `targetUnit` for the keep-previous chart render. */
export function convertDashboardBundleUnit(
  bundle: DashboardBundle,
  targetUnit: DisplayUnit,
  clpPerUsd: number
): DashboardBundle {
  const factor = unitScaleFactor(targetUnit, clpPerUsd);
  return {
    dash: scaleDashboardDash(bundle.dash, targetUnit, factor),
    ts: scaleValuationTs(bundle.ts, targetUnit, factor),
    fx: bundle.fx,
    retirementPerf: bundle.retirementPerf
      ? scalePerf(bundle.retirementPerf, targetUnit, factor)
      : null,
    brokeragePerf: bundle.brokeragePerf ? scalePerf(bundle.brokeragePerf, targetUnit, factor) : null,
  };
}

/** Convert a held prior-unit portfolio-group bundle to `targetUnit` for the keep-previous render. */
export function convertPortfolioGroupBundleUnit(
  bundle: PortfolioGroupBundle,
  targetUnit: DisplayUnit,
  clpPerUsd: number
): PortfolioGroupBundle {
  const factor = unitScaleFactor(targetUnit, clpPerUsd);
  return {
    accounts: bundle.accounts,
    ts: scaleValuationTs(bundle.ts, targetUnit, factor),
    groupPerf: bundle.groupPerf ? scalePerf(bundle.groupPerf, targetUnit, factor) : null,
  };
}

/** Monetary columns of a monthly-performance row (units/percent/UF/rate columns stay as-is). */
const PERF_ROW_MONEY_FIELDS = [
  "closing_value",
  "prior_closing",
  "net_capital_flow",
  "nominal_pl",
  "ytd_nominal_pl",
  "cumulative_nominal_pl",
] as const;

function scaleAccountValuationTs(
  ts: AccountValuationTimeseriesResponse,
  targetUnit: DisplayUnit,
  factor: number
): AccountValuationTimeseriesResponse {
  // Non-toggle units (e.g. `uf` mortgage charts) are not clp↔usd convertible — leave untouched.
  if (ts.unit !== "clp" && ts.unit !== "usd") return ts;
  if (ts.unit === tsUnit(targetUnit)) return ts;
  return {
    ...ts,
    unit: tsUnit(targetUnit),
    accounts: scaleBlock(ts.accounts, factor),
    allocation_pie: ts.allocation_pie.map((s) => ({
      ...s,
      value: Number.isFinite(s.value) ? s.value * factor : s.value,
    })),
  };
}

/**
 * Convert held prior-unit consolidated monthly rows to `targetUnit` for the keep-previous table
 * render during a CLP↔USD switch. `uf` payloads are not clp↔usd convertible and pass through, as
 * does data already in the target unit. Percent and units columns stay as-is.
 */
export function convertConsolidatedMonthlyRowsUnit(
  rows: ConsolidatedMonthlyPerfRow[],
  sourceUnit: "clp" | "usd" | "uf",
  targetUnit: DisplayUnit,
  clpPerUsd: number
): ConsolidatedMonthlyPerfRow[] {
  if (sourceUnit === "uf" || sourceUnit === tsUnit(targetUnit)) return rows;
  const factor = unitScaleFactor(targetUnit, clpPerUsd);
  return rows.map((row) => {
    const next = { ...row };
    for (const key of PERF_ROW_MONEY_FIELDS) {
      const v = row[key];
      if (typeof v === "number" && Number.isFinite(v)) next[key] = v * factor;
    }
    return next;
  });
}

/** Convert a held prior-unit period-returns payload (money `nominal_pl` only; pcts are unit-free). */
export function convertPeriodReturnsUnit(
  payload: PeriodReturnsPayload,
  targetUnit: DisplayUnit,
  clpPerUsd: number
): PeriodReturnsPayload {
  if (payload.unit === "uf" || payload.unit === tsUnit(targetUnit)) return payload;
  const factor = unitScaleFactor(targetUnit, clpPerUsd);
  return {
    ...payload,
    unit: tsUnit(targetUnit),
    periods: payload.periods.map((cell) => ({
      ...cell,
      nominal_pl:
        cell.nominal_pl != null && Number.isFinite(cell.nominal_pl)
          ? cell.nominal_pl * factor
          : cell.nominal_pl,
    })),
  };
}

function scaleAccountMonthlyPerformance(
  perf: AccountMonthlyPerformanceResponse,
  targetUnit: DisplayUnit,
  factor: number
): AccountMonthlyPerformanceResponse {
  const target = tsUnit(targetUnit);
  return {
    ...perf,
    monthly: perf.monthly.map((row) => {
      if (row.unit !== "clp" && row.unit !== "usd") return row; // uf/other rows: leave.
      if (row.unit === target) return row;
      const next = { ...row, unit: target };
      for (const key of PERF_ROW_MONEY_FIELDS) {
        const v = row[key];
        if (typeof v === "number" && Number.isFinite(v)) next[key] = v * factor;
      }
      return next;
    }),
  };
}

/**
 * Convert a held prior-unit account-detail bundle to `targetUnit` for the keep-previous render.
 * Only the toggle-responsive surfaces are converted — the valuation chart (`ts`), the monthly
 * performance charts/table (`monthly_performance`), and the header card (`dashboard_account_row`).
 * Position/CC/mortgage tables format via `formatClp` (CLP-always) and movements come from a
 * separate query, so they need no conversion here.
 */
export function convertAccountDetailBundleUnit(
  bundle: AccountDetailBundleResponse,
  targetUnit: DisplayUnit,
  clpPerUsd: number
): AccountDetailBundleResponse {
  const factor = unitScaleFactor(targetUnit, clpPerUsd);
  const row = bundle.dashboard_account_row;
  // CLP fields are always present; only a USD target needs the USD fields synthesized.
  const dashboard_account_row =
    row && targetUnit === "usd"
      ? synthesizeMissingUsdOnDashboardAccountRows([row], { date: "", clp_per_usd: clpPerUsd })[0]!
      : row;
  return {
    ...bundle,
    ts: bundle.ts ? scaleAccountValuationTs(bundle.ts, targetUnit, factor) : bundle.ts,
    monthly_performance: bundle.monthly_performance
      ? scaleAccountMonthlyPerformance(bundle.monthly_performance, targetUnit, factor)
      : bundle.monthly_performance,
    dashboard_account_row,
  };
}
