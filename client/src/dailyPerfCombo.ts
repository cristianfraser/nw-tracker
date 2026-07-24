import type { DailySeriesAccountLineDto, DailySeriesResponse } from "./types";

type ChartPoint = Record<string, string | number | null>;

/** The monthly block's bar metadata, reused verbatim so day mode keeps the same keys/colors. */
export type PerfBarAccountRef = { account_id: number; bar_data_key: string };

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * Cumulative anchors for a windowed day series: the monthly chart's running totals at the last
 * month-end BEFORE the window starts. Day mode only has the days in the window, so without this
 * its areas would restart at 0 mid-history and disagree with the monthly chart.
 *
 * `ytd` only carries when that month-end is in the same calendar year as the window's first day
 * (YTD resets each January); `accumulated` always carries.
 *
 * Fallback only — a window that opens mid-month misses that month's earlier days, so the level
 * would sit low by exactly that partial month. {@link buildDailyPerfComboPoints} prefers
 * {@link backSolvedAnchors} whenever a month-end is inside the window.
 */
export function cumulativeAnchorsBeforeWindow(
  monthlyPointsAsc: readonly ChartPoint[],
  windowStartYmd: string,
  opts?: { ytdKey?: string; accumKey?: string }
): { ytd: number; accumulated: number } {
  const ytdKey = opts?.ytdKey ?? "ytd_group";
  const accumKey = opts?.accumKey ?? "accumulated_earnings";
  let anchor: ChartPoint | null = null;
  for (const p of monthlyPointsAsc) {
    const d = String(p.as_of_date ?? "");
    if (d && d < windowStartYmd) anchor = p;
    else break;
  }
  if (!anchor) return { ytd: 0, accumulated: 0 };
  const sameYear = String(anchor.as_of_date ?? "").slice(0, 4) === windowStartYmd.slice(0, 4);
  return { ytd: sameYear ? num(anchor[ytdKey]) : 0, accumulated: num(anchor[accumKey]) };
}

/**
 * Anchors solved so the day-mode area **equals the monthly chart** at the first month-end inside
 * the window: `anchor = monthly(thatMonthEnd) − Σ daily P/L from the window start through it`.
 *
 * This is what makes the two period modes agree at every later month-end too, because the daily
 * P/L summed over a calendar month already equals that month's monthly P/L. Anchoring on the
 * previous month-end instead cannot: a window opening mid-month never sees that month's earlier
 * days. Null when no month-end falls inside the window (caller falls back).
 */
function backSolvedAnchors(
  dates: readonly string[],
  deltas: readonly number[],
  monthlyPointsAsc: readonly ChartPoint[],
  ytdKey: string,
  accumKey: string
): { ytd: number; accumulated: number } | null {
  if (!dates.length) return null;
  const indexByDate = new Map(dates.map((d, i) => [d, i]));
  for (const mp of monthlyPointsAsc) {
    const d = String(mp.as_of_date ?? "");
    const idx = indexByDate.get(d);
    if (idx == null) continue;
    let runAccum = 0;
    let runYtd = 0;
    const monthEndYear = d.slice(0, 4);
    for (let i = 0; i <= idx; i++) {
      runAccum += deltas[i]!;
      // YTD only counts the part of the run that shares the month-end's calendar year.
      if (dates[i]!.slice(0, 4) === monthEndYear) runYtd += deltas[i]!;
    }
    return { ytd: num(mp[ytdKey]) - runYtd, accumulated: num(mp[accumKey]) - runAccum };
  }
  return null;
}

/**
 * Day-grain points for a `MonthlyPerformanceComboChart`: one row per calendar day with the same
 * keys the monthly block uses — `pl_<id>` (or `pl_nav_<slug>` in Agrupado) per bar account,
 * `delta_total` = Σ those bars, and the cumulative `ytd_group` / `accumulated_earnings` areas
 * anchored on the monthly series so a month-end inside the window reads the same value in both
 * period modes.
 *
 * `lines` is whichever set the chart is showing (per-account or Agrupado bucket lines); their
 * `account_id`s are matched against the monthly `bar_accounts`, so an id the daily payload does
 * not carry simply contributes 0 rather than inventing a series.
 */
export function buildDailyPerfComboPoints(opts: {
  series: Pick<DailySeriesResponse, "points">;
  lines: readonly DailySeriesAccountLineDto[];
  barAccounts: readonly PerfBarAccountRef[];
  monthlyPointsAsc: readonly ChartPoint[];
  ytdKey?: string;
  accumKey?: string;
  totalKey?: string;
}): ChartPoint[] {
  const { series, lines, barAccounts, monthlyPointsAsc } = opts;
  const ytdKey = opts.ytdKey ?? "ytd_group";
  const accumKey = opts.accumKey ?? "accumulated_earnings";
  const totalKey = opts.totalKey ?? "delta_total";
  if (!series.points.length) return [];

  const lineById = new Map(lines.map((l) => [l.account_id, l]));
  const dates = series.points.map((p) => p.as_of_date);

  // Bars first: the cumulative anchors are solved from these same daily totals.
  const rows: ChartPoint[] = series.points.map((pt, i) => {
    const row: ChartPoint = { as_of_date: pt.as_of_date };
    for (const ba of barAccounts) {
      const v = lineById.get(ba.account_id)?.pl?.[i];
      row[ba.bar_data_key] = typeof v === "number" && Number.isFinite(v) ? v : 0;
    }
    return row;
  });
  const deltas = rows.map((row) =>
    barAccounts.reduce((sum, ba) => sum + num(row[ba.bar_data_key]), 0)
  );
  rows.forEach((row, i) => {
    row[totalKey] = deltas[i]!;
  });

  const anchors =
    backSolvedAnchors(dates, deltas, monthlyPointsAsc, ytdKey, accumKey) ??
    cumulativeAnchorsBeforeWindow(monthlyPointsAsc, dates[0]!, { ytdKey, accumKey });

  let year = dates[0]!.slice(0, 4);
  let ytdRun = anchors.ytd;
  let cumRun = anchors.accumulated;
  rows.forEach((row, i) => {
    const y = dates[i]!.slice(0, 4);
    if (y !== year) {
      year = y;
      ytdRun = 0; // YTD resets on the first day of each calendar year inside the window
    }
    ytdRun += deltas[i]!;
    cumRun += deltas[i]!;
    row[ytdKey] = ytdRun;
    row[accumKey] = cumRun;
  });
  return rows;
}
