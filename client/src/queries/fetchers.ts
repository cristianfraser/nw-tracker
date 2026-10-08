import type { QueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type {
  AccountListRow,
  DashboardAccountRow,
  DashboardNavContextResponse,
  DashboardResponse,
  FxLatest,
  GroupMonthlyPerformanceResponse,
  ValuationTimeseriesResponse,
} from "../types";
import { queryKeys, type DisplayUnit } from "./keys";

const ACCOUNTS_BY_GROUP_STALE_MS = 5 * 60_000;

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
  nw_bucket_totals: DashboardNavContextResponse["nw_bucket_totals"];
  card_metrics_by_slug: DashboardResponse["card_metrics_by_slug"];
  value_map?: DashboardResponse["value_map"];
  value_map_color_bounds?: DashboardResponse["value_map_color_bounds"];
  overviewPoints: Record<string, string | number | null>[];
};

export async function fetchDashboardNavSnapshot(
  unit: DisplayUnit
): Promise<import("../types").DashboardNavSnapshotResponse> {
  return api.dashboardNavSnapshot(unit);
}

export async function fetchDashboardNavContext(unit: DisplayUnit): Promise<DashboardNavContext> {
  const nav = await api.dashboardNavContext(unit);
  return {
    accounts: nav.accounts,
    liabilities_breakdown: nav.liabilities_breakdown,
    dashboard_layout: nav.dashboard_layout,
    nw_bucket_totals: nav.nw_bucket_totals,
    card_metrics_by_slug: nav.card_metrics_by_slug,
    value_map: nav.value_map,
    value_map_color_bounds: nav.value_map_color_bounds,
    overviewPoints: nav.overview?.points ?? [],
  };
}

function sumDepositsUsd(accounts: DashboardResponse["accounts"], include: (a: DashboardAccountRow) => boolean): number | undefined {
  let usd = 0;
  let anyUsd = false;
  for (const a of accounts) {
    if (!include(a)) continue;
    if (a.deposits_usd != null && Number.isFinite(a.deposits_usd)) {
      usd += a.deposits_usd;
      anyUsd = true;
    }
  }
  return anyUsd ? usd : undefined;
}

/**
 * Strip `dash` for the nav cards: every bucket total and prior close is the server's
 * `nw_bucket_totals` — account rows are never summed into them. A CLP payload shown in USD
 * (the placeholder of a CLP→USD switch, or the CLP snapshot cache on a first USD visit) gets
 * its USD bucket totals FX-converted by `synthesizeMissingUsdOn…` before it reaches here.
 */
export function dashPickForNavStrip(
  ctx: Omit<DashboardNavContext, "liabilities_breakdown"> & {
    liabilities_breakdown?: DashboardResponse["liabilities_breakdown"];
  }
): Pick<
  DashboardResponse,
  "accounts" | "liabilities_breakdown" | "dashboard_layout" | "card_metrics_by_slug"
> & {
  totals: DashboardResponse["totals"];
} {
  const include = (a: DashboardResponse["accounts"][number]) => a.exclude_from_group_totals !== 1;
  const serverBuckets = ctx.nw_bucket_totals;
  const liabilities_clp =
    (ctx.liabilities_breakdown?.mortgage_clp ?? 0) + (ctx.liabilities_breakdown?.credit_card_clp ?? 0);
  const deposits_clp = ctx.accounts
    .filter(include)
    .reduce((s, a) => s + (a.deposits_clp ?? 0), 0);

  const { net_worth_usd, real_estate_usd, retirement_usd, brokerage_usd, cash_eqs_usd } =
    serverBuckets;
  const mortgageUsd = ctx.liabilities_breakdown?.mortgage_usd;
  const creditCardUsd = ctx.liabilities_breakdown?.credit_card_usd;
  const liabilities_usd =
    (mortgageUsd != null && Number.isFinite(mortgageUsd)) ||
    (creditCardUsd != null && Number.isFinite(creditCardUsd))
      ? (mortgageUsd ?? 0) + (creditCardUsd ?? 0)
      : undefined;
  const deposits_usd = sumDepositsUsd(ctx.accounts, include);

  return {
    accounts: ctx.accounts,
    liabilities_breakdown: ctx.liabilities_breakdown,
    dashboard_layout: ctx.dashboard_layout,
    card_metrics_by_slug: ctx.card_metrics_by_slug,
    totals: {
      net_worth_clp: serverBuckets.net_worth_clp,
      deposits_clp,
      real_estate_clp: serverBuckets.real_estate_clp,
      retirement_clp: serverBuckets.retirement_clp,
      brokerage_clp: serverBuckets.brokerage_clp,
      cash_eqs_clp: serverBuckets.cash_eqs_clp,
      liabilities_clp,
      prior_closes: serverBuckets.prior_closes,
      ...(net_worth_usd !== undefined ? { net_worth_usd } : {}),
      ...(deposits_usd !== undefined ? { deposits_usd } : {}),
      ...(real_estate_usd !== undefined ? { real_estate_usd } : {}),
      ...(retirement_usd !== undefined ? { retirement_usd } : {}),
      ...(brokerage_usd !== undefined ? { brokerage_usd } : {}),
      ...(cash_eqs_usd !== undefined ? { cash_eqs_usd } : {}),
      ...(liabilities_usd !== undefined ? { liabilities_usd } : {}),
    },
  };
}

export async function fetchAccountsByPortfolioGroup(
  portfolioGroup: string,
  unit: DisplayUnit
): Promise<AccountListRow[]> {
  const res = await api.accountsByPortfolioGroup(portfolioGroup, unit);
  return res.accounts;
}

async function accountsForPortfolioGroup(
  queryClient: QueryClient,
  portfolioGroup: string,
  unit: DisplayUnit
): Promise<AccountListRow[]> {
  return queryClient.fetchQuery({
    queryKey: queryKeys.accountsByPortfolioGroup(portfolioGroup, unit),
    queryFn: () => fetchAccountsByPortfolioGroup(portfolioGroup, unit),
    staleTime: ACCOUNTS_BY_GROUP_STALE_MS,
  });
}

export async function fetchPortfolioGroupBundle(
  opts: {
    portfolio_group: string;
    unit: DisplayUnit;
  },
  queryClient: QueryClient
): Promise<PortfolioGroupBundle> {
  const slug = opts.portfolio_group;
  const [accounts, series, perfResult] = await Promise.all([
    accountsForPortfolioGroup(queryClient, slug, opts.unit),
    api.valuationTimeseries(opts.unit, { portfolio_group: slug }),
    api.groupMonthlyPerformance(slug, opts.unit).catch(() => null),
  ]);
  return { accounts, ts: series, groupPerf: perfResult };
}

