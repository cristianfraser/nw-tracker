import { describe, expect, it } from "vitest";
import {
  WEALTH_BENCHMARK_COUNTRIES,
  buildWealthPercentilePayload,
  type WealthPercentileCell,
} from "./wealthPercentile.js";
import { portfolioStartYmd } from "./portfolioStart.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { maxWealthDistributionYear } from "./wealthDistributions.js";

function expectCellShape(cell: WealthPercentileCell, fx: number) {
  expect(cell.p50_usd).toBeGreaterThan(0);
  expect(cell.p50_usd).toBeLessThan(cell.p90_usd);
  expect(cell.p90_usd).toBeLessThan(cell.p99_usd);
  expect(cell.p50_clp).toBe(Math.round(cell.p50_usd * fx));
  if (cell.below_support) {
    expect(cell.percentile).toBeNull();
  } else {
    expect(cell.percentile).toBeGreaterThan(0);
    expect(cell.percentile).toBeLessThan(100);
  }
}

describe("buildWealthPercentilePayload (synthetic DB)", () => {
  it("one row per year from portfolio start to today, with all country-mode cells", () => {
    const payload = buildWealthPercentilePayload();

    const startYear = Number(portfolioStartYmd().slice(0, 4));
    const currentYear = Number(chileCalendarTodayYmd().slice(0, 4));
    expect(payload.rows.map((r) => r.year)).toEqual(
      Array.from({ length: currentYear - startYear + 1 }, (_, i) => startYear + i)
    );

    for (const row of payload.rows) {
      expect(row.as_of_date.startsWith(String(row.year))).toBe(true);
      expect(row.distribution_year).toBe(Math.min(row.year, maxWealthDistributionYear()));
      expect(row.fx_clp_per_usd).toBeGreaterThan(0);
      expect(row.fx_date <= row.as_of_date).toBe(true);
      // Financial NW excludes the real-estate bucket, so it never exceeds the total.
      expect(row.fin_net_worth_clp).toBeLessThanOrEqual(row.net_worth_clp);
      expectCellShape(row.cl_total, row.fx_clp_per_usd);
      expectCellShape(row.cl_financial, row.fx_clp_per_usd);
      for (const country of WEALTH_BENCHMARK_COUNTRIES) {
        expectCellShape(row.benchmarks[country], row.fx_clp_per_usd);
      }
      if (!row.cl_total.below_support) {
        expect(row.net_worth_usd).toBe(Math.round(row.net_worth_clp / row.fx_clp_per_usd));
      }
    }

    // The current-year row values today, not December 31.
    const last = payload.rows[payload.rows.length - 1]!;
    expect(last.as_of_date).toBe(chileCalendarTodayYmd());
  });

  it("financial mode distribution is poorer: cl_financial thresholds sit below cl_total", () => {
    const payload = buildWealthPercentilePayload();
    for (const row of payload.rows) {
      expect(row.cl_financial.p50_usd).toBeLessThan(row.cl_total.p50_usd);
      expect(row.cl_financial.p90_usd).toBeLessThan(row.cl_total.p90_usd);
    }
  });

  it("years past the newest databook row reuse the latest distribution and share flags", () => {
    const payload = buildWealthPercentilePayload();
    const maxYear = maxWealthDistributionYear();
    for (const row of payload.rows) {
      if (row.year > maxYear) expect(row.distribution_year).toBe(maxYear);
      expect(row.interpolated).toBe(row.distribution_year === 2023 || row.distribution_year === 2024);
    }
  });
});
