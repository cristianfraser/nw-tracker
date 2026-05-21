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
  const showUsd = unit === "usd";
  const [dash, fx, ts, retirementPerf, brokeragePerf] = await Promise.all([
    api.dashboard(showUsd),
    api.fxLatest(),
    api.valuationTimeseries(unit),
    api.groupMonthlyPerformance("retirement", unit).catch(() => null),
    api.groupMonthlyPerformance("brokerage", unit).catch(() => null),
  ]);
  return { dash, fx, ts, retirementPerf, brokeragePerf };
}

export type PortfolioGroupBundle = {
  accounts: AccountListRow[];
  ts: ValuationTimeseriesResponse;
  groupPerf: GroupMonthlyPerformanceResponse | null;
};

/** @deprecated Use {@link fetchPortfolioGroupBundle} */
export type AssetGroupBundle = PortfolioGroupBundle;

/** @deprecated Use {@link fetchPortfolioGroupBundle} */
export const fetchAssetGroupBundle = fetchPortfolioGroupBundle;

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

export type SidebarAccountsBundle = {
  cash: AccountListRow[];
  liabilities: AccountListRow[];
  realEstate: AccountListRow[];
  inversiones: AccountListRow[];
};

export async function fetchSidebarAccounts(): Promise<SidebarAccountsBundle> {
  const [cash, liabilities, realEstate, inversiones] = await Promise.all([
    api.accountsByGroup("cash_eqs"),
    api.accountsByGroup("liabilities"),
    api.accountsByGroup("real_estate"),
    api.accountsByGroup("inversiones"),
  ]);
  return {
    cash: cash.accounts,
    liabilities: liabilities.accounts,
    realEstate: realEstate.accounts,
    inversiones: inversiones.accounts,
  };
}

