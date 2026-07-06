import { describe, expect, it } from "vitest";
import {
  ageAtMonth,
  PROJECTION_RETIRE_AGE,
  runProjectionEngine,
  type ProjectionEngineInput,
} from "./projections.js";

const BASE: ProjectionEngineInput = {
  base_total: 300_000_000,
  base_invested: 200_000_000,
  start_month: "2026-08",
  monthly_aporte: 1_000_000,
  real_return_pct: 5,
  retire_return_pct: 4,
  inflation_pct: 3.5,
  end_age: 95,
  swr_pct: 4,
  pct_balance_pct: 5,
  monthly_income: 0,
  drawdown_base: "total",
};

describe("runProjectionEngine", () => {
  it("accumulates monthly and retires at the birth-month + 65 boundary", () => {
    const r = runProjectionEngine(BASE);
    expect(r.retire_month).toBe("2057-01");
    expect(ageAtMonth(r.retire_month)).toBe(PROJECTION_RETIRE_AGE);
    // first projected month compounds one month of return + one aporte on invested only
    const rm = Math.pow(1.05, 1 / 12) - 1;
    const expectedFirst = Math.round(200_000_000 * (1 + rm) + 1_000_000 + 100_000_000);
    expect(r.points[0]!.proj_nw).toBe(expectedFirst);
    expect(String(r.points[0]!.as_of_date)).toBe("2026-08-31");
    // nominal exceeds real from the first month
    expect(Number(r.points[0]!.proj_nw_nominal)).toBeGreaterThan(Number(r.points[0]!.proj_nw));
    // balance at retire is strictly above base (positive return + aportes)
    expect(r.balance_at_retire).toBeGreaterThan(300_000_000);
  });

  it("zero return + zero aporte keeps the real trajectory flat", () => {
    const r = runProjectionEngine({
      ...BASE,
      real_return_pct: 0,
      retire_return_pct: 0,
      monthly_aporte: 0,
      swr_pct: 0,
      monthly_income: 0,
    });
    expect(r.balance_at_retire).toBe(300_000_000);
    const accPoints = r.points.filter((p) => p.proj_nw != null);
    expect(accPoints[accPoints.length - 1]!.proj_nw).toBe(300_000_000);
    // swr 0% → fixed income defaults to it (0) → nothing withdraws, no depletion
    expect(r.swr_depletion_age).toBeNull();
    expect(r.fixed_income_depletion_age).toBeNull();
  });

  it("SWR at 4% with equal retire return sustains past end_age; aggressive fixed income depletes", () => {
    const sustained = runProjectionEngine({ ...BASE, retire_return_pct: 4, swr_pct: 4 });
    expect(sustained.swr_depletion_age).toBeNull();

    const balanceAtRetire = runProjectionEngine(BASE).balance_at_retire;
    const aggressive = runProjectionEngine({
      ...BASE,
      retire_return_pct: 0,
      monthly_income: (balanceAtRetire * 0.12) / 12, // 12%/yr of the retirement balance, zero return
    });
    expect(aggressive.fixed_income_depletion_age).not.toBeNull();
    expect(aggressive.fixed_income_depletion_age!).toBeGreaterThan(PROJECTION_RETIRE_AGE);
    expect(aggressive.fixed_income_depletion_age!).toBeLessThanOrEqual(BASE.end_age);
    // depleted line reaches exactly 0 and stays there (no negative balances)
    const zeros = aggressive.points.filter((p) => p.proj_fixed_income === 0);
    expect(zeros.length).toBeGreaterThan(0);
    expect(aggressive.points.every((p) => p.proj_fixed_income == null || Number(p.proj_fixed_income) >= 0)).toBe(true);
  });

  it("% of balance never depletes and decays when withdrawal rate exceeds return", () => {
    const r = runProjectionEngine({ ...BASE, retire_return_pct: 0, pct_balance_pct: 10 });
    const pctPoints = r.points.filter((p) => p.proj_pct_balance != null).map((p) => Number(p.proj_pct_balance));
    const last = pctPoints[pctPoints.length - 1]!;
    expect(last).toBeGreaterThan(0);
    expect(last).toBeLessThan(r.balance_at_retire);
  });

  it("strategy lines only exist from the retirement month on; runs monthly through end_age", () => {
    const r = runProjectionEngine(BASE);
    const firstSwr = r.points.find((p) => p.proj_swr != null);
    expect(String(firstSwr!.as_of_date).slice(0, 7)).toBe("2057-01");
    const lastPoint = r.points[r.points.length - 1]!;
    expect(String(lastPoint.as_of_date).slice(0, 7)).toBe("2087-01");
  });

  it("emits the invested projection line; drawdown base switches between invested and total", () => {
    const total = runProjectionEngine(BASE);
    // proj_invested = proj_nw − flat "other" (100M) at every accumulation point
    const acc = total.points.filter((p) => p.proj_nw != null);
    expect(acc.every((p) => Number(p.proj_nw) - Number(p.proj_invested) === 100_000_000)).toBe(true);
    expect(total.balance_at_retire).toBe(total.total_at_retire);

    const investedBase = runProjectionEngine({ ...BASE, drawdown_base: "invested" });
    expect(investedBase.balance_at_retire).toBe(investedBase.invested_at_retire);
    expect(investedBase.invested_at_retire).toBe(investedBase.total_at_retire - 100_000_000);
    // smaller base → smaller SWR income
    expect(investedBase.swr_monthly_income).toBeLessThan(total.swr_monthly_income);
  });

  it("throws when the start month is past retirement", () => {
    expect(() => runProjectionEngine({ ...BASE, start_month: "2058-01" })).toThrow(/past the retirement/);
  });
});
