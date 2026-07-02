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
  nw_bucket_totals?: DashboardNavContextResponse["nw_bucket_totals"];
  inversiones_period_metrics?: DashboardNavContextResponse["inversiones_period_metrics"];
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
    inversiones_period_metrics: nav.inversiones_period_metrics,
    overviewPoints: nav.overview?.points ?? [],
  };
}

import type { DashboardGroupSlug } from "../dashboardCardBreakdown";
import { isDashboardNwBucketSlug } from "../portfolioDashboardBuckets";
import { portfolioStripGroupChildren, resolveDashboardBucketFromNavNode } from "../portfolioNavFromApi";
import { sumCashSavingsAdjustedForNav, sumCashSavingsAdjustedUsdForNav, sumDashboardRowsForNavNode, sumDashboardRowsUsdForNavNode } from "../portfolioGroupTotals";
import type { NavTreeNodeDto } from "../types";

function nwBucketTotalsFromNavStrip(
  netWorthRoot: NavTreeNodeDto | null | undefined,
  accounts: DashboardResponse["accounts"]
): Pick<
  DashboardResponse["totals"],
  "real_estate_clp" | "retirement_clp" | "brokerage_clp" | "cash_eqs_clp"
> {
  const out: Record<"real_estate" | "retirement" | "brokerage" | "cash_eqs", number> = {
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

function nwBucketTotalsUsdFromNavStrip(
  netWorthRoot: NavTreeNodeDto | null | undefined,
  accounts: DashboardResponse["accounts"]
): Partial<
  Pick<
    DashboardResponse["totals"],
    "real_estate_usd" | "retirement_usd" | "brokerage_usd" | "cash_eqs_usd"
  >
> {
  const out: Partial<Record<DashboardGroupSlug, number>> = {};
  if (!netWorthRoot) return {};
  for (const child of portfolioStripGroupChildren(netWorthRoot)) {
    const bucket = resolveDashboardBucketFromNavNode(child);
    if (!bucket || bucket === "net_worth" || !isDashboardNwBucketSlug(bucket)) continue;
    const usd = sumDashboardRowsUsdForNavNode(child, accounts);
    if (usd !== undefined) out[bucket] = usd;
  }
  return {
    real_estate_usd: out.real_estate,
    retirement_usd: out.retirement,
    brokerage_usd: out.brokerage,
    cash_eqs_usd: out.cash_eqs,
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

function sumOptionalUsdParts(...parts: (number | undefined)[]): number | undefined {
  let sum = 0;
  let any = false;
  for (const p of parts) {
    if (p !== undefined && Number.isFinite(p)) {
      sum += p;
      any = true;
    }
  }
  return any ? sum : undefined;
}

export function dashPickForNavStrip(
  ctx: DashboardNavContext & { liabilities_breakdown?: DashboardResponse["liabilities_breakdown"] },
  netWorthRoot: NavTreeNodeDto | null | undefined
): Pick<
  DashboardResponse,
  "accounts" | "liabilities_breakdown" | "dashboard_layout"
> & {
  totals: DashboardResponse["totals"];
  inversiones_period_metrics?: DashboardNavContextResponse["inversiones_period_metrics"];
} {
  const include = (a: DashboardResponse["accounts"][number]) => a.exclude_from_group_totals !== 1;
  const serverBuckets = ctx.nw_bucket_totals;
  const bucketTotals = serverBuckets
    ? {
        real_estate_clp: serverBuckets.real_estate_clp,
        retirement_clp: serverBuckets.retirement_clp,
        brokerage_clp: serverBuckets.brokerage_clp,
        cash_eqs_clp: serverBuckets.cash_eqs_clp,
      }
    : nwBucketTotalsFromNavStrip(netWorthRoot, ctx.accounts);
  const real_estate_clp = bucketTotals.real_estate_clp;
  const retirement_clp = bucketTotals.retirement_clp;
  const brokerage_clp = bucketTotals.brokerage_clp;
  const linkedCcClp =
    ctx.dashboard_layout
      ?.find((c) => c.slug === "cash_eqs")
      ?.linked_balances?.find((lb) => lb.slug === "credit_card")?.clp ?? 0;
  const cash_eqs_clp = serverBuckets
    ? serverBuckets.cash_eqs_clp
    : sumCashSavingsAdjustedForNav(netWorthRoot, ctx.accounts, linkedCcClp);
  const liabilities_clp =
    (ctx.liabilities_breakdown?.mortgage_clp ?? 0) + (ctx.liabilities_breakdown?.credit_card_clp ?? 0);
  const net_worth_clp = serverBuckets?.net_worth_clp ?? real_estate_clp + retirement_clp + brokerage_clp + cash_eqs_clp;
  const deposits_clp = ctx.accounts
    .filter(include)
    .reduce((s, a) => s + (a.deposits_clp ?? 0), 0);

  const linkedCcUsd =
    ctx.dashboard_layout
      ?.find((c) => c.slug === "cash_eqs")
      ?.linked_balances?.find((lb) => lb.slug === "credit_card")?.usd;
  const bucketUsd = nwBucketTotalsUsdFromNavStrip(netWorthRoot, ctx.accounts);
  const real_estate_usd = serverBuckets?.real_estate_usd ?? bucketUsd.real_estate_usd;
  const retirement_usd = serverBuckets?.retirement_usd ?? bucketUsd.retirement_usd;
  const brokerage_usd = serverBuckets?.brokerage_usd ?? bucketUsd.brokerage_usd;
  const cash_eqs_usd =
    serverBuckets?.cash_eqs_usd ??
    sumCashSavingsAdjustedUsdForNav(netWorthRoot, ctx.accounts, linkedCcUsd);
  const mortgageUsd = ctx.liabilities_breakdown?.mortgage_usd;
  const creditCardUsd = ctx.liabilities_breakdown?.credit_card_usd;
  const liabilities_usd =
    (mortgageUsd != null && Number.isFinite(mortgageUsd)) ||
    (creditCardUsd != null && Number.isFinite(creditCardUsd))
      ? (mortgageUsd ?? 0) + (creditCardUsd ?? 0)
      : undefined;
  const net_worth_usd = serverBuckets?.net_worth_usd ?? sumOptionalUsdParts(
    real_estate_usd,
    retirement_usd,
    brokerage_usd,
    cash_eqs_usd
  );
  const deposits_usd = sumDepositsUsd(ctx.accounts, include);

  const zeroCloses: DashboardResponse["totals"]["prior_closes"] = {
    month_end: "",
    year_end: "",
    month: {
      net_worth_clp: 0,
      real_estate_clp: 0,
      retirement_clp: 0,
      brokerage_clp: 0,
      cash_eqs_clp: 0,
    },
    year: {
      net_worth_clp: 0,
      real_estate_clp: 0,
      retirement_clp: 0,
      brokerage_clp: 0,
      cash_eqs_clp: 0,
    },
  };

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
      prior_closes: serverBuckets?.prior_closes ?? zeroCloses,
      ...(net_worth_usd !== undefined ? { net_worth_usd } : {}),
      ...(deposits_usd !== undefined ? { deposits_usd } : {}),
      ...(real_estate_usd !== undefined ? { real_estate_usd } : {}),
      ...(retirement_usd !== undefined ? { retirement_usd } : {}),
      ...(brokerage_usd !== undefined ? { brokerage_usd } : {}),
      ...(cash_eqs_usd !== undefined ? { cash_eqs_usd } : {}),
      ...(liabilities_usd !== undefined ? { liabilities_usd } : {}),
    },
    inversiones_period_metrics: ctx.inversiones_period_metrics,
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

