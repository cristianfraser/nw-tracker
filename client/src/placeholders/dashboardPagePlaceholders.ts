import type { DashboardBundle } from "../queries/fetchers";
import type { DisplayUnit } from "../queries/keys";
import { DASHBOARD_NET_WORTH_BUCKET_SLUGS } from "../portfolioDashboardBuckets";
import type {
  DashboardChartShape,
  DashboardChartShapeLine,
  DashboardResponse,
  GroupMonthlyPerformanceResponse,
  NavCardMetricsDto,
  NavCardPeriodMetricsDto,
  NavTreeNodeDto,
  SidebarNavResponse,
  TimeseriesBlock,
  ValuationTimeseriesResponse,
} from "../types";
import { monthEndYmdsForSkeleton } from "./placeholderMonthRows";

function unitForTs(unit: DisplayUnit): "clp" | "usd" {
  return unit === "usd" ? "usd" : "clp";
}

const OVERVIEW_LINE_SPECS: DashboardChartShapeLine[] = [
  { dataKey: "real_estate", name: "Inmuebles", valueSeriesType: "data" },
  { dataKey: "retirement", name: "Retiro", valueSeriesType: "data" },
  { dataKey: "brokerage", name: "Brokerage", valueSeriesType: "data" },
  { dataKey: "invested", name: "Invested", valueSeriesType: "reference" },
  { dataKey: "cash", name: "Cash savings", valueSeriesType: "data" },
  { dataKey: "liabilities", name: "Pasivos", valueSeriesType: "data" },
  { dataKey: "total_nw", name: "Patrimonio neto", valueSeriesType: "data" },
];

const PRIMARY_LINE_FALLBACK: DashboardChartShapeLine[] = [
  { dataKey: "total_nw", name: "Patrimonio neto", valueSeriesType: "data" },
];

function zeroPointsForKeys(
  keys: string[],
  monthEnds: string[]
): Record<string, string | number | null>[] {
  return monthEnds.map((as_of_date) => {
    const row: Record<string, string | number | null> = { as_of_date };
    for (const k of keys) row[k] = 0;
    return row;
  });
}

/** Shape line → chart account line (real `accounts_ex_property` uses `accounts`, not `lines`). */
function accountLinesFromShape(lines: DashboardChartShapeLine[]): NonNullable<TimeseriesBlock["accounts"]> {
  return lines.map((l) => ({
    account_id: l.account_id ?? (Number(l.dataKey) || 0),
    name: l.name,
    dataKey: l.dataKey,
    valueSeriesType: l.valueSeriesType,
    ...(l.color_rgb ? { color_rgb: l.color_rgb } : {}),
  }));
}

/** Zero group-perf series so the perf/accumulated sections mount before the bundle resolves. */
function zeroGroupPerf(
  unit: DisplayUnit,
  groupSlug: string,
  monthEnds: string[]
): GroupMonthlyPerformanceResponse {
  return {
    unit: unitForTs(unit),
    group_slug: groupSlug,
    bar_accounts: [],
    points: monthEnds.map((as_of_date) => ({ as_of_date, delta_total: 0 })),
  };
}

/** Flat-zero overview + primary blocks for home dashboard charts while bundle loads. */
export function buildPlaceholderDashboardTimeseries(
  unit: DisplayUnit,
  shape?: DashboardChartShape
): ValuationTimeseriesResponse {
  const monthEnds = monthEndYmdsForSkeleton(shape?.first_month);
  const overviewLines = shape?.overview_lines?.length ? shape.overview_lines : OVERVIEW_LINE_SPECS;
  const primaryLines = shape?.primary_lines?.length ? shape.primary_lines : PRIMARY_LINE_FALLBACK;
  const accountsExProperty: TimeseriesBlock = {
    accounts: accountLinesFromShape(primaryLines),
    points: zeroPointsForKeys(primaryLines.map((l) => l.dataKey), monthEnds),
  };
  // Skeleton keeps the milestone reference lines out: flat-zero references only add legend noise.
  const patrimonioLines: DashboardChartShapeLine[] = [
    { dataKey: "total_nw", name: "Patrimonio neto", valueSeriesType: "data" },
    { dataKey: "invested", name: "Invested", valueSeriesType: "data" },
  ];
  return {
    unit: unitForTs(unit),
    overview: {
      lines: overviewLines,
      points: zeroPointsForKeys(overviewLines.map((l) => l.dataKey), monthEnds),
    },
    accounts_ex_property: accountsExProperty,
    ...(shape?.has_patrimonio_usd_chart
      ? {
          patrimonio_usd_milestones_chart: {
            lines: patrimonioLines,
            points: zeroPointsForKeys(patrimonioLines.map((l) => l.dataKey), monthEnds),
          },
        }
      : {}),
  };
}

