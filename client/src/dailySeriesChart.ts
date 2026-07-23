import { GROUP_TAB_VAL_TOTAL } from "./groupTabAggregation";
import type { DailySeriesResponse, TimeseriesAccountLine, TimeseriesBlock } from "./types";

/**
 * Daily valuation block for the day period view: per-account session lines + the group
 * Total, reusing the monthly block's account metadata (dataKeys, names, colors) so the
 * chart keeps identical series identities/colors across the M↔D toggle. Deposit companions
 * ("aportes acum.") map from the payload's cumulative series when present — the Aportes
 * acumulados toggle behaves exactly as in the monthly view — and are stripped only when the
 * payload lacks them.
 *
 * Chart-host reference overlays («Disponible» on Pasivos, «Tarjeta de crédito» on Efectivo)
 * come as values keyed by dataKey and pair with the monthly block's `lines` metadata, the
 * same borrow-the-monthly-metadata rule the account lines follow. They live in `lines` only —
 * `buildRawLineSeries` also walks `accounts`, so duplicating there would draw them twice.
 */
export function buildDailyValuationBlock(
  daily: DailySeriesResponse | null | undefined,
  monthlyBlock: Pick<TimeseriesBlock, "accounts" | "lines"> | null | undefined
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

  // Overlay values matched to the monthly line defs; an unknown dataKey is skipped rather
  // than drawn with a synthesized label.
  const monthlyLineByKey = new Map((monthlyBlock?.lines ?? []).map((l) => [l.dataKey, l] as const));
  const refLines = (daily.reference_lines ?? []).flatMap((r) => {
    const meta = monthlyLineByKey.get(r.dataKey);
    return meta && r.values.length === pointCount ? [{ meta, values: r.values }] : [];
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
    for (const ref of refLines) row[ref.meta.dataKey] = ref.values[i] ?? null;
    return row;
  });

  return refLines.length
    ? { accounts, lines: refLines.map((r) => r.meta), points }
    : { accounts, points };
}
