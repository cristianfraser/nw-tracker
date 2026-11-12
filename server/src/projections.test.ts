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
  liquidate_other_pct: 100,
  monthly_rent: 0,
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

  it("emits the invested projection line; liquidation % scales the drawdown pot", () => {
    const full = runProjectionEngine(BASE); // 100% of "other" liquidated
    // proj_invested = proj_nw − flat "other" (100M) at every accumulation point
    const acc = full.points.filter((p) => p.proj_nw != null);
    expect(acc.every((p) => Number(p.proj_nw) - Number(p.proj_invested) === 100_000_000)).toBe(true);
    expect(full.balance_at_retire).toBe(full.total_at_retire);

    const none = runProjectionEngine({ ...BASE, liquidate_other_pct: 0 });
    expect(none.balance_at_retire).toBe(none.invested_at_retire);
    expect(none.invested_at_retire).toBe(none.total_at_retire - 100_000_000);
    expect(none.swr_monthly_income).toBeLessThan(full.swr_monthly_income);

    const half = runProjectionEngine({ ...BASE, liquidate_other_pct: 50 });
    expect(half.balance_at_retire).toBe(Math.round(none.invested_at_retire + 50_000_000));
  });

  it("rent adds to strategy incomes and reduces the fixed-income pot withdrawal", () => {
    const noRent = runProjectionEngine({ ...BASE, retire_return_pct: 0, monthly_income: 3_000_000 });
    const withRent = runProjectionEngine({
      ...BASE,
      retire_return_pct: 0,
      monthly_income: 3_000_000, // TOTAL target: pot only funds 3M − 1M rent
      monthly_rent: 1_000_000,
    });
    // SWR income reported as pot withdrawal + rent
    expect(withRent.swr_monthly_income).toBe(noRent.swr_monthly_income + 1_000_000);
    // fixed target echoed as total; the pot depletes later (or not at all) with rent covering part
    expect(withRent.fixed_monthly_income).toBe(3_000_000);
    if (noRent.fixed_income_depletion_age != null && withRent.fixed_income_depletion_age != null) {
      expect(withRent.fixed_income_depletion_age).toBeGreaterThan(noRent.fixed_income_depletion_age);
    }
    // rent covering the whole target → pot never withdraws → no depletion
    const covered = runProjectionEngine({
      ...BASE,
      retire_return_pct: 0,
      monthly_income: 900_000,
      monthly_rent: 1_000_000,
    });
    expect(covered.fixed_income_depletion_age).toBeNull();
  });

  it("throws when the start month is past retirement", () => {
    expect(() => runProjectionEngine({ ...BASE, start_month: "2058-01" })).toThrow(/past the retirement/);
  });
});

describe("buildProjectionsPayload in any core unit", () => {
  it("takes money inputs in any core currency and each unit's own inflation, at today's stored rate", async () => {
    const {
      buildProjectionsPayload,
      inflationPctForUnit,
      projectionParamsFromQuery,
      ProjectionParamError,
      PROJECTION_INFLATION_DEFAULT_PCT,
    } = await import("./projections.js");
    const { convertCurrency } = await import("./rates.js");
    const { chileCalendarTodayYmd, chileCalendarAddDays } = await import("./chileDate.js");
    const today = chileCalendarTodayYmd();
    const storedNow = new Date(`${chileCalendarAddDays(today, 1)}T16:00:00Z`);
    const stored = (amount: number, from: string, to: string) =>
      convertCurrency(amount, from, to, today, { side: "mid", now: storedNow })!;

    // Typed in pesos (what the old `_clp` inputs carried), shown in any unit.
    const query = { monthly_aporte: "1000000", monthly_aporte_currency: "clp", monthly_rent: "500000", monthly_rent_currency: "clp" };
    const clpParams = projectionParamsFromQuery(query, "clp");
    const usdParams = projectionParamsFromQuery(query, "usd");
    expect(clpParams.monthly_rent).toBe(500_000);
    expect(usdParams.monthly_rent).toBeCloseTo(stored(500_000, "clp", "usd"), 9);
    expect(inflationPctForUnit("clp", clpParams)).toBe(3.5);
    expect(inflationPctForUnit("usd", clpParams)).toBe(2.5);
    expect(inflationPctForUnit("eur", clpParams)).toBe(PROJECTION_INFLATION_DEFAULT_PCT.eur);
    expect(projectionParamsFromQuery({ inflation_eur_pct: "1.7" }, "eur").inflation_pct.eur).toBe(1.7);
    // Typed in the unit itself: no conversion.
    expect(projectionParamsFromQuery({ monthly_income: "1234.5" }, "usd").monthly_income).toBe(1234.5);
    expect(() => projectionParamsFromQuery({ monthly_rent: "10", monthly_rent_currency: "xyz" }, "clp")).toThrow(
      ProjectionParamError
    );
    expect(() => projectionParamsFromQuery({ inflation_clp_pct: "99" }, "clp")).toThrow(ProjectionParamError);

    const clp = buildProjectionsPayload("clp", clpParams);
    const usd = buildProjectionsPayload("usd", usdParams);
    const fx = stored(1, "usd", "clp");
    expect(clp.chart.points[0]!.usd_250k).toBe(Math.round(250_000 * fx));
    expect(usd.chart.points[0]!.usd_250k).toBe(250_000);
    expect(usd.summary.monthly_rent).toBe(Math.round(stored(500_000, "clp", "usd")));
    expect(usd.params.monthly_rent).toBe(Math.round(stored(500_000, "clp", "usd") * 100) / 100);
    expect(usd.inflation_default_pct).toEqual({ clp: 3.5, eur: 2.0, usd: 2.5 });

    const { db } = await import("./db.js");
    // One early row of each EUR pair carries forward over the whole history (on-or-before reads).
    db.prepare(
      `INSERT OR IGNORE INTO fx_rates (base, quote, date, mid, source) VALUES ('eur', 'usd', '2000-01-03', 1.08, 'vitest-projections')`
    ).run();
    db.prepare(`INSERT OR IGNORE INTO eur_daily (date, clp_per_eur) VALUES ('2000-01-03', 1000)`).run();
    try {
      const eurParams = projectionParamsFromQuery(query, "eur");
      const eur = buildProjectionsPayload("eur", eurParams);
      expect(eur.unit).toBe("eur");
      expect(eur.chart.points[0]!.usd_250k).toBe(Math.round(stored(250_000, "usd", "eur")));
      expect(eur.summary.monthly_rent).toBe(Math.round(stored(500_000, "clp", "eur")));
    } finally {
      db.prepare(`DELETE FROM fx_rates WHERE source = 'vitest-projections'`).run();
      db.prepare(`DELETE FROM eur_daily WHERE date = '2000-01-03'`).run();
    }
  });
});
