import type { DailySeriesAccountLineDto, DailySeriesResponse } from "./types";

type ChartPoint = Record<string, string | number | null>;

/** The monthly block's bar metadata, reused verbatim so day mode keeps the same keys/colors. */
export type PerfBarAccountRef = { account_id: number; bar_data_key: string };

/**
 * Day-grain points for a `MonthlyPerformanceComboChart`, picked from the server's daily series:
 * one row per day with each bar account's own `pl` under its monthly `bar_data_key`, and the
 * total plus the running YTD / all-time levels as the server built them (`perf_levels`, anchored
 * on the scope's monthly rows so a month-end reads the same in both period modes).
 *
 * `lines` is whichever set the chart shows (per-account or Agrupado bucket lines); an id the
 * daily payload does not carry reads 0 rather than inventing a series.
 */
export function servedDailyPerfComboPoints(opts: {
  series: Pick<DailySeriesResponse, "points" | "perf_levels">;
  lines: readonly DailySeriesAccountLineDto[];
  barAccounts: readonly PerfBarAccountRef[];
  ytdKey?: string;
  accumKey?: string;
  totalKey?: string;
}): ChartPoint[] {
  const { series, lines, barAccounts } = opts;
  const levels = series.perf_levels;
  if (!levels) {
    throw new Error("servedDailyPerfComboPoints: the daily series was requested without perf_levels");
  }
  const n = series.points.length;
  if (levels.delta_total.length !== n || levels.ytd.length !== n || levels.accumulated.length !== n) {
    throw new Error("servedDailyPerfComboPoints: perf_levels are not aligned with the points");
  }
  const ytdKey = opts.ytdKey ?? "ytd_group";
  const accumKey = opts.accumKey ?? "accumulated_earnings";
  const totalKey = opts.totalKey ?? "delta_total";
  const lineById = new Map(lines.map((l) => [l.account_id, l]));
  return series.points.map((pt, i) => {
    const row: ChartPoint = { as_of_date: pt.as_of_date };
    for (const ba of barAccounts) {
      const v = lineById.get(ba.account_id)?.pl?.[i];
      row[ba.bar_data_key] = typeof v === "number" && Number.isFinite(v) ? v : 0;
    }
    row[totalKey] = levels.delta_total[i]!;
    row[ytdKey] = levels.ytd[i]!;
    row[accumKey] = levels.accumulated[i]!;
    return row;
  });
}
