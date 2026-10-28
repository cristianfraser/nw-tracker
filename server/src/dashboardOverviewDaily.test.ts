import { describe, expect, it } from "vitest";
import { getDashboardOverviewDaily } from "./dashboardOverviewDaily.js";
import { getDashboardValuationTimeseries } from "./valuationTimeseries.js";

/**
 * The daily overview payload carries what the day-mode dashboard charts need (the overview
 * points with their USD milestone levels, and «Cuentas principales»). They must be aligned to
 * the `points` grid and — because both the daily and the monthly views now sum the same marks
 * (phase 2a) — agree with the monthly chart at shared month-ends.
 */
describe("getDashboardOverviewDaily — phase 3 blocks", () => {
  it("carries USD milestone levels on every point and primary_lines aligned to points", () => {
    const d = getDashboardOverviewDaily("clp", 90);
    expect(d.points.length).toBeGreaterThan(0);

    for (const p of d.points) {
      expect(Object.keys(p)).toEqual(expect.arrayContaining(["usd_50k", "usd_100k", "usd_500k"]));
    }

    // Primary child lines: each aligned to the points grid.
    expect(d.primary_lines.length).toBeGreaterThan(0);
    for (const line of d.primary_lines) {
      expect(line.values.length).toBe(d.points.length);
      expect(line.dataKey).toMatch(/^-?\d+$/);
    }
  });

  it("primary lines and the overview match the monthly chart at a shared month-end", () => {
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

    const monthlyOverview = m.overview.points.find((p) => p.as_of_date === monthEnd);
    const dailyOverview = d.points[i]!;
    if (monthlyOverview) {
      for (const [dailyKey, monthlyKey] of [
        ["net_worth", "total_nw"],
        ["invested", "invested"],
        ["usd_100k", "usd_100k"],
      ] as const) {
        const nd = dailyOverview[dailyKey];
        const nm = monthlyOverview[monthlyKey];
        if (typeof nd === "number" && typeof nm === "number") {
          expect(Math.abs(nd - nm)).toBeLessThan(2);
        }
      }
    }
  });

  it("a primary line starts at its first non-zero value, never on a run of zeros (both grains)", () => {
    const d = getDashboardOverviewDaily("clp", 0);
    for (const line of d.primary_lines) {
      const first = line.values.find((v) => v != null);
      if (first != null) expect(first).not.toBe(0);
    }
    const m = getDashboardValuationTimeseries("clp").accounts_ex_property;
    for (const a of m.accounts) {
      const first = m.points.map((p) => p[a.dataKey]).find((v) => v != null);
      if (first != null) expect(first).not.toBe(0);
    }
  });

  it("composition lines (one level below the big buckets) agree between daily and monthly at a month-end", () => {
    const d = getDashboardOverviewDaily("clp", 0).allocation_proportional;
    const m = getDashboardValuationTimeseries("clp").allocation_proportional;
    expect(d.series.map((x) => x.dataKey)).toEqual(m.series.map((x) => x.dataKey));
    expect(m.series.length).toBeGreaterThan(3);
    const dayIdx = new Map(d.dates.map((date, i) => [date, i]));
    const mi = m.dates.map((date, i) => ({ date, i })).filter((x) => dayIdx.has(x.date)).at(-2);
    if (!mi) return;
    for (const ms of m.series) {
      const ds = d.series.find((x) => x.dataKey === ms.dataKey)!;
      const a = ds.values[dayIdx.get(mi.date)!] ?? 0;
      const b = ms.values[mi.i] ?? 0;
      expect(Math.abs(a - b)).toBeLessThan(1e-6);
    }
  });

  it("USD milestones follow the request unit: flat in USD on both grains", () => {
    const d = getDashboardOverviewDaily("usd", 90);
    const m = getDashboardValuationTimeseries("usd");
    for (const p of [...d.points, ...m.overview.points] as Record<string, unknown>[]) {
      expect(p.usd_50k).toBe(50_000);
      expect(p.usd_500k).toBe(500_000);
    }
    expect(m.overview.lines.filter((l) => l.dataKey.startsWith("usd_")).map((l) => l.valueSeriesType)).toEqual(
      ["reference", "reference", "reference", "reference", "reference"]
    );
  });
});
