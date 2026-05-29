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
  overviewPoints: Record<string, string | number | null>[];
};

export async function fetchDashboardNavContext(unit: DisplayUnit): Promise<DashboardNavContext> {
  const nav = await api.dashboardNavContext(unit);
  return {
    accounts: nav.accounts,
    liabilities_breakdown: nav.liabilities_breakdown,
    overviewPoints: nav.overview?.points ?? [],
  };
}

import { accountBelongsToDashboardBucket } from "../accountDashboardBucket";

export function dashPickForNavStrip(ctx: DashboardNavContext): Pick<
  DashboardResponse,
  "accounts" | "liabilities_breakdown"
> & { totals: DashboardResponse["totals"] } {
  const include = (a: DashboardResponse["accounts"][number]) => a.exclude_from_group_totals !== 1;
  const sumByGroup = (slug: string) =>
    ctx.accounts
      .filter((a) => accountBelongsToDashboardBucket(a, slug) && include(a))
      .reduce((s, a) => s + (a.current_value_clp ?? 0), 0);

  const real_estate_clp = sumByGroup("real_estate");
  const retirement_clp = sumByGroup("retirement");
  const brokerage_clp = sumByGroup("brokerage");
  const cash_eqs_clp = sumByGroup("cash_eqs");
  const liabilities_clp =
    (ctx.liabilities_breakdown?.mortgage_clp ?? 0) + (ctx.liabilities_breakdown?.credit_card_clp ?? 0);
  const net_worth_clp = real_estate_clp + retirement_clp + brokerage_clp + cash_eqs_clp;
  const deposits_clp = ctx.accounts
    .filter(include)
    .reduce((s, a) => s + (a.deposits_clp ?? 0), 0);

  return {
    accounts: ctx.accounts,
    liabilities_breakdown: ctx.liabilities_breakdown,
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
  group: string;
  subgroup?: string;
  unit: DisplayUnit;
}): Promise<PortfolioGroupBundle> {
  const [acc, series, perfResult] = await Promise.all([
    api.accountsByGroup(opts.group, opts.subgroup),
    api.valuationTimeseries(opts.unit, { group: opts.group, subgroup: opts.subgroup }),
    api.groupMonthlyPerformance(opts.group, opts.unit, opts.subgroup).catch(() => null),
  ]);
  return { accounts: acc.accounts, ts: series, groupPerf: perfResult };
}

