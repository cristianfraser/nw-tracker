import { describe, expect, it } from "vitest";
import {
  WEALTH_BENCHMARK_COUNTRIES,
  buildWealthPercentilePayload,
  wealthBenchmarkOrderOf,
  wealthTodayOf,
  type WealthPercentileCell,
  type WealthPercentileYearRow,
} from "./wealthPercentile.js";
import { portfolioStartYmd } from "./portfolioStart.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { maxWealthDistributionYear } from "./wealthDistributions.js";
import { db } from "./db.js";

function expectCellShape(cell: WealthPercentileCell, fx: number) {
  expect(cell.p50_usd).toBeGreaterThan(0);
  expect(cell.p50_usd).toBeLessThan(cell.p90_usd);
  expect(cell.p90_usd).toBeLessThan(cell.p99_usd);
  expect(cell.p50).toBe(Math.round(cell.p50_usd * fx));
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
    const usd = buildWealthPercentilePayload("usd");
    expect(payload.unit).toBe("clp");
    expect(usd.unit).toBe("usd");

    const startYear = Number(portfolioStartYmd().slice(0, 4));
    const currentYear = Number(chileCalendarTodayYmd().slice(0, 4));
    const years = Array.from({ length: currentYear - startYear + 1 }, (_, i) => startYear + i);
    // The list is newest first, the chart oldest first.
    expect(payload.rows.map((r) => r.year)).toEqual([...years].reverse());
    expect(payload.chart.map((p) => p.year)).toEqual(years);

    for (const row of payload.rows) {
      expect(row.as_of_date.startsWith(String(row.year))).toBe(true);
      expect(row.distribution_year).toBe(Math.min(row.year, maxWealthDistributionYear()));
      expect(row.fx_clp_per_usd).toBeGreaterThan(0);
      expect(row.fx_date <= row.as_of_date).toBe(true);
      // Financial NW excludes the real-estate bucket, so it never exceeds the total.
      expect(row.fin_net_worth).toBeLessThanOrEqual(row.net_worth);
      expect(row.clp_per_unit).toBe(1);
      expectCellShape(row.cl_total, row.fx_clp_per_usd);
      expectCellShape(row.cl_financial, row.fx_clp_per_usd);
      for (const country of WEALTH_BENCHMARK_COUNTRIES) {
        expectCellShape(row.benchmarks[country], row.fx_clp_per_usd);
      }
    }
    for (const [i, row] of usd.rows.entries()) {
      const clpRow = payload.rows[i]!;
      // USD is the observado frame: net worth at it, thresholds as printed, same percentiles.
      expect(row.clp_per_unit).toBe(row.fx_clp_per_usd);
      expect(row.net_worth).toBe(Math.round(clpRow.net_worth / row.fx_clp_per_usd));
      expect(row.cl_total.p50).toBe(row.cl_total.p50_usd);
      expect(row.cl_total.percentile).toBe(clpRow.cl_total.percentile);
    }

    // The current-year row values today, not December 31.
    const last = payload.rows[0]!;
    expect(last.as_of_date).toBe(chileCalendarTodayYmd());
  });

  it("serves the chart oldest first with each line's percentile, and the newest row's headline and country order", () => {
    const payload = buildWealthPercentilePayload();
    const latest = payload.rows[0]!;
    expect(payload.today).toEqual(wealthTodayOf(latest));
    expect(payload.benchmark_order).toEqual(wealthBenchmarkOrderOf(latest));
    for (const point of payload.chart) {
      const row = payload.rows.find((r) => r.year === point.year)!;
      expect(point.cl_total).toBe(row.cl_total.percentile);
      expect(point.cl_financial).toBe(row.cl_financial.percentile);
      for (const country of WEALTH_BENCHMARK_COUNTRIES) {
        expect(point.benchmarks[country]).toBe(row.benchmarks[country].percentile);
      }
    }
  });

  it("names what stands behind each year's distribution", () => {
    const payload = buildWealthPercentilePayload();
    // Printed databook years carry nothing; 2023/2024 bridge the two editions; Chile's 2025 is rebuilt.
    const behind = (distributionYear: number): string[] =>
      distributionYear === 2023 || distributionYear === 2024
        ? ["interpolated"]
        : distributionYear === 2025
          ? ["reconstructed"]
          : [];
    expect(payload.rows.length).toBeGreaterThan(0);
    for (const row of payload.rows) {
      // A year past the newest databook says so first, then what that databook's row carries.
      expect(row.notes).toEqual([
        ...(row.year > row.distribution_year ? ["latest_distribution"] : []),
        ...behind(row.distribution_year),
      ]);
    }
    expect(payload.rows[0]!.notes[0]).toBe("latest_distribution");
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

  it("expresses net worth and thresholds in EUR at the year-end EUR/CLP; percentiles stay USD-framed", () => {
    // One early EUR/CLP row carries forward to every year-end (on-or-before reads).
    db.prepare(`INSERT OR IGNORE INTO eur_daily (date, clp_per_eur) VALUES ('2000-01-03', 1000)`).run();
    try {
      const clp = buildWealthPercentilePayload("clp");
      const eur = buildWealthPercentilePayload("eur");
      expect(eur.unit).toBe("eur");
      for (const [i, row] of eur.rows.entries()) {
        const clpRow = clp.rows[i]!;
        expect(row.clp_per_unit).toBeGreaterThan(0);
        expect(row.net_worth).toBe(Math.round(clpRow.net_worth / row.clp_per_unit));
        expect(row.cl_total.p90).toBe(Math.round((row.cl_total.p90_usd * row.fx_clp_per_usd) / row.clp_per_unit));
        expect(row.cl_total.percentile).toBe(clpRow.cl_total.percentile);
      }
    } finally {
      db.prepare(`DELETE FROM eur_daily WHERE date = '2000-01-03'`).run();
    }
  });
});

