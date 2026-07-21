import { GROUP_TAB_VAL_TOTAL } from "./groupTabAggregation";
import type { DailySeriesResponse, TimeseriesAccountLine, TimeseriesBlock } from "./types";

/** Shared day-view window (~4.5 months of sessions) for group/account daily fetches. */
export const DAILY_SERIES_DEFAULT_SESSIONS = 90;

/**
 * Daily valuation block for the day period view: per-account session lines + the group
 * Total, reusing the monthly block's account metadata (dataKeys, names, colors) so the
 * chart keeps identical series identities/colors across the M↔D toggle. Deposit series
 * are stripped — the daily payload carries values only.
 */
export function buildDailyValuationBlock(
  daily: DailySeriesResponse | null | undefined,
  monthlyBlock: Pick<TimeseriesBlock, "accounts"> | null | undefined
): TimeseriesBlock | null {
  if (!daily?.points.length) return null;
  const monthlyAccounts = monthlyBlock?.accounts ?? [];
  const metaById = new Map(monthlyAccounts.map((a) => [a.account_id, a] as const));

  const stripDeposits = (a: TimeseriesAccountLine): TimeseriesAccountLine => {
    const { depositDataKey: _dep, deposit_series_name: _depName, ...rest } = a;
    return rest;
  };

  const accounts: TimeseriesAccountLine[] = [];
  const lineKeys: (string | null)[] = (daily.accounts ?? []).map((l) => {
    const meta = metaById.get(l.account_id);
    if (!meta || meta.dataKey === GROUP_TAB_VAL_TOTAL) return null;
    accounts.push(stripDeposits(meta));
    return meta.dataKey;
  });

  const totalMeta = monthlyAccounts.find((a) => a.dataKey === GROUP_TAB_VAL_TOTAL);
  if (totalMeta) accounts.push(stripDeposits(totalMeta));
  if (!accounts.length) return null;

  const points = daily.points.map((p, i) => {
    const row: Record<string, string | number | null> = { as_of_date: p.as_of_date };
    (daily.accounts ?? []).forEach((l, li) => {
      const key = lineKeys[li];
      if (key) row[key] = l.values[i] ?? null;
    });
    if (totalMeta) row[GROUP_TAB_VAL_TOTAL] = p.value;
    return row;
  });

  return { accounts, points };
}
