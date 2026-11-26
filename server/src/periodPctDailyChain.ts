import type { DashboardAccountStats } from "./brokerageAcciones.js";
import { priorPeriodEndYmd } from "./accountPeriodMarks.js";
import { chileCalendarAddDays, chileCalendarTodayYmd } from "./chileDate.js";
import type { ChainedGroupPct } from "./dashboardNavCardMetrics.js";
import { db } from "./db.js";
import { compound } from "./perfKernel.js";
import {
  accountDailyPctPoints,
  dailyPctPointsForScope,
  groupDailyPctPoints,
  type DailyPctPoint,
} from "./dailyPctSeries.js";
import { listAccountsForGroupTab, type TsUnit } from "./valuationTimeseries.js";

/**
 * One definition of a period's return (2026-11-05): the daily flow-adjusted `pct` of the scope's
 * own daily series (`dailySeries.ts`), compounded over the days of the period — a day is one
 * step; a week, month, year, YTD, the Rentabilidad windows and the all-time «Total» compound the
 * days in them. A day without a return (nothing held) is flat; a period with none is null.
 *
 * Every % surface reads it: the Rentabilidad windows (`periodReturnsDaily.ts`), the «Detalle por
 * mes / año» rows of accounts and groups ({@link withDailyChainedMonthPct}; a year is the
 * compound of its months, so of its days), the dashboard account rows and the nav groups'
 * `row_pct` / `parent_pct` (accounts tables, value map) and the class Δ chart's % view. The old
 * one-step rule over a whole period (`flowAdjustedPct` with the period's flow counted from its
 * first day) only stays where the scope holds nothing but liabilities, whose P/L is a cost, not
 * a return; and the all-time P/L ÷ net deposits is kept beside the compounded Total as
 * `*_on_deposits` (shown in a tooltip).
 */

export type ChainPeriod = "day" | "month" | "year" | "total";

/** The last day before the period (exclusive start of the chain); null = since the first day. */
export function chainPeriodStartYmd(period: ChainPeriod, todayYmd: string): string | null {
  if (period === "total") return null;
  if (period === "day") return chileCalendarAddDays(todayYmd, -1);
  return priorPeriodEndYmd(period === "month" ? "mtd" : "ytd", todayYmd);
}

/** Π(1 + daily pct) − 1 over (startYmd, todayYmd]; null when no day in it has a return. */
export function chainDailyPct(
  points: readonly { as_of_date: string; pct: number | null }[],
  startYmd: string | null,
  todayYmd: string
): number | null {
  // A daily series is in date order: the period is a run of it, found by its two ends instead of
  // walking every day of the history for each period of each row.
  if (inDateOrder(points)) {
    const from = startYmd == null ? 0 : firstIndexAfter(points, startYmd);
    const to = firstIndexAfter(points, todayYmd);
    return compound(pctRun(points, from, to));
  }
  return compound(
    points.filter((p) => (startYmd == null || p.as_of_date > startYmd) && p.as_of_date <= todayYmd).map((p) => p.pct)
  );
}

type DatedPct = { as_of_date: string; pct: number | null };

const dateOrderByList = new WeakMap<object, boolean>();
/** Whether the points' days ascend (checked once per list; the lists are read many times). */
function inDateOrder(points: readonly DatedPct[]): boolean {
  let ordered = dateOrderByList.get(points);
  if (ordered === undefined) {
    ordered = true;
    for (let i = 1; i < points.length; i++) {
      if (points[i]!.as_of_date < points[i - 1]!.as_of_date) {
        ordered = false;
        break;
      }
    }
    dateOrderByList.set(points, ordered);
  }
  return ordered;
}

