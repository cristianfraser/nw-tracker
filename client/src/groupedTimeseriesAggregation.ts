import { averageRgbTriplets } from "./chartColors";
import {
  addNullableNumbers,
  appendGroupTabTotalsClient,
  GROUP_TAB_VAL_TOTAL,
} from "./groupTabAggregation";
import type {
  AccountListRow,
  GroupMonthlyPerformanceBarAccount,
  GroupMonthlyPerformanceResponse,
  TimeseriesAccountLine,
  TimeseriesBlock,
} from "./types";

export type GroupChartBucketMeta = {
  key: string;
  accountId: number;
  dataKey: string;
  depKey: string;
  barDataKey: string;
  name: string;
  /** Nav / portfolio group color (`r,g,b`). */
  color_rgb?: string | null;
};

function accountColorRgbFromLine(
  line: TimeseriesAccountLine,
  listRows: AccountListRow[]
): string | undefined {
  if (line.color_rgb) return line.color_rgb;
  return listRows.find((r) => r.id === line.account_id)?.color_rgb ?? undefined;
}

/** Sum member account series into synthetic bucket lines (valuation + optional deposits). */
export function aggregateValuationByBucket(
  block: TimeseriesBlock,
  listRows: AccountListRow[],
  orderedKeys: readonly string[],
  meta: Record<string, GroupChartBucketMeta>,
  idToBucket: (id: number) => string | null
): TimeseriesBlock {
  const members = (block.accounts ?? []).filter(
    (a) => a.account_id > 0 && !a.exclude_from_group_totals
  );
  if (members.length === 0) return block;

  const used = new Set<string>();
  for (const a of members) {
    const b = idToBucket(a.account_id);
    if (b) used.add(b);
  }
  if (used.size === 0) return block;

  const ordered = orderedKeys.filter((k) => used.has(k));
  const unmappedMembers = members.filter((a) => !idToBucket(a.account_id));
  const synth: TimeseriesAccountLine[] = ordered.map((k) => {
    const m = meta[k]!;
    const groupMembers = members.filter((a) => idToBucket(a.account_id) === k);
    const fromServer = block.synthetic_group_color_rgb?.[String(m.accountId)];
    const color_rgb =
      m.color_rgb ??
      fromServer ??
      averageRgbTriplets(groupMembers.map((a) => accountColorRgbFromLine(a, listRows)));
    return {
      account_id: m.accountId,
      name: m.name,
      dataKey: m.dataKey,
      valueSeriesType: "data",
      depositDataKey: m.depKey,
      deposit_series_name: "aportes acum.",
      ...(color_rgb ? { color_rgb } : {}),
    };
  });

  const refLines = (block.lines ?? []).filter((l) => l.dataKey.startsWith("ref:"));

  const points = block.points.map((row) => {
    const out: Record<string, string | number | null> = { ...row };
    for (const k of ordered) {
      const m = meta[k]!;
      out[m.dataKey] = null;
      out[m.depKey] = null;
    }
    for (const a of members) {
      const b = idToBucket(a.account_id);
      if (!b) continue;
      const m = meta[b]!;
      out[m.dataKey] = addNullableNumbers(out[m.dataKey], row[a.dataKey]);
      if (a.depositDataKey) {
        out[m.depKey] = addNullableNumbers(out[m.depKey], row[a.depositDataKey]);
      }
    }
    return out;
  });

  const preserveConsolidatedGroupTotal = (block.accounts ?? []).some(
    (a) => a.dataKey === GROUP_TAB_VAL_TOTAL
  );
  const base: TimeseriesBlock = {
    accounts: [...synth, ...unmappedMembers],
    points,
    ...(refLines.length ? { lines: refLines } : block.lines?.length ? { lines: block.lines } : {}),
  };
  return appendGroupTabTotalsClient(base, { preserveConsolidatedGroupTotal });
}

export function aggregatePieByBucket(
  pie: { name: string; account_id: number; value: number }[],
  orderedKeys: readonly string[],
  meta: Record<string, GroupChartBucketMeta>,
  idToBucket: (id: number) => string | null
): { name: string; account_id: number; value: number }[] {
  const sums = new Map<string, number>();
  for (const s of pie) {
    const b = idToBucket(s.account_id);
    if (!b) continue;
    sums.set(b, (sums.get(b) ?? 0) + s.value);
  }
  const ordered = orderedKeys.filter((k) => sums.has(k));
  return ordered.map((k) => ({
    name: meta[k]!.name,
    account_id: meta[k]!.accountId,
    value: sums.get(k) ?? 0,
  }));
}

export function aggregatePerformanceByBucket(
  perf: GroupMonthlyPerformanceResponse,
  listRows: AccountListRow[],
  orderedKeys: readonly string[],
  meta: Record<string, GroupChartBucketMeta>,
  rowToBucket: (row: AccountListRow) => string | null
): GroupMonthlyPerformanceResponse {
  const barById = new Map<number, GroupMonthlyPerformanceBarAccount>();
  for (const b of perf.bar_accounts) {
    barById.set(b.account_id, b);
  }

  const used = new Set<string>();
  for (const b of perf.bar_accounts) {
    const row = listRows.find((r) => r.id === b.account_id);
    if (!row) continue;
    const k = rowToBucket(row);
    if (k) used.add(k);
  }
  if (used.size === 0) return perf;

  const ordered = orderedKeys.filter((k) => used.has(k));
  const bar_accounts: GroupMonthlyPerformanceBarAccount[] = ordered.map((k) => {
    const m = meta[k]!;
    return {
      account_id: m.accountId,
      name: m.name,
      bar_data_key: m.barDataKey,
      ...(m.color_rgb ? { color_rgb: m.color_rgb } : {}),
    };
  });

  const points = perf.points.map((row) => {
    const out: Record<string, string | number | null> = { ...row };
    for (const k of ordered) {
      const m = meta[k]!;
      out[m.barDataKey] = null;
      let acc = 0;
      let any = false;
      for (const r of listRows) {
        if (rowToBucket(r) !== k) continue;
        const ba = barById.get(r.id);
        if (!ba) continue;
        const v = row[ba.bar_data_key];
        if (typeof v === "number" && Number.isFinite(v)) {
          acc += v;
          any = true;
        }
      }
      out[m.barDataKey] = any ? acc : null;
    }
    return out;
  });

  return { ...perf, bar_accounts, points };
}
