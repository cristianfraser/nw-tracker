import { describe, expect, it } from "vitest";
import { pickMonthlyPerfRowsByMonth } from "./accountPeriodMetrics.js";
import { monthEndUtcYmd, monthKeyFromYmd } from "./calendarMonth.js";
import { dailyPerfLevelsForAccount, dailyPerfLevelsForGroup, type DailyPerfLevels } from "./dailyPerfLevels.js";
import { db } from "./db.js";
import { getGroupConsolidatedMonthlyRows } from "./groupConsolidatedTables.js";
import { resolveAccountDailySeries, resolveGroupDailySeries } from "./groupDailySeries.js";
import { monthlyPerfRowsForAccount } from "./groupMonthlyPerfConsolidation.js";
import { getNetWorthNavGroupNode, type NavTreeNodeDto } from "./navTree.js";
import { isResolvablePortfolioGroupSlug } from "./portfolioGroupTree.js";
import type { TsUnit } from "./valuationTimeseries.js";

const num = (v: number | null | undefined): number => (v != null && Number.isFinite(v) ? v : 0);

type Row = { as_of_date: string; ytd_nominal_pl: number | null; cumulative_nominal_pl: number | null };

/**
 * The served day combo of a scope: the total is the series' own day P/L, the levels run by it
 * (YTD restarting on January 1st), and at the end of the window's first month both levels equal
 * the scope's monthly row — the identity the client back-solved before (2026-10-28).
 */
function expectMeetsMonthly(
  label: string,
  points: readonly { as_of_date: string; pl: number | null }[],
  levels: DailyPerfLevels,
  monthlyAsc: readonly Row[],
  unit: TsUnit,
  mismatches: string[]
) {
  const tol = unit === "usd" ? 0.011 : 1.01;
  if (!points.length) return;
  points.forEach((p, i) => {
    if (Math.abs(levels.delta_total[i]! - num(p.pl)) > 1e-6) mismatches.push(`${label} ${p.as_of_date} delta`);
    if (i === 0) return;
    if (Math.abs(levels.accumulated[i]! - levels.accumulated[i - 1]! - levels.delta_total[i]!) > 1e-6) {
      mismatches.push(`${label} ${p.as_of_date} accumulated step`);
    }
    const expectYtd = p.as_of_date.endsWith("-01-01")
      ? levels.delta_total[i]!
      : levels.ytd[i - 1]! + levels.delta_total[i]!;
    if (Math.abs(levels.ytd[i]! - expectYtd) > 1e-6) mismatches.push(`${label} ${p.as_of_date} ytd step`);
  });
  const startMk = monthKeyFromYmd(points[0]!.as_of_date);
  let anchor = -1;
  points.forEach((p, i) => {
    if (p.as_of_date <= monthEndUtcYmd(startMk)) anchor = i;
  });
  const monthRow = monthlyAsc.filter((r) => monthKeyFromYmd(r.as_of_date) <= startMk).at(-1);
  if (Math.abs(levels.accumulated[anchor]! - num(monthRow?.cumulative_nominal_pl)) >= tol) {
    mismatches.push(
      `${label} accumulated ${levels.accumulated[anchor]} vs monthly ${monthRow?.cumulative_nominal_pl ?? null}`
    );
  }
  if (monthRow && monthKeyFromYmd(monthRow.as_of_date) === startMk) {
    if (Math.abs(levels.ytd[anchor]! - num(monthRow.ytd_nominal_pl)) >= tol) {
      mismatches.push(`${label} ytd ${levels.ytd[anchor]} vs monthly ${monthRow.ytd_nominal_pl}`);
    }
  }
}

describe("served day-mode P/L levels", () => {
  const groupSlugs: string[] = [];
  const visit = (n: NavTreeNodeDto) => {
    if (n.account_id == null && n.expense_account_id == null) {
      if (n.slug === "net_worth" || isResolvablePortfolioGroupSlug(n.slug)) groupSlugs.push(n.slug);
    }
    for (const c of n.children ?? []) visit(c);
  };
  const root = getNetWorthNavGroupNode();
  if (root) visit(root);

  for (const unit of ["clp", "usd"] as const) {
    it(`every group page's levels meet its consolidated table (${unit})`, () => {
      expect(groupSlugs.length).toBeGreaterThan(3);
      const mismatches: string[] = [];
      for (const slug of groupSlugs) {
        for (const days of [45, 400]) {
          const series = resolveGroupDailySeries(slug, unit, days);
          if (!series) continue;
          const levels = dailyPerfLevelsForGroup(slug, unit, series);
          const monthlyAsc = [...getGroupConsolidatedMonthlyRows(slug, unit)].reverse();
          expectMeetsMonthly(`${slug}/${days}`, series.points, levels, monthlyAsc, unit, mismatches);
        }
      }
      expect(mismatches).toEqual([]);
    }, 600_000);

    it(`every account's levels meet its own monthly rows (${unit})`, () => {
      const accounts = db
        .prepare(
          `SELECT a.id AS account_id, a.name, g.slug AS bucket_slug, a.import_key
           FROM accounts a JOIN asset_groups g ON g.id = a.asset_group_id ORDER BY a.id`
        )
        .all() as { account_id: number; name: string; bucket_slug: string; import_key: string | null }[];
      expect(accounts.length).toBeGreaterThan(0);
      const mismatches: string[] = [];
      for (const a of accounts) {
        const series = resolveAccountDailySeries(a, unit, 60);
        const levels = dailyPerfLevelsForAccount(a.account_id, a.bucket_slug, unit, series);
        const monthlyAsc = [
          ...pickMonthlyPerfRowsByMonth(monthlyPerfRowsForAccount(a.account_id, a.bucket_slug, unit)).values(),
        ];
        expectMeetsMonthly(`account ${a.account_id}`, series.points, levels, monthlyAsc, unit, mismatches);
      }
      expect(mismatches).toEqual([]);
    }, 600_000);
  }
});