/** The first index whose day is after `ymd` (the list's length when none is), in a date-ordered list. */
function firstIndexAfter(points: readonly DatedPct[], ymd: string): number {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (points[mid]!.as_of_date <= ymd) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function* pctRun(points: readonly DatedPct[], from: number, to: number): Generator<number | null> {
  for (let i = from; i < to; i++) yield points[i]!.pct;
}

/** A daily point of a scope's own series: its date and its flow-adjusted return of the day (`dailyPctSeries.ts`). */
export type { DailyPctPoint };

/**
 * The YTD % at `ymd`: the daily returns of `ymd`'s calendar year compounded through `ymd` — the
 * rule the Rentabilidad YTD window uses at today (`chainPeriodStartYmd("year", …)`: from the
 * prior year-end, exclusive). `byYear` holds the scope's points keyed by `YYYY`.
 */
function ytdPctAt(byYear: ReadonlyMap<string, readonly DailyPctPoint[]>, ymd: string): number | null {
  return chainDailyPct(byYear.get(ymd.slice(0, 4)) ?? [], null, ymd);
}

function groupPointsBy(points: readonly DailyPctPoint[], keyLength: 4 | 7): Map<string, DailyPctPoint[]> {
  const out = new Map<string, DailyPctPoint[]>();
  for (const p of points) {
    const k = p.as_of_date.slice(0, keyLength);
    const list = out.get(k);
    if (list) list.push(p);
    else out.set(k, [p]);
  }
  return out;
}

/**
 * Detalle rows with `pct_month` replaced by the compound of the daily returns of the row's
 * calendar month up to the row's date (the month in progress: through today), and `ytd_pct` the
 * compound of the daily returns of the row's calendar year through the row's date (the YTD
 * window's rule, {@link ytdPctAt}; beside `ytd_nominal_pl`). The rows keep every other field; a
 * month (year) with no daily return reads null. Rows of the same month would get the same
 * window, which no detalle series has (one row per month).
 */
export function withDailyChainedMonthPct<T extends { as_of_date: string; pct_month: number | null }>(
  rows: readonly T[],
  points: readonly DailyPctPoint[]
): (T & { ytd_pct: number | null })[] {
  const byMonth = groupPointsBy(points, 7);
  const byYear = groupPointsBy(points, 4);
  return rows.map((row) => ({
    ...row,
    pct_month: chainDailyPct(byMonth.get(row.as_of_date.slice(0, 7)) ?? [], null, row.as_of_date),
    ytd_pct: ytdPctAt(byYear, row.as_of_date),
  }));
}

/**
 * Daily detalle points with `ytd_pct`: each day's YTD % from the scope's FULL-history daily
 * returns (`fullPoints`, so a short window still compounds from January 1), the same rule as the
 * monthly rows' `ytd_pct`.
 */
export function withDailyYtdPct<T extends { as_of_date: string }>(
  points: readonly T[],
  fullPoints: readonly DailyPctPoint[]
): (T & { ytd_pct: number | null })[] {
  const byYear = groupPointsBy(fullPoints, 4);
  // One running compound per year over the full series, read back per point date.
  const ytdByDate = new Map<string, number | null>();
  for (const [, list] of byYear) {
    let factor = 1;
    let any = false;
    for (const p of [...list].sort((a, b) => a.as_of_date.localeCompare(b.as_of_date))) {
      if (p.pct != null && Number.isFinite(p.pct)) {
        factor *= 1 + p.pct;
        any = true;
      }
      ytdByDate.set(p.as_of_date, any ? factor - 1 : null);
    }
  }
  return points.map((p) => {
    const hit = ytdByDate.get(p.as_of_date);
    return { ...p, ytd_pct: hit !== undefined ? hit : ytdPctAt(byYear, p.as_of_date) };
  });
}

/** A scope made only of liabilities keeps the one-step rule (its P/L is a cost, not a return). */
export function isLiabilityOnlyScope(
  accountIds: readonly number[],
  isLiability: (accountId: number) => boolean
): boolean {
  return accountIds.length > 0 && accountIds.every(isLiability);
}

/** Full-history daily returns → chained % for one period, the input of the fillers below. */
export type DailyPctFor = (unit: TsUnit) => readonly DailyPctPoint[] | null;

export function chainedPctFromSeries(
  pointsFor: DailyPctFor,
  period: ChainPeriod,
  unit: TsUnit,
  todayYmd: string = chileCalendarTodayYmd()
): number | null {
  const points = pointsFor(unit);
  if (!points) return null;
  return chainDailyPct(points, chainPeriodStartYmd(period, todayYmd), todayYmd);
}

const PCT_FIELDS: readonly { period: ChainPeriod; pct: "pct_day" | "pct_month" | "pct_year" | "pct_total" }[] = [
  { period: "day", pct: "pct_day" },
  { period: "month", pct: "pct_month" },
  { period: "year", pct: "pct_year" },
  { period: "total", pct: "pct_total" },
];

/**
 * Dashboard account rows (in `unit`) with every period % read from the account's own daily series
 * (the `account:<id>` build its page shares), compounded over the period; the one-step Total
 * (P/L ÷ net deposits) moves to `pct_total_on_deposits`. Liability rows keep the one-step rule.
 */
export function withDailyChainedAccountRowPcts(
  rows: DashboardAccountStats[],
  unit: TsUnit,
  isLiability: (accountId: number) => boolean
): DashboardAccountStats[] {
  const todayYmd = chileCalendarTodayYmd();
  const importKeyStmt = db.prepare(`SELECT import_key FROM accounts WHERE id = ?`);
  return rows.map((row) => {
    if (isLiability(row.account_id)) return row;
    const importKey = (importKeyStmt.get(row.account_id) as { import_key: string | null } | undefined)
      ?.import_key ?? null;
    const ref = { account_id: row.account_id, name: row.name, bucket_slug: row.bucket_slug, import_key: importKey };
    const seriesFor: DailyPctFor = (u) => accountDailyPctPoints(ref, u);
    const chained: Partial<DashboardAccountStats> = { pct_total_on_deposits: row.pct_total ?? null };
    for (const f of PCT_FIELDS) chained[f.pct] = chainedPctFromSeries(seriesFor, f.period, unit, todayYmd);
    return { ...row, ...chained };
  });
}

/**
 * The `chainedGroupPct` input of `buildNavCardMetricsBySlug`: a group's own daily series
 * (`pg:<slug>`, shared with its page), an account's own (`account:<id>`, the value map's account
 * tiles) or one over a page's liquidated rows, compounded over the period. `undefined` for a scope of liabilities only (the one-step cell stays).
 */
export function chainedGroupPctResolver(
  rows: readonly DashboardAccountStats[],
  unit: TsUnit,
  isLiability: (accountId: number) => boolean
): ChainedGroupPct {
  const todayYmd = chileCalendarTodayYmd();
  const rowById = new Map(rows.map((r) => [r.account_id, r]));
  const importKeyStmt = db.prepare(`SELECT import_key FROM accounts WHERE id = ?`);
  const unitOk = (asked: TsUnit) => {
    if (asked !== unit) throw new Error(`chained %: asked in ${asked} for rows built in ${unit}`);
  };
  return (scope, period, asked) => {
    unitOk(asked);
    if (scope.kind === "group") {
      const members = listAccountsForGroupTab(scope.slug).filter((r) => r.account_id > 0);
      if (isLiabilityOnlyScope(members.map((r) => r.account_id), isLiability)) return undefined;
      return chainedPctFromSeries((u) => groupDailyPctPoints(scope.slug, u), period, unit, todayYmd);
    }
    if (scope.kind === "account") {
      if (isLiability(scope.accountId)) return undefined;
      const row = rowById.get(scope.accountId);
      if (!row) throw new Error(`chained %: account ${scope.accountId} has no dashboard row`);
      const importKey =
        (importKeyStmt.get(scope.accountId) as { import_key: string | null } | undefined)?.import_key ?? null;
      const ref = { account_id: scope.accountId, name: row.name, bucket_slug: row.bucket_slug, import_key: importKey };
      return chainedPctFromSeries((u) => accountDailyPctPoints(ref, u), period, unit, todayYmd);
    }
    if (isLiabilityOnlyScope(scope.accountIds, isLiability)) return undefined;
    const refs = scope.accountIds.map((id) => {
      const row = rowById.get(id);
      if (!row) throw new Error(`chained %: liquidated account ${id} has no dashboard row`);
      const importKey =
        (importKeyStmt.get(id) as { import_key: string | null } | undefined)?.import_key ?? null;
      return { account_id: id, name: row.name, bucket_slug: row.bucket_slug, import_key: importKey };
    });
    return chainedPctFromSeries(
      (u) => dailyPctPointsForScope(`liquidated:${scope.parentSlug}`, refs, u),
      period,
      unit,
      todayYmd
    );
  };
}
