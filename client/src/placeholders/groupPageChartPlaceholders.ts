import type { PortfolioGroupBundle } from "../queries/fetchers";
import type { DisplayUnit } from "../queries/keys";
import type {
  AccountListRow,
  GroupMonthlyPerformanceResponse,
  TimeseriesBlock,
  ValuationTimeseriesResponse,
} from "../types";
import { monthEndYmdsForSkeleton } from "./placeholderMonthRows";

function unitForTs(unit: DisplayUnit): "clp" | "usd" {
  return unit === "usd" ? "usd" : "clp";
}

/** Flat zero valuation block — one line per account, month-end points at 0. */
export function buildPlaceholderGroupValuationBlock(
  accounts: readonly AccountListRow[],
  firstMonth?: string | null
): TimeseriesBlock {
  const accountLines = accounts.map((a) => ({
    account_id: a.id,
    name: a.name,
    dataKey: String(a.id),
    valueSeriesType: "data" as const,
    color_rgb: a.color_rgb ?? undefined,
  }));

  const points = monthEndYmdsForSkeleton(firstMonth).map((as_of_date) => {
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

/** Equal shares so the composition panel renders; replaced when real valuations load. */
export function buildPlaceholderGroupAllocationProportional(
  accounts: readonly AccountListRow[],
  firstMonth?: string | null
): ValuationTimeseriesResponse["group_allocation_proportional"] {
  const dates = monthEndYmdsForSkeleton(firstMonth);
  const share = accounts.length > 0 ? 1 / accounts.length : 1;
  return {
    dates,
    series: accounts.map((a) => ({
      dataKey: String(a.id),
      name: a.name,
      account_id: a.id,
      values: dates.map(() => share),
    })),
  };
}

export function buildPlaceholderGroupPerf(
  accounts: readonly AccountListRow[],
  groupSlug: string,
  unit: DisplayUnit,
  firstMonth?: string | null
): GroupMonthlyPerformanceResponse {
  const unitTs = unitForTs(unit);
  const bar_accounts = accounts.map((a) => ({
    account_id: a.id,
    name: a.name,
    bar_data_key: `pl_${a.id}`,
    color_rgb: a.color_rgb ?? undefined,
  }));

  const points = monthEndYmdsForSkeleton(firstMonth).map((as_of_date) => {
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
  unit: DisplayUnit,
  firstMonth?: string | null
): Pick<
  ValuationTimeseriesResponse,
  "unit" | "accounts_in_group" | "group_allocation_proportional"
> {
  return {
    unit: unitForTs(unit),
    accounts_in_group: buildPlaceholderGroupValuationBlock(accounts, firstMonth),
    group_allocation_proportional: buildPlaceholderGroupAllocationProportional(accounts, firstMonth),
  };
}

export function buildPlaceholderPortfolioGroupBundle(
  unit: DisplayUnit,
  accounts: readonly AccountListRow[] = [],
  portfolioGroup = "",
  firstMonth?: string | null
): PortfolioGroupBundle {
  if (accounts.length === 0) {
    const unitTs = unitForTs(unit);
    return {
      accounts: [],
      ts: {
        unit: unitTs,
        accounts_in_group: { lines: [], points: [] },
        group_allocation_proportional: { dates: [], series: [] },
      },
      groupPerf: null,
    };
  }

  return {
    accounts: [...accounts],
    ts: buildPlaceholderGroupTimeseries(accounts, unit, firstMonth),
    groupPerf: buildPlaceholderGroupPerf(accounts, portfolioGroup, unit, firstMonth),
  };
}
