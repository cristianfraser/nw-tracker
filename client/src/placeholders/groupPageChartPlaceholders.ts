import type { PortfolioGroupBundle } from "../queries/fetchers";
import type { DisplayUnit } from "../queries/keys";
import type {
  AccountListRow,
  ChartBucketLineMetaDto,
  GroupMonthlyPerformanceGroupedBars,
  GroupMonthlyPerformanceResponse,
  NavTreeNodeDto,
  ProportionalSeriesBlockDto,
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

/**
 * Zero-valued grouped bucket block from the nav node's server-emitted `chart_buckets` metadata —
 * same dataKeys / synthetic ids / labels / colors the real grouped block carries, so the loading
 * skeleton renders the final chart shape and the real payload swaps in without remounting series.
 */
function zeroBucketBlock(
  metas: readonly ChartBucketLineMetaDto[],
  firstMonth?: string | null
): TimeseriesBlock {
  const lines = [
    {
      account_id: -1,
      name: "Total",
      dataKey: "__group_val_total",
      valueSeriesType: "reference" as const,
    },
    ...metas.map((m) => ({
      account_id: m.account_id,
      name: m.name,
      ...(m.name_i18n_key != null ? { name_i18n_key: m.name_i18n_key } : {}),
      dataKey: m.data_key,
      valueSeriesType: "data" as const,
      ...(m.color_rgb != null ? { color_rgb: m.color_rgb } : {}),
    })),
  ];
  const points = monthEndYmdsForSkeleton(firstMonth).map((as_of_date) => {
    const row: Record<string, string | number | null> = { as_of_date, __group_val_total: 0 };
    for (const m of metas) {
      row[m.data_key] = 0;
    }
    return row;
  });
  return { accounts: lines, points };
}

function equalSharesForBuckets(
  metas: readonly ChartBucketLineMetaDto[],
  firstMonth?: string | null
): ProportionalSeriesBlockDto {
  const dates = monthEndYmdsForSkeleton(firstMonth);
  const share = metas.length > 0 ? 1 / metas.length : 1;
  return {
    dates,
    series: metas.map((m) => ({
      dataKey: m.data_key,
      name: m.name,
      ...(m.name_i18n_key != null ? { name_i18n_key: m.name_i18n_key } : {}),
      ...(m.color_rgb != null ? { color_rgb: m.color_rgb } : {}),
      account_id: m.account_id,
      values: dates.map(() => share),
    })),
  };
}

function zeroBucketBars(
  metas: readonly ChartBucketLineMetaDto[],
  firstMonth?: string | null
): GroupMonthlyPerformanceGroupedBars {
  const bar_accounts = metas.map((m) => ({
    account_id: m.account_id,
    name: m.name,
    ...(m.name_i18n_key != null ? { name_i18n_key: m.name_i18n_key } : {}),
    bar_data_key: m.bar_data_key,
    ...(m.color_rgb != null ? { color_rgb: m.color_rgb } : {}),
  }));
  const points = monthEndYmdsForSkeleton(firstMonth).map((as_of_date) => {
    const row: Record<string, string | number | null> = {
      as_of_date,
      delta_total: 0,
      ytd_group: 0,
      accumulated_earnings: 0,
    };
    for (const m of metas) {
      row[m.bar_data_key] = 0;
    }
    return row;
  });
  return { bar_accounts, points };
}

/** Grouped skeleton fields for the timeseries payload, from the nav node's `chart_buckets`. */
function placeholderGroupedTsFields(
  navNode: NavTreeNodeDto | null | undefined,
  firstMonth?: string | null
): Partial<ValuationTimeseriesResponse> {
  const cb = navNode?.chart_buckets;
  if (!cb) return {};
  if (cb.liab?.length) {
    return {
      liab_grouped_block: zeroBucketBlock(cb.liab, firstMonth),
      liab_grouped_proportional: equalSharesForBuckets(cb.liab, firstMonth),
    };
  }
  if (!cb.grouped?.length && !cb.ungrouped?.length) return {};
  return {
    nav_grouped_blocks: {
      ...(cb.grouped?.length ? { grouped: zeroBucketBlock(cb.grouped, firstMonth) } : {}),
      ...(cb.ungrouped?.length ? { ungrouped: zeroBucketBlock(cb.ungrouped, firstMonth) } : {}),
    },
    ...(cb.grouped?.length
      ? { nav_grouped_proportional: equalSharesForBuckets(cb.grouped, firstMonth) }
      : {}),
  };
}

/** Grouped skeleton bars for the perf payload, from the nav node's `chart_buckets`. */
function placeholderGroupedPerfFields(
  navNode: NavTreeNodeDto | null | undefined,
  firstMonth?: string | null
): Partial<GroupMonthlyPerformanceResponse> {
  const cb = navNode?.chart_buckets;
  if (!cb) return {};
  if (cb.liab?.length) {
    return { liab_grouped_bars: zeroBucketBars(cb.liab, firstMonth) };
  }
  if (!cb.grouped?.length && !cb.ungrouped?.length) return {};
  return {
    nav_grouped_bars: {
      ...(cb.grouped?.length ? { grouped: zeroBucketBars(cb.grouped, firstMonth) } : {}),
      ...(cb.ungrouped?.length ? { ungrouped: zeroBucketBars(cb.ungrouped, firstMonth) } : {}),
    },
  };
}

export function buildPlaceholderGroupPerf(
  accounts: readonly AccountListRow[],
  groupSlug: string,
  unit: DisplayUnit,
  firstMonth?: string | null,
  navNode?: NavTreeNodeDto | null
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
    ...placeholderGroupedPerfFields(navNode, firstMonth),
  };
}

export function buildPlaceholderGroupTimeseries(
  accounts: readonly AccountListRow[],
  unit: DisplayUnit,
  firstMonth?: string | null,
  navNode?: NavTreeNodeDto | null
): Pick<
  ValuationTimeseriesResponse,
  | "unit"
  | "accounts_in_group"
  | "group_allocation_proportional"
  | "nav_grouped_blocks"
  | "nav_grouped_proportional"
  | "liab_grouped_block"
  | "liab_grouped_proportional"
> {
  return {
    unit: unitForTs(unit),
    accounts_in_group: buildPlaceholderGroupValuationBlock(accounts, firstMonth),
    group_allocation_proportional: buildPlaceholderGroupAllocationProportional(accounts, firstMonth),
    ...placeholderGroupedTsFields(navNode, firstMonth),
  };
}

export function buildPlaceholderPortfolioGroupBundle(
  unit: DisplayUnit,
  accounts: readonly AccountListRow[] = [],
  portfolioGroup = "",
  firstMonth?: string | null,
  navNode?: NavTreeNodeDto | null
): PortfolioGroupBundle {
  if (accounts.length === 0) {
    const unitTs = unitForTs(unit);
    return {
      accounts: [],
      ts: {
        unit: unitTs,
        accounts_in_group: { lines: [], points: [] },
        group_allocation_proportional: { dates: [], series: [] },
        ...placeholderGroupedTsFields(navNode, firstMonth),
      },
      groupPerf: null,
    };
  }

  return {
    accounts: [...accounts],
    ts: buildPlaceholderGroupTimeseries(accounts, unit, firstMonth, navNode),
    groupPerf: buildPlaceholderGroupPerf(accounts, portfolioGroup, unit, firstMonth, navNode),
  };
}
