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
  return compound(
    points.filter((p) => (startYmd == null || p.as_of_date > startYmd) && p.as_of_date <= todayYmd).map((p) => p.pct)
  );
}

/** A daily point of a scope's own series: its date and its flow-adjusted return of the day (`dailyPctSeries.ts`). */
export type { DailyPctPoint };

/**
 * Detalle rows with `pct_month` replaced by the compound of the daily returns of the row's
 * calendar month up to the row's date (the month in progress: through today). The rows keep
 * every other field; a month with no daily return reads null. Rows of the same month would get
 * the same window, which no detalle series has (one row per month).
 */
export function withDailyChainedMonthPct<T extends { as_of_date: string; pct_month: number | null }>(
  rows: readonly T[],
  points: readonly DailyPctPoint[]
): T[] {
  const byMonth = new Map<string, DailyPctPoint[]>();
  for (const p of points) {
    const mk = p.as_of_date.slice(0, 7);
    const list = byMonth.get(mk);
    if (list) list.push(p);
    else byMonth.set(mk, [p]);
  }
  return rows.map((row) => ({
    ...row,
    pct_month: chainDailyPct(byMonth.get(row.as_of_date.slice(0, 7)) ?? [], null, row.as_of_date),
  }));
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
