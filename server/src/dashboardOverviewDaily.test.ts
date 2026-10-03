import { describe, expect, it } from "vitest";
import { getDashboardOverviewDaily } from "./dashboardOverviewDaily.js";
import { getDashboardValuationTimeseries } from "./valuationTimeseries.js";

/**
 * The daily overview payload carries the two blocks the day-mode dashboard charts need
 * («Patrimonio neto vs invested» and «Cuentas principales»). They must be aligned to the
 * `points` grid and — because both the daily and the monthly views now sum the same marks
 * (phase 2a) — agree with the monthly chart at shared month-ends.
 */
describe("getDashboardOverviewDaily — phase 3 blocks", () => {
  it("carries patrimonio (request unit + milestones) and primary_lines, aligned to points", () => {
    const d = getDashboardOverviewDaily("clp", 90);
    expect(d.points.length).toBeGreaterThan(0);

    // Patrimonio: one point per day, with total_nw + invested + USD milestone levels.
    expect(d.patrimonio.length).toBe(d.points.length);
    const lastPat = d.patrimonio[d.patrimonio.length - 1]!;
    expect(Object.keys(lastPat)).toEqual(
      expect.arrayContaining(["as_of_date", "total_nw", "invested", "usd_100k"])
    );
    // total_nw on the patrimonio block is the CLP net worth == the overview net_worth (clp req).
    const lastOverview = d.points[d.points.length - 1]!;
    expect(lastPat.total_nw).toBe(lastOverview.net_worth);

    // Primary child lines: each aligned to the points grid.
    expect(d.primary_lines.length).toBeGreaterThan(0);
    for (const line of d.primary_lines) {
      expect(line.values.length).toBe(d.points.length);
      expect(line.dataKey).toMatch(/^-?\d+$/);
    }
  });

  it("primary lines and patrimonio match the monthly chart at a shared month-end", () => {
    const d = getDashboardOverviewDaily("clp", 0);
    const m = getDashboardValuationTimeseries("clp");

    const dayIdx = new Map(d.points.map((p, i) => [p.as_of_date, i]));
    // Pick a month-end present in both the daily grid and the monthly primary chart.
    const monthEnd = m.accounts_ex_property.points
      .map((p) => String(p.as_of_date))
      .filter((date) => dayIdx.has(date))
      .at(-2); // penultimate: avoid the live "today" point whose value moves intraday
    if (!monthEnd) return; // lean synthetic DB may not overlap — shape test above still covers it
    const i = dayIdx.get(monthEnd)!;

    const monthlyRow = m.accounts_ex_property.points.find((p) => p.as_of_date === monthEnd)!;
    for (const line of d.primary_lines) {
      const daily = line.values[i];
      const monthly = monthlyRow[line.dataKey];
      const nd = typeof daily === "number" && Number.isFinite(daily) ? daily : null;
      const nm = typeof monthly === "number" && Number.isFinite(monthly) ? monthly : null;
      if (nd == null || nm == null) continue;
      // Σ marks either way; allow a peso of rounding.
      expect(Math.abs(nd - nm)).toBeLessThan(2);
    }

    const patByDate = new Map(d.patrimonio.map((p) => [String(p.as_of_date), p]));
    const monthlyPat = m.patrimonio_usd_milestones_chart.points.find(
      (p) => p.as_of_date === monthEnd
    );
    const dailyPat = patByDate.get(monthEnd);
    if (monthlyPat && dailyPat) {
      for (const key of ["total_nw", "invested"] as const) {
        const nd = dailyPat[key];
        const nm = monthlyPat[key];
        if (typeof nd === "number" && typeof nm === "number") {
          expect(Math.abs(nd - nm)).toBeLessThan(2);
        }
      }
    }
  });

  it("patrimonio follows the request unit: USD values, flat USD milestones", () => {
    const d = getDashboardOverviewDaily("usd", 90);
    const m = getDashboardValuationTimeseries("usd");
    expect(m.patrimonio_usd_milestones_chart.unit).toBe("usd");
    for (const p of [...d.patrimonio, ...m.patrimonio_usd_milestones_chart.points]) {
      expect(p.usd_50k).toBe(50_000);
      expect(p.usd_500k).toBe(500_000);
    }
    // Value lines are the overview's own USD points.
    d.patrimonio.forEach((p, i) => {
      expect(p.total_nw).toBe(d.points[i]!.net_worth);
      expect(p.invested).toBe(d.points[i]!.invested);
    });
    const overviewByDate = new Map(m.overview.points.map((p) => [String(p.as_of_date), p]));
    for (const p of m.patrimonio_usd_milestones_chart.points) {
      const o = overviewByDate.get(String(p.as_of_date));
      if (o) expect(p.total_nw).toBe(o.total_nw ?? null);
    }
  });
});
