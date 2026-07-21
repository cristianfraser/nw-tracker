import { GROUP_TAB_VAL_TOTAL } from "./groupTabAggregation";
import type { DailySeriesResponse, TimeseriesAccountLine, TimeseriesBlock } from "./types";

/**
 * Daily valuation block for the day period view: per-account session lines + the group
 * Total, reusing the monthly block's account metadata (dataKeys, names, colors) so the
 * chart keeps identical series identities/colors across the M↔D toggle. Deposit companions
 * ("aportes acum.") map from the payload's cumulative series when present — the Aportes
 * acumulados toggle behaves exactly as in the monthly view — and are stripped only when the
 * payload lacks them.
 */
export function buildDailyValuationBlock(
  daily: DailySeriesResponse | null | undefined,
  monthlyBlock: Pick<TimeseriesBlock, "accounts"> | null | undefined
): TimeseriesBlock | null {
  if (!daily?.points.length) return null;
  const pointCount = daily.points.length;
  const monthlyAccounts = monthlyBlock?.accounts ?? [];
  const metaById = new Map(monthlyAccounts.map((a) => [a.account_id, a] as const));

  const stripDeposits = (a: TimeseriesAccountLine): TimeseriesAccountLine => {
    const { depositDataKey: _dep, deposit_series_name: _depName, ...rest } = a;
    return rest;
  };

  const accounts: TimeseriesAccountLine[] = [];
  const lines = (daily.accounts ?? []).map((l) => {
    const meta = metaById.get(l.account_id);
    if (!meta || meta.dataKey === GROUP_TAB_VAL_TOTAL) return null;
    const depsAcum =
      meta.depositDataKey && l.deposits_acum?.length === pointCount ? l.deposits_acum : null;
    accounts.push(depsAcum ? { ...meta } : stripDeposits(meta));
    return {
      values: l.values,
      dataKey: meta.dataKey,
      depositDataKey: depsAcum ? meta.depositDataKey! : null,
      depsAcum,
    };
  });

  const totalMeta = monthlyAccounts.find((a) => a.dataKey === GROUP_TAB_VAL_TOTAL);
  const totalDepsAcum =
    totalMeta?.depositDataKey && daily.deposits_acum_total?.length === pointCount
      ? daily.deposits_acum_total
      : null;
  if (totalMeta) accounts.push(totalDepsAcum ? { ...totalMeta } : stripDeposits(totalMeta));
  if (!accounts.length) return null;

  const points = daily.points.map((p, i) => {
    const row: Record<string, string | number | null> = { as_of_date: p.as_of_date };
    for (const line of lines) {
      if (!line) continue;
      row[line.dataKey] = line.values[i] ?? null;
      if (line.depositDataKey && line.depsAcum) row[line.depositDataKey] = line.depsAcum[i] ?? null;
    }
    if (totalMeta) {
      row[GROUP_TAB_VAL_TOTAL] = p.value;
      if (totalMeta.depositDataKey && totalDepsAcum) {
        row[totalMeta.depositDataKey] = totalDepsAcum[i] ?? null;
      }
    }
    return row;
  });

  return { accounts, points };
}
