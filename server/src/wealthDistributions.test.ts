import { describe, expect, it } from "vitest";
import { phi, phiInv } from "./normalDist.js";
import {
  WEALTH_COUNTRIES,
  impliedGiniFromMeanMedian,
  lognormalParamsFor,
  lognormalPercentile,
  lognormalThresholdUsd,
  maxWealthDistributionYear,
  minWealthDistributionYear,
  wealthDistributionRecordFor,
} from "./wealthDistributions.js";

describe("wealthDistributions seed", () => {
  it("keeps the verified end-2022 anchors as-is (GWD 2023 tables 2-2 + 3-1)", () => {
    const anchors: Record<string, { mean: number; median: number; gini: number }> = {
      CL: { mean: 54_082, median: 19_544, gini: 0.788 },
      US: { mean: 551_347, median: 107_739, gini: 0.83 },
      ES: { mean: 224_209, median: 107_507, gini: 0.683 },
      CH: { mean: 685_226, median: 167_353, gini: 0.772 },
      UK: { mean: 302_783, median: 151_825, gini: 0.702 },
      AU: { mean: 496_819, median: 247_453, gini: 0.663 },
      DE: { mean: 256_179, median: 66_735, gini: 0.772 },
      JP: { mean: 216_078, median: 103_681, gini: 0.65 },
      MX: { mean: 55_274, median: 18_920, gini: 0.793 },
      BR: { mean: 29_452, median: 5_702, gini: 0.884 },
      CN: { mean: 75_731, median: 27_273, gini: 0.709 },
    };
    for (const country of WEALTH_COUNTRIES) {
      const rec = wealthDistributionRecordFor(country, 2022);
      expect(rec.mean_usd).toBe(anchors[country]!.mean);
      expect(rec.median_usd).toBe(anchors[country]!.median);
      expect(rec.gini).toBe(anchors[country]!.gini);
    }
  });

  it("covers every year 2016..2025 for every country, with 2023/2024 flagged interpolated", () => {
    expect(minWealthDistributionYear()).toBe(2016);
    expect(maxWealthDistributionYear()).toBe(2025);
    for (const country of WEALTH_COUNTRIES) {
      for (let year = 2016; year <= 2025; year++) {
        const rec = wealthDistributionRecordFor(country, year);
        expect(rec.mean_usd).toBeGreaterThan(0);
        expect(rec.median_usd).toBeGreaterThan(0);
        expect(rec.mean_usd).toBeGreaterThan(rec.median_usd!);
        expect(rec.interpolated ?? false).toBe(year === 2023 || year === 2024);
      }
    }
  });

  it("CL rows all carry a positive net financial mean (financial mode)", () => {
    for (let year = 2016; year <= 2025; year++) {
      const rec = wealthDistributionRecordFor("CL", year);
      expect(rec.mean_fin_usd).toBeGreaterThan(0);
      expect(rec.mean_fin_usd!).toBeLessThan(rec.mean_usd);
    }
    // Spot values straight from Table 2-2 (financial − debt per adult).
    expect(wealthDistributionRecordFor("CL", 2016).mean_fin_usd).toBe(32_750 - 8_543);
    expect(wealthDistributionRecordFor("CL", 2022).mean_fin_usd).toBe(35_512 - 10_352);
    // 2025 reconstruction: 62,400 × (0.58 − 0.16) / (1 − 0.16).
    expect(wealthDistributionRecordFor("CL", 2025).mean_fin_usd).toBe(31_200);
  });

  it("throws for unknown country-years", () => {
    expect(() => wealthDistributionRecordFor("CL", 2015)).toThrow();
    expect(() => wealthDistributionRecordFor("US", 2026)).toThrow();
  });
});

