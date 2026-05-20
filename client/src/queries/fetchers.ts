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

export type AssetGroupBundle = {
  accounts: AccountListRow[];
  ts: ValuationTimeseriesResponse;
  groupPerf: GroupMonthlyPerformanceResponse | null;
};

export async function fetchAssetGroupBundle(
  slug: string,
  unit: DisplayUnit
): Promise<AssetGroupBundle> {
  const [acc, series, perfResult] = await Promise.all([
    api.accountsByGroup(slug),
    api.valuationTimeseries(unit, { group: slug }),
    api.groupMonthlyPerformance(slug, unit).catch(() => null),
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

export type InversionesBundle = {
  accounts: AccountListRow[];
  navInv: AccountListRow[];
  navRet: AccountListRow[];
  navBrk: AccountListRow[];
  ts: ValuationTimeseriesResponse;
  groupPerf: GroupMonthlyPerformanceResponse | null;
};

export async function fetchInversionesBundle(opts: {
  apiGroup: string;
  apiSubgroup?: string;
  navScope: "root" | "retiro" | "brokerage";
  brkFetchSub?: string;
  unit: DisplayUnit;
}): Promise<InversionesBundle> {
  const accP = api.accountsByGroup(opts.apiGroup, opts.apiSubgroup);
  const treeBrkP =
    opts.navScope === "brokerage" && opts.brkFetchSub
      ? api.accountsByGroup("brokerage", undefined)
      : opts.navScope === "brokerage"
        ? accP
        : Promise.resolve({ accounts: [] as AccountListRow[] });
  const treeInvP =
    opts.navScope === "root"
      ? api.accountsByGroup("inversiones")
      : Promise.resolve({ accounts: [] as AccountListRow[] });
  const treeRetP =
    opts.navScope === "retiro"
      ? api.accountsByGroup("retirement")
      : Promise.resolve({ accounts: [] as AccountListRow[] });

  const [acc, tInv, tRet, tBrk, series, perfResult] = await Promise.all([
    accP,
    treeInvP,
    treeRetP,
    treeBrkP,
    api.valuationTimeseries(opts.unit, {
      group: opts.apiGroup,
      subgroup: opts.apiSubgroup,
    }),
    api.groupMonthlyPerformance(opts.apiGroup, opts.unit, opts.apiSubgroup).catch(() => null),
  ]);

  return {
    accounts: acc.accounts,
    navInv: tInv.accounts,
    navRet: tRet.accounts,
    navBrk: tBrk.accounts,
    ts: series,
    groupPerf: perfResult,
  };
}
