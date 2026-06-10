import type { PortfolioGroupBundle } from "../queries/fetchers";
import type { DisplayUnit } from "../queries/keys";
import type {
  AccountListRow,
  GroupMonthlyPerformanceResponse,
  TimeseriesBlock,
  ValuationTimeseriesResponse,
} from "../types";
import { monthEndYmdsThroughToday } from "./placeholderMonthRows";

function unitForTs(unit: DisplayUnit): "clp" | "usd" {
  return unit === "usd" ? "usd" : "clp";
}

/** Flat zero valuation block — one line per account, month-end points at 0. */
export function buildPlaceholderGroupValuationBlock(
  accounts: readonly AccountListRow[]
): TimeseriesBlock {
  const accountLines = accounts.map((a) => ({
    account_id: a.id,
    name: a.name,
    dataKey: String(a.id),
    valueSeriesType: "data" as const,
    color_rgb: a.color_rgb ?? undefined,
  }));

  const points = monthEndYmdsThroughToday().map((as_of_date) => {
    const row: Record<string, string | number | null> = { as_of_date };
    for (const a of accounts) {
      row[String(a.id)] = 0;
    }
    return row;
  });

  return {
    accounts: accountLines,
    points,
  };
}

/** Pie slices at 1 CLP each so the panel renders; replaced when real valuations load. */
export function buildPlaceholderGroupAllocationPie(
  accounts: readonly AccountListRow[]
): ValuationTimeseriesResponse["group_allocation_pie"] {
  return accounts.map((a) => ({
    name: a.name,
    account_id: a.id,
    value: 1,
  }));
}

export function buildPlaceholderGroupPerf(
  accounts: readonly AccountListRow[],
  groupSlug: string,
  unit: DisplayUnit
): GroupMonthlyPerformanceResponse {
  const unitTs = unitForTs(unit);
  const bar_accounts = accounts.map((a) => ({
    account_id: a.id,
    name: a.name,
    bar_data_key: `pl_${a.id}`,
    color_rgb: a.color_rgb ?? undefined,
  }));

  const points = monthEndYmdsThroughToday().map((as_of_date) => {
    const row: Record<string, string | number | null> = {
      as_of_date,
      delta_total: 0,
      ytd_group: 0,
      accumulated_earnings: 0,
    };
    for (const a of accounts) {
      row[`pl_${a.id}`] = 0;
    }
    return row;
  });

  return {
    unit: unitTs,
    group_slug: groupSlug,
    bar_accounts,
    points,
  };
}

export function buildPlaceholderGroupTimeseries(
  accounts: readonly AccountListRow[],
  unit: DisplayUnit
): Pick<ValuationTimeseriesResponse, "unit" | "accounts_in_group" | "group_allocation_pie"> {
  return {
    unit: unitForTs(unit),
    accounts_in_group: buildPlaceholderGroupValuationBlock(accounts),
    group_allocation_pie: buildPlaceholderGroupAllocationPie(accounts),
  };
}

export function buildPlaceholderPortfolioGroupBundle(
  unit: DisplayUnit,
  accounts: readonly AccountListRow[] = [],
  portfolioGroup = ""
): PortfolioGroupBundle {
  if (accounts.length === 0) {
    const unitTs = unitForTs(unit);
    return {
      accounts: [],
      ts: {
        unit: unitTs,
        accounts_in_group: { lines: [], points: [] },
        group_allocation_pie: [],
      },
      groupPerf: null,
    };
  }

  return {
    accounts: [...accounts],
    ts: buildPlaceholderGroupTimeseries(accounts, unit),
    groupPerf: buildPlaceholderGroupPerf(accounts, portfolioGroup, unit),
  };
}