describe("lognormal calibration", () => {
  it("preferred path: mu = ln(median), sigma = sqrt(2·ln(mean/median))", () => {
    const { mu, sigma } = lognormalParamsFor("CL", 2022, "total");
    expect(mu).toBeCloseTo(Math.log(19_544), 10);
    expect(sigma).toBeCloseTo(Math.sqrt(2 * Math.log(54_082 / 19_544)), 10);
    // The lognormal median IS the published median: p50 threshold round-trips exactly.
    expect(lognormalThresholdUsd({ mu, sigma }, 0.5)).toBeCloseTo(19_544, 6);
    // And the implied mean e^(mu + sigma²/2) reproduces the published mean.
    expect(Math.exp(mu + (sigma * sigma) / 2)).toBeCloseTo(54_082, 4);
  });

  it("threshold and percentile are inverses", () => {
    const params = lognormalParamsFor("US", 2025, "total");
    for (const q of [0.1, 0.5, 0.9, 0.99]) {
      const w = lognormalThresholdUsd(params, q);
      expect(lognormalPercentile(params, w)).toBeCloseTo(q, 7);
    }
  });

  it("percentile throws for W ≤ 0 (callers gate below_support)", () => {
    const params = lognormalParamsFor("CL", 2025, "total");
    expect(() => lognormalPercentile(params, 0)).toThrow();
    expect(() => lognormalPercentile(params, -1_000)).toThrow();
  });

  it("financial mode is only calibrated where mean_fin_usd exists (CL)", () => {
    const params = lognormalParamsFor("CL", 2025, "financial");
    expect(params.sigma).toBeGreaterThan(lognormalParamsFor("CL", 2025, "total").sigma);
    expect(() => lognormalParamsFor("US", 2025, "financial")).toThrow(/mean_fin_usd/);
  });

  it("financial-mode mean is preserved: e^(mu + sigma²/2) = mean_fin_usd", () => {
    for (let year = 2016; year <= 2025; year++) {
      const rec = wealthDistributionRecordFor("CL", year);
      const { mu, sigma } = lognormalParamsFor("CL", year, "financial");
      expect(Math.exp(mu + (sigma * sigma) / 2)).toBeCloseTo(rec.mean_fin_usd!, 4);
    }
  });

  it("implied Gini matches the closed form 2·phi(sigma/√2) − 1", () => {
    const sigma = Math.sqrt(2 * Math.log(54_082 / 19_544));
    expect(impliedGiniFromMeanMedian(54_082, 19_544)).toBeCloseTo(2 * phi(sigma / Math.SQRT2) - 1, 10);
  });
});

describe("model validation: Chile end-2025 millionaire count", () => {
  it("Gini-fallback calibration (mean 62,400, Gini 0.71, 14.85M adults) predicts ~68,900 millionaires (UBS: ~69,100)", () => {
    // Exercises the fallback formulas exactly as specified: sigma = √2·phiInv((G+1)/2),
    // mu = ln(mean) − sigma²/2.
    const sigma = Math.SQRT2 * phiInv((0.71 + 1) / 2);
    const mu = Math.log(62_400) - (sigma * sigma) / 2;
    const adults = 14_850_000;
    const millionaires = adults * (1 - phi((Math.log(1_000_000) - mu) / sigma));
    expect(Math.abs(millionaires - 68_900) / 68_900).toBeLessThan(0.03);
  });

  it("the seeded CL 2025 row (preferred mean/median path) lands in the same range", () => {
    const rec = wealthDistributionRecordFor("CL", 2025);
    const params = lognormalParamsFor("CL", 2025, "total");
    const adults = rec.adults_thousands! * 1_000;
    const millionaires = adults * (1 - lognormalPercentile(params, 1_000_000));
    expect(millionaires).toBeGreaterThan(60_000);
    expect(millionaires).toBeLessThan(80_000);
  });

  it("reconstructed MX/BR/CN 2025 rows reproduce the GWR 2026 Millionaire Index counts", () => {
    // These rows were derived FROM the counts (sigma from Gini, mu from millionaire share),
    // so the seeded rounded mean/median must round-trip back to the published counts.
    const published: Record<string, number> = { MX: 333_000, BR: 386_000, CN: 5_305_000 };
    for (const country of ["MX", "BR", "CN"] as const) {
      const rec = wealthDistributionRecordFor(country, 2025);
      expect(rec.reconstructed).toBe(true);
      const params = lognormalParamsFor(country, 2025, "total");
      const adults = rec.adults_thousands! * 1_000;
      const millionaires = adults * (1 - lognormalPercentile(params, 1_000_000));
      expect(Math.abs(millionaires - published[country]!) / published[country]!).toBeLessThan(0.02);
    }
  });
});
