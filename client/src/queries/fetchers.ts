import { api } from "../api";
import type {
  AccountListRow,
  DashboardResponse,
  FxLatest,
  GroupMonthlyPerformanceResponse,
  ValuationTimeseriesResponse,
} from "../types";
import type { DisplayUnit } from "./keys";

export type DashboardBundle = {
  dash: DashboardResponse;
  ts: ValuationTimeseriesResponse;
  fx: FxLatest | null;
  retirementPerf: GroupMonthlyPerformanceResponse | null;
  brokeragePerf: GroupMonthlyPerformanceResponse | null;
};

export async function fetchDashboardBundle(unit: DisplayUnit): Promise<DashboardBundle> {
  const bundle = await api.dashboardPageBundle(unit);
  return {
    dash: bundle.dash,
    fx: bundle.fx,
    ts: bundle.ts,
    retirementPerf: bundle.retirementPerf,
    brokeragePerf: bundle.brokeragePerf,
  };
}

export type PortfolioGroupBundle = {
  accounts: AccountListRow[];
  ts: ValuationTimeseriesResponse;
  groupPerf: GroupMonthlyPerformanceResponse | null;
};

export type DashboardNavContext = {
  accounts: DashboardResponse["accounts"];
  liabilities_breakdown: DashboardResponse["liabilities_breakdown"];
  dashboard_layout?: DashboardResponse["dashboard_layout"];
  overviewPoints: Record<string, string | number | null>[];
};

export async function fetchDashboardNavContext(unit: DisplayUnit): Promise<DashboardNavContext> {
  const nav = await api.dashboardNavContext(unit);
  return {
    accounts: nav.accounts,
    liabilities_breakdown: nav.liabilities_breakdown,
    dashboard_layout: nav.dashboard_layout,
    overviewPoints: nav.overview?.points ?? [],
  };
}

import type { DashboardGroupSlug } from "../dashboardCardBreakdown";
import { isDashboardNwBucketSlug } from "../portfolioDashboardBuckets";
import { portfolioStripGroupChildren, resolveDashboardBucketFromNavNode } from "../portfolioNavFromApi";
import { sumCashSavingsAdjustedForNav, sumDashboardRowsForNavNode } from "../portfolioGroupTotals";
import type { NavTreeNodeDto } from "../types";

function nwBucketTotalsFromNavStrip(
  netWorthRoot: NavTreeNodeDto | null | undefined,
  accounts: DashboardResponse["accounts"]
): Pick<
  DashboardResponse["totals"],
  "real_estate_clp" | "retirement_clp" | "brokerage_clp" | "cash_eqs_clp"
> {
  const out: Record<DashboardGroupSlug, number> = {
    real_estate: 0,
    retirement: 0,
    brokerage: 0,
    cash_eqs: 0,
  };
  if (!netWorthRoot) {
    return {
      real_estate_clp: out.real_estate,
      retirement_clp: out.retirement,
      brokerage_clp: out.brokerage,
      cash_eqs_clp: out.cash_eqs,
    };
  }
  for (const child of portfolioStripGroupChildren(netWorthRoot)) {
    const bucket = resolveDashboardBucketFromNavNode(child);
    if (!bucket || bucket === "net_worth" || !isDashboardNwBucketSlug(bucket)) continue;
    out[bucket] = sumDashboardRowsForNavNode(child, accounts);
  }
  return {
    real_estate_clp: out.real_estate,
    retirement_clp: out.retirement,
    brokerage_clp: out.brokerage,
    cash_eqs_clp: out.cash_eqs,
  };
}

export function dashPickForNavStrip(
  ctx: DashboardNavContext & { liabilities_breakdown?: DashboardResponse["liabilities_breakdown"] },
  netWorthRoot: NavTreeNodeDto | null | undefined
): Pick<DashboardResponse, "accounts" | "liabilities_breakdown" | "dashboard_layout"> & {
  totals: DashboardResponse["totals"];
} {
  const include = (a: DashboardResponse["accounts"][number]) => a.exclude_from_group_totals !== 1;
  const bucketTotals = nwBucketTotalsFromNavStrip(netWorthRoot, ctx.accounts);
  const real_estate_clp = bucketTotals.real_estate_clp;
  const retirement_clp = bucketTotals.retirement_clp;
  const brokerage_clp = bucketTotals.brokerage_clp;
  const linkedCcClp =
    ctx.dashboard_layout
      ?.find((c) => c.slug === "cash_savings")
      ?.linked_balances?.find((lb) => lb.slug === "credit_card")?.clp ?? 0;
  const cash_eqs_clp = sumCashSavingsAdjustedForNav(netWorthRoot, ctx.accounts, linkedCcClp);
  const liabilities_clp =
    (ctx.liabilities_breakdown?.mortgage_clp ?? 0) + (ctx.liabilities_breakdown?.credit_card_clp ?? 0);
  const net_worth_clp = real_estate_clp + retirement_clp + brokerage_clp + cash_eqs_clp;
  const deposits_clp = ctx.accounts
    .filter(include)
    .reduce((s, a) => s + (a.deposits_clp ?? 0), 0);

  return {
    accounts: ctx.accounts,
    liabilities_breakdown: ctx.liabilities_breakdown,
    dashboard_layout: ctx.dashboard_layout,
    totals: {
      net_worth_clp,
      deposits_clp,
      real_estate_clp,
      retirement_clp,
      brokerage_clp,
      cash_eqs_clp,
      liabilities_clp,
    },
  };
}

export async function fetchPortfolioGroupBundle(opts: {
  portfolio_group: string;
  unit: DisplayUnit;
}): Promise<PortfolioGroupBundle> {
  const slug = opts.portfolio_group;
  const [acc, series, perfResult] = await Promise.all([
    api.accountsByPortfolioGroup(slug),
    api.valuationTimeseries(opts.unit, { portfolio_group: slug }),
    api.groupMonthlyPerformance(slug, opts.unit).catch(() => null),
  ]);
  return { accounts: acc.accounts, ts: series, groupPerf: perfResult };
}

