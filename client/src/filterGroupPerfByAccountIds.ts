import type { GroupMonthlyPerformanceResponse } from "./types";

/** Keep only performance bar series for accounts in `accountIds`. */
export function filterGroupPerfByAccountIds(
  perf: GroupMonthlyPerformanceResponse | null,
  accountIds: Set<number>
): GroupMonthlyPerformanceResponse | null {
  if (!perf?.points.length) return perf;
  const bars = perf.bar_accounts.filter((b) => accountIds.has(b.account_id));
  if (!bars.length) return { ...perf, bar_accounts: [], points: perf.points };
  const barKeys = new Set(bars.map((b) => b.bar_data_key));
  const points = perf.points.map((row) => {
    const out: Record<string, string | number | null> = {
      as_of_date: row.as_of_date,
      delta_total: row.delta_total,
      ytd_group: row.ytd_group,
      accumulated_earnings: row.accumulated_earnings,
    };
    for (const k of barKeys) {
      if (k in row) out[k] = row[k] ?? null;
    }
    return out;
  });
  return { ...perf, bar_accounts: bars, points };
}
