import type { QueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type {
  AccountListRow,
  UpcomingPaymentsDto,
  DashboardNavContextResponse,
  DashboardResponse,
  FxLatest,
  GroupMonthlyPerformanceResponse,
  InversionesPerfMonthlyResponse,
  ValuationTimeseriesResponse,
} from "../types";
import { queryKeys, type DisplayUnit } from "./keys";

const ACCOUNTS_BY_GROUP_STALE_MS = 5 * 60_000;

export type DashboardBundle = {
  dash: DashboardResponse;
  ts: ValuationTimeseriesResponse;
  fx: FxLatest | null;
  /** The P/L + deposits combo; null on a placeholder bundle without perf sections. */
  inversionesPerf: InversionesPerfMonthlyResponse | null;
  /** Null only on a placeholder bundle: unknown until the server answers (pesos in both units). */
  upcomingPayments: UpcomingPaymentsDto | null;
};

export async function fetchDashboardBundle(unit: DisplayUnit): Promise<DashboardBundle> {
  const bundle = await api.dashboardPageBundle(unit);
  return {
    dash: bundle.dash,
    fx: bundle.fx,
    ts: bundle.ts,
    inversionesPerf: bundle.inversionesPerf,
    upcomingPayments: bundle.upcoming_payments,
  };
}

export type PortfolioGroupBundle = {
  accounts: AccountListRow[];
  ts: ValuationTimeseriesResponse;
  /** Null only on a placeholder bundle (`groupPageChartPlaceholders`); a failed fetch fails the bundle. */
  groupPerf: GroupMonthlyPerformanceResponse | null;
};

export type DashboardNavContext = {
  /** Set on a fetched context (the strip helpers also take shapes built from the bundle). */
  schema_version?: DashboardNavContextResponse["schema_version"];
  accounts: DashboardResponse["accounts"];
  liabilities_breakdown: DashboardResponse["liabilities_breakdown"];
  dashboard_layout?: DashboardResponse["dashboard_layout"];
  nw_bucket_totals: DashboardNavContextResponse["nw_bucket_totals"];
  card_metrics_by_slug: DashboardResponse["card_metrics_by_slug"];
  value_map?: DashboardResponse["value_map"];
  value_map_color_bounds?: DashboardResponse["value_map_color_bounds"];
};

export async function fetchDashboardNavSnapshot(
  unit: DisplayUnit
): Promise<import("../types").DashboardNavSnapshotResponse> {
  return api.dashboardNavSnapshot(unit);
}

export async function fetchDashboardNavContext(unit: DisplayUnit, root: string): Promise<DashboardNavContext> {
  const nav = await api.dashboardNavContext(unit, root);
  return {
    schema_version: nav.schema_version,
    accounts: nav.accounts,
    liabilities_breakdown: nav.liabilities_breakdown,
    dashboard_layout: nav.dashboard_layout,
    nw_bucket_totals: nav.nw_bucket_totals,
    card_metrics_by_slug: nav.card_metrics_by_slug,
    value_map: nav.value_map,
    value_map_color_bounds: nav.value_map_color_bounds,
  };
}

/**
 * Strip `dash` for the nav cards. Every figure on a card is the server's (`card_metrics_by_slug`,
 * the account rows); nothing is summed here.
 */
export function dashPickForNavStrip(
  ctx: Omit<DashboardNavContext, "liabilities_breakdown" | "nw_bucket_totals"> & {
    nw_bucket_totals?: DashboardNavContext["nw_bucket_totals"];
    liabilities_breakdown?: DashboardResponse["liabilities_breakdown"];
  }
): Pick<DashboardResponse, "accounts" | "liabilities_breakdown" | "dashboard_layout" | "card_metrics_by_slug"> {
  return {
    accounts: ctx.accounts,
    liabilities_breakdown: ctx.liabilities_breakdown,
    dashboard_layout: ctx.dashboard_layout,
    card_metrics_by_slug: ctx.card_metrics_by_slug,
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
    api.groupMonthlyPerformance(slug, opts.unit),
  ]);
  return { accounts, ts: series, groupPerf: perfResult };
}