/** Minimal dash payload so allocation pie and card strip can mount at zero. */
export function buildPlaceholderDashboardDash(unit: DisplayUnit): DashboardResponse {
  const includeUsd = unit === "usd";
  const zeroBucketCloses = {
    net_worth_clp: 0,
    real_estate_clp: 0,
    retirement_clp: 0,
    brokerage_clp: 0,
    cash_eqs_clp: 0,
    ...(includeUsd
      ? {
          net_worth_usd: 0,
          real_estate_usd: 0,
          retirement_usd: 0,
          brokerage_usd: 0,
          cash_eqs_usd: 0,
        }
      : {}),
  };
  return {
    // Empty map: the strip never mounts from this dash (a cold strip mounts from
    // `buildPlaceholderNavStripDash`); charts/allocation ignore it.
    card_metrics_by_slug: {},
    totals: {
      net_worth_clp: 0,
      deposits_clp: 0,
      real_estate_clp: 0,
      retirement_clp: 0,
      brokerage_clp: 0,
      cash_eqs_clp: 0,
      liabilities_clp: 0,
      prior_closes: {
        month_end: "",
        year_end: "",
        month: zeroBucketCloses,
        year: zeroBucketCloses,
      },
      ...(includeUsd
        ? {
            net_worth_usd: 0,
            deposits_usd: 0,
            real_estate_usd: 0,
            retirement_usd: 0,
            brokerage_usd: 0,
            cash_eqs_usd: 0,
            liabilities_usd: 0,
          }
        : {}),
    },
    allocation: DASHBOARD_NET_WORTH_BUCKET_SLUGS.map((group_slug) => ({
      group_slug,
      group_label: group_slug,
      value_clp: 1,
      ...(includeUsd ? { value_usd: 1 } : {}),
    })),
    accounts: [],
  };
}

/** The card strip's slice of the dashboard payload (`GroupInfoPortfolioStrip.dash`). */
export type NavStripDash = Pick<
  DashboardResponse,
  "accounts" | "totals" | "liabilities_breakdown" | "dashboard_layout" | "card_metrics_by_slug"
>;

function zeroNavCardPeriodMetrics(unit: DisplayUnit): NavCardPeriodMetricsDto {
  const usd = unit === "usd" ? 0 : null;
  return {
    deposits_clp: 0,
    deposits_usd: usd,
    delta_total_clp: 0,
    delta_total_usd: usd,
    deposits_period_clp: 0,
    deposits_period_usd: usd,
    delta_period_clp: 0,
    delta_period_usd: usd,
  };
}

function zeroNavCardMetrics(unit: DisplayUnit): NavCardMetricsDto {
  const variant = () => ({
    day: zeroNavCardPeriodMetrics(unit),
    month: zeroNavCardPeriodMetrics(unit),
    year: zeroNavCardPeriodMetrics(unit),
  });
  const noPct = () => ({ clp: null, usd: null });
  return {
    child: variant(),
    parent: variant(),
    row_pct: { day: noPct(), month: noPct(), year: noPct(), total: noPct() },
  };
}

/**
 * The card strip before any nav snapshot or nav-context exists (cold cache): built from the
 * sidebar nav alone. Every group node a strip can draw — the net-worth tree and every main root,
 * Pasivos included (the cash page hosts its credit-card cards) — gets a zero card-metrics entry,
 * which is what `requireNavCardMetrics` asks for; totals are zero and there are no account rows.
 * The strip mounts in its placeholder phase and spins once to the real values.
 */
export function buildPlaceholderNavStripDash(nav: SidebarNavResponse, unit: DisplayUnit): NavStripDash {
  const card_metrics_by_slug: Record<string, NavCardMetricsDto> = {};
  const visit = (n: NavTreeNodeDto) => {
    if (n.account_id == null && n.expense_account_id == null && !card_metrics_by_slug[n.slug]) {
      card_metrics_by_slug[n.slug] = zeroNavCardMetrics(unit);
    }
    for (const c of n.children ?? []) visit(c);
  };
  for (const root of [nav.net_worth, ...nav.main]) {
    if (root) visit(root);
  }
  return {
    accounts: [],
    totals: buildPlaceholderDashboardDash(unit).totals,
    liabilities_breakdown: {
      mortgage_clp: 0,
      credit_card_clp: 0,
      ...(unit === "usd" ? { mortgage_usd: 0, credit_card_usd: 0 } : {}),
    },
    card_metrics_by_slug,
  };
}

export function buildPlaceholderDashboardBundle(
  unit: DisplayUnit,
  shape?: DashboardChartShape
): DashboardBundle {
  const monthEnds = monthEndYmdsForSkeleton(shape?.first_month);
  const includePerf = shape?.has_perf_sections ?? false;
  return {
    dash: buildPlaceholderDashboardDash(unit),
    ts: buildPlaceholderDashboardTimeseries(unit, shape),
    fx: null,
    retirementPerf: includePerf ? zeroGroupPerf(unit, "retirement", monthEnds) : null,
    brokeragePerf: includePerf ? zeroGroupPerf(unit, "brokerage", monthEnds) : null,
  };
}

/** Exact chart skeleton extracted from a loaded bundle (written back into the nav-snapshot cache). */
export function chartShapeFromLoadedDashboardBundle(
  bundle: DashboardBundle
): DashboardChartShape | undefined {
  const overview = bundle.ts?.overview;
  if (!overview?.points.length) return undefined;
  const firstDate = overview.points[0]?.as_of_date;
  const primary = bundle.ts.accounts_ex_property;
  const primary_lines: DashboardChartShapeLine[] = (primary?.accounts ?? []).map((a) => ({
    dataKey: a.dataKey,
    name: a.name,
    valueSeriesType: a.valueSeriesType,
    account_id: a.account_id,
    ...(a.color_rgb ? { color_rgb: a.color_rgb } : {}),
  }));
  return {
    first_month: typeof firstDate === "string" ? firstDate : null,
    overview_lines: overview.lines,
    primary_lines,
    has_patrimonio_usd_chart: Boolean(bundle.ts.patrimonio_usd_milestones_chart?.points.length),
    has_perf_sections: Boolean(
      bundle.retirementPerf?.points.length || bundle.brokeragePerf?.points.length
    ),
  };
}
