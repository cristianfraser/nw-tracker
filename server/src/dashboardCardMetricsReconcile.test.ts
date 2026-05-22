import { describe, expect, it } from "vitest";
import { reconcileDashboardCardMetrics } from "./dashboardCardMetricsReconcile.js";

describe("reconcileDashboardCardMetrics", () => {
  it("sets lifetime delta to current minus deposits (CLP)", () => {
    const out = reconcileDashboardCardMetrics({
      deposits_clp: 45_138_555,
      current_value_clp: 93_635_717,
      delta_total_clp: 50_465_197,
    });
    expect(out.delta_total_clp).toBe(48_497_162);
  });

  it("sets lifetime delta to current minus deposits (USD)", () => {
    const out = reconcileDashboardCardMetrics(
      {
        deposits_clp: 0,
        deposits_usd: 10_000,
        current_value_clp: 0,
        current_value_usd: 12_500,
        delta_total_usd: 999,
      },
      { includeUsd: true }
    );
    expect(out.delta_total_usd).toBe(2_500);
  });

  it("sets period delta to current minus prior minus period deposits", () => {
    const out = reconcileDashboardCardMetrics({
      deposits_clp: 26_409_638,
      current_value_clp: 27_652_936,
      prior_month_close_clp: 30_291_566,
      deposits_month_clp: -2_700_000,
      delta_month_clp: 999,
    });
    expect(out.delta_month_clp).toBe(61_370);
  });

  it("skips period reconcile when prior close is missing", () => {
    const out = reconcileDashboardCardMetrics({
      deposits_clp: 1_000,
      current_value_clp: 1_500,
      deposits_month_clp: 100,
      delta_month_clp: 50,
    });
    expect(out.delta_month_clp).toBeUndefined();
    expect(out.delta_total_clp).toBe(500);
  });

  it("reconciles year period when prior year close exists", () => {
    const out = reconcileDashboardCardMetrics({
      deposits_clp: 1_000_000,
      current_value_clp: 1_200_000,
      prior_year_close_clp: 1_000_000,
      deposits_year_clp: 50_000,
      delta_year_clp: 0,
    });
    expect(out.delta_year_clp).toBe(150_000);
  });
});