describe("wealth percentile headline and country order", () => {
  const cell = (percentile: number | null): WealthPercentileCell => ({
    percentile,
    below_support: percentile == null,
    p50_usd: 1,
    p90_usd: 2,
    p99_usd: 3,
    p50: 1,
    p90: 2,
    p99: 3,
  });
  const rowWith = (
    total: number | null,
    financial: number | null,
    benchmarks: Partial<Record<(typeof WEALTH_BENCHMARK_COUNTRIES)[number], number | null>>
  ): WealthPercentileYearRow => ({
    year: 2030,
    as_of_date: "2030-06-01",
    distribution_year: 2029,
    fx_clp_per_usd: 900,
    fx_date: "2030-06-01",
    interpolated: false,
    reconstructed: false,
    notes: ["latest_distribution"],
    clp_per_unit: 1,
    net_worth: 1000,
    fin_net_worth: 400,
    cl_total: cell(total),
    cl_financial: cell(financial),
    benchmarks: Object.fromEntries(
      WEALTH_BENCHMARK_COUNTRIES.map((c) => [c, cell(c in benchmarks ? benchmarks[c]! : 10)])
    ) as WealthPercentileYearRow["benchmarks"],
  });

  it("rounds the standing to the decimal shown and its complement adds up to 100", () => {
    expect(wealthTodayOf(rowWith(96.749, 97.85, {}))).toEqual({
      year: 2030,
      as_of_date: "2030-06-01",
      distribution_year: 2029,
      net_worth: 1000,
      fin_net_worth: 400,
      percentile: 96.7,
      top_percent: 3.3,
      financial_percentile: 97.9,
    });
  });

  it("has no standing below the distribution's support", () => {
    const today = wealthTodayOf(rowWith(null, null, {}));
    expect(today.percentile).toBeNull();
    expect(today.top_percent).toBeNull();
    expect(today.financial_percentile).toBeNull();
  });

  it("orders countries by standing, ties in the list's order, below support last", () => {
    const order = wealthBenchmarkOrderOf(rowWith(50, 50, { MX: 95, DE: 80, US: null, AU: 80 }));
    expect(order.slice(0, 3)).toEqual(["MX", "AU", "DE"]);
    expect(order[order.length - 1]).toBe("US");
    expect(order).toHaveLength(WEALTH_BENCHMARK_COUNTRIES.length);
  });
});
