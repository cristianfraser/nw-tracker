import { describe, expect, it } from "vitest";
import { monthKeyFromYmd } from "./calendarMonth.js";
import { getGroupConsolidatedTables } from "./groupConsolidatedTables.js";
import { buildInversionesPerfDaily, buildInversionesPerfMonthly } from "./inversionesPerfSeries.js";
import type { TsUnit } from "./valuationTimeseries.js";

/**
 * The class Δ chart's % view reads the one rule every % surface reads (daily returns
 * compounded, `periodPctDailyChain.ts`): each month equals the «Detalle por mes» row of its
 * scope, each year its «Detalle por año» row, and the last point the Rentabilidad YTD and TOTAL.
 */
describe("inversiones % view vs detalle and Rentabilidad", () => {
  const same = (a: number | null | undefined, b: number | null | undefined, label: string) => {
    if (a == null || b == null) {
      expect(a ?? null, label).toBe(b ?? null);
      return;
    }
    expect(Math.abs(a - b), label).toBeLessThan(1e-9);
  };

  for (const unit of ["clp", "usd"] as const satisfies readonly TsUnit[]) {
    it(`monthly, yearly and daily points match their tables (${unit})`, () => {
      const inv = getGroupConsolidatedTables("inversiones", unit);
      const ret = getGroupConsolidatedTables("retirement", unit);
      const brk = getGroupConsolidatedTables("brokerage", unit);
      const byMonth = (rows: { as_of_date: string; pct_month: number | null }[]) =>
        new Map(rows.map((r) => [monthKeyFromYmd(r.as_of_date), r.pct_month]));
      const invM = byMonth(inv.consolidated_monthly);
      const retM = byMonth(ret.consolidated_monthly);
      const brkM = byMonth(brk.consolidated_monthly);

      const block = buildInversionesPerfMonthly(unit, []);
      expect(block.points.length).toBeGreaterThan(3);
      for (const p of block.points) {
        const mk = monthKeyFromYmd(p.as_of_date);
        same(p.pct_combined, invM.get(mk), `inversiones ${mk}`);
        if (retM.has(mk)) same(p.pct_retirement, retM.get(mk), `retirement ${mk}`);
        if (brkM.has(mk)) same(p.pct_brokerage, brkM.get(mk), `brokerage ${mk}`);
      }

      const invY = new Map(inv.consolidated_yearly.map((r) => [r.as_of_date.slice(0, 4), r.pct_month]));
      for (const y of block.yearly_pct) {
        const year = y.as_of_date.slice(0, 4);
        expect(Math.abs((y.pct_combined ?? 0) - (invY.get(year) ?? 0)), `year ${year}`).toBeLessThan(1e-9);
      }

      const cells = new Map((inv.period_returns?.periods ?? []).map((c) => [c.period, c.pct]));
      const last = block.points.at(-1)!;
      same(last.ytd_pct, cells.get("ytd"), "YTD");
      same(last.accumulated_pct, cells.get("total"), "TOTAL");
      same(block.yearly_pct.at(-1)!.accumulated_pct, cells.get("total"), "TOTAL (yearly)");

      const daily = buildInversionesPerfDaily(unit, 45);
      const lastDay = daily.points.at(-1)!;
      same(lastDay.ytd_pct, cells.get("ytd"), "YTD (daily)");
      same(lastDay.accumulated_pct, cells.get("total"), "TOTAL (daily)");
      same(lastDay.pct_combined, cells.get("d1"), "1D (daily)");
    }, 600_000);
  }
});
