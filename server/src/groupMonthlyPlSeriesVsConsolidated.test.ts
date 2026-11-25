import { describe, expect, it } from "vitest";
import { getNetWorthNavGroupNode, type NavTreeNodeDto } from "./navTree.js";
import { getGroupConsolidatedMonthlyRows } from "./groupConsolidatedTables.js";
import { getGroupMonthlyPlSeries } from "./groupMonthlyPlSeries.js";
import { buildInversionesPerfMonthly } from "./inversionesPerfSeries.js";
import { anchorDailyLevels } from "./dailyPerfLevels.js";
import { buildInversionesConsolidatedMonthly } from "./netWorthConsolidation.js";
import { isResolvablePortfolioGroupSlug } from "./portfolioGroupTree.js";
import { monthKeyFromYmd } from "./calendarMonth.js";
import type { TsUnit } from "./valuationTimeseries.js";

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * The group P/L combo (bars, YTD area, «Total acumulado») reads the consolidation's own picked
 * per-account rows, so every point equals the «Detalle por mes» row of its month and the bars
 * add up to it — on every nav group (cash scopes too: the linked-card netting moves closes, not
 * `nominal_pl`) and in both units. Until 2026-10-28 a parallel builder read the valuation-series
 * performance alone, dropped the checking accounts and counted excluded accounts.
 */
describe("group monthly P/L series vs consolidated monthly table", () => {
  const slugs: string[] = [];
  const visit = (n: NavTreeNodeDto) => {
    if (n.account_id == null && n.expense_account_id == null && n.group_kind !== "reference") {
      slugs.push(n.slug);
    }
    for (const c of n.children ?? []) visit(c);
  };
  const root = getNetWorthNavGroupNode();
  if (root) visit(root);
  const scopes = [...new Set([...slugs, "inversiones", "liabilities"])].filter(
    (slug) => slug === "net_worth" || isResolvablePortfolioGroupSlug(slug)
  );

  for (const unit of ["clp", "usd"] as const satisfies readonly TsUnit[]) {
    it(`every scope's points equal its consolidated rows (${unit})`, () => {
      expect(scopes.length).toBeGreaterThan(3);
      const tol = unit === "usd" ? 0.011 : 1.01;
      const mismatches: string[] = [];
      const close = (label: string, a: number, b: number) => {
        if (Math.abs(a - b) >= tol) mismatches.push(`${label}: ${a} vs ${b}`);
      };
      for (const slug of scopes) {
        const series = getGroupMonthlyPlSeries(slug, unit, { groupedBlocks: true });
        const rowsAsc = [...getGroupConsolidatedMonthlyRows(slug, unit)].reverse();
        expect(series.points.map((p) => p.as_of_date), slug).toEqual(rowsAsc.map((r) => r.as_of_date));
        series.points.forEach((pt, i) => {
          const row = rowsAsc[i]!;
          const at = `${slug} ${row.as_of_date}`;
          close(`${at} delta_total`, num(pt.delta_total), num(row.nominal_pl));
          close(`${at} ytd_group`, num(pt.ytd_group), num(row.ytd_nominal_pl));
          close(`${at} accumulated_earnings`, num(pt.accumulated_earnings), num(row.cumulative_nominal_pl));
          const bars = series.bar_accounts.reduce((s, ba) => s + num(pt[ba.bar_data_key]), 0);
          close(`${at} Σ bars`, bars, num(row.nominal_pl));
          // Agrupado bars regroup the same per-account bars.
          const grouped = series.nav_grouped_bars?.grouped ?? series.liab_grouped_bars;
          if (grouped) {
            const gpt = grouped.points[i]!;
            const gsum = grouped.bar_accounts.reduce((s, ba) => s + num(gpt[ba.bar_data_key]), 0);
            close(`${at} Σ grouped bars`, gsum, num(row.nominal_pl));
          }
        });
      }
      expect(mismatches).toEqual([]);
    }, 600_000);

    it(`home inversiones block equals the inversiones consolidation (${unit})`, () => {
      const rowsAsc = [...buildInversionesConsolidatedMonthly(unit)].reverse();
      expect(rowsAsc.length).toBeGreaterThan(0);
      const retByMonth = new Map(
        getGroupConsolidatedMonthlyRows("retirement", unit).map((r) => [monthKeyFromYmd(r.as_of_date), r])
      );
      const brkByMonth = new Map(
        getGroupConsolidatedMonthlyRows("brokerage", unit).map((r) => [monthKeyFromYmd(r.as_of_date), r])
      );
      const block = buildInversionesPerfMonthly(unit);
      expect(block.points.map((p) => p.as_of_date)).toEqual(rowsAsc.map((r) => r.as_of_date));
      const tol = unit === "usd" ? 0.011 : 1.01;
      block.points.forEach((pt, i) => {
        const row = rowsAsc[i]!;
        const mk = monthKeyFromYmd(row.as_of_date);
        expect(Math.abs(pt.delta_combined - num(row.nominal_pl))).toBeLessThan(tol);
        expect(Math.abs(pt.ytd_combined - num(row.ytd_nominal_pl))).toBeLessThan(tol);
        expect(Math.abs(pt.accumulated_earnings - num(row.cumulative_nominal_pl))).toBeLessThan(tol);
        expect(Math.abs(pt.delta_retirement - num(retByMonth.get(mk)?.nominal_pl))).toBeLessThan(tol);
        expect(Math.abs(pt.delta_brokerage - num(brkByMonth.get(mk)?.nominal_pl))).toBeLessThan(tol);
        expect(Math.abs(pt.delta_retirement + pt.delta_brokerage - pt.delta_combined)).toBeLessThan(tol);
      });
    }, 600_000);
  }
});

describe("anchorDailyLevels", () => {
  const monthly = [
    { as_of_date: "2025-11-30", cumulative_nominal_pl: 100 },
    { as_of_date: "2025-12-31", cumulative_nominal_pl: 150 },
    { as_of_date: "2026-01-31", cumulative_nominal_pl: 170 },
    { as_of_date: "2026-02-28", cumulative_nominal_pl: 160 },
  ];

  it("solves the start so the first month-end reads the monthly level", () => {
    const dates = ["2026-01-29", "2026-01-30", "2026-01-31", "2026-02-01"];
    const deltas = [5, 3, 2, 7];
    const { accumulated, ytdOffset } = anchorDailyLevels(dates, deltas, monthly);
    // 170 at Jan 31 after 5 + 3 + 2 of window P/L.
    expect(accumulated).toBe(160);
    expect(accumulated + 5 + 3 + 2).toBe(170);
    // YTD of 2026 = accumulated − lifetime through December.
    expect(ytdOffset).toBe(150);
    expect(accumulated + 10 - ytdOffset).toBe(20);
  });

  it("carries the last level for a month with no row, and reads 0 at a month-end before any row", () => {
    expect(anchorDailyLevels(["2026-03-30", "2026-03-31"], [1, 1], monthly)).toEqual({
      accumulated: 158,
      ytdOffset: 150,
    });
    expect(anchorDailyLevels(["2025-10-31"], [4], monthly)).toEqual({ accumulated: -4, ytdOffset: 0 });
  });
});
