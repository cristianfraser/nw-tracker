/**
 * Country-year wealth distribution seed + lognormal calibration (/wealth-percentile).
 *
 * Static public reference data (UBS/Credit Suisse Global Wealth Databook figures), kept as
 * a committed TS module — not a SQL table — like other static parameter sets. Each
 * country-year models the wealth-per-adult distribution as a lognormal:
 *
 * - Preferred (mean + median published): `mu = ln(median)`, `sigma = sqrt(2·ln(mean/median))`.
 * - Fallback (mean + Gini only): `sigma = sqrt(2)·phiInv((gini+1)/2)`, `mu = ln(mean) − sigma²/2`.
 *
 * METHODOLOGY BREAK: UBS revised its estimation model across the 2024–2026 reports, so
 * 2025 medians are NOT comparable with ≤2022 ones (e.g. the US median falls from 107,739
 * to 68,998 because of the model change, not impoverishment). 2023/2024 rows bridge the
 * break by geometric interpolation and are flagged `interpolated: true`.
 *
 * The lognormal underestimates the extreme tail (>p99.5); p99 thresholds are the reliable
 * ceiling. Percentiles are over each country's adult (20+) population, household wealth
 * assigned to adults (UBS convention).
 */
import { phi, phiInv } from "./normalDist.js";

export type WealthCountry = "CL" | "US" | "ES" | "CH" | "UK";
export const WEALTH_COUNTRIES: readonly WealthCountry[] = ["CL", "US", "ES", "CH", "UK"];

export function isWealthCountry(v: string): v is WealthCountry {
  return (WEALTH_COUNTRIES as readonly string[]).includes(v);
}

export type WealthMode = "total" | "financial";

export type WealthDistributionRecord = {
  country: WealthCountry;
  year: number;
  /** Net wealth per adult, USD (UBS "wealth per adult" mean). */
  mean_usd: number;
  /** Median wealth per adult, USD. */
  median_usd?: number;
  /** Published wealth Gini (GWD 2023 Table 3-1 / GWR 2026); provenance + fallback only. */
  gini?: number;
  /** Adult (20+) population, thousands. */
  adults_thousands?: number;
  /**
   * Net financial wealth per adult, USD (financial assets − debt per adult; both include
   * mortgage debt — UBS publishes one debt figure). CL only for now (financial mode).
   */
  mean_fin_usd?: number;
  /** Geometric interpolation across the 2022→2025 methodology break. */
  interpolated?: boolean;
  /** Own reconstruction, not an official UBS figure (CL 2025). */
  reconstructed?: boolean;
  source: string;
};

const GWD2023 = (year: number) => `UBS Global Wealth Databook 2023, Table 2-2 (end-${year})`;
const GWD2023_WITH_GINI = `UBS Global Wealth Databook 2023, Table 2-2 (end-2022) + Table 3-1 Gini`;
const GWR2026 = "UBS Global Wealth Report 2026 (end-2025)";
const CL_2025_SOURCE =
  "Own reconstruction end-2025 (BCCh + FX + UBS Gini), validated against the UBS GWR 2026 millionaire count (~69,100); mean_fin from est. fin/debt shares of gross (0.58/0.16)";

/** CL `mean_fin_usd` = Table 2-2 "financial wealth per adult" − "debt per adult". */
const BASE_RECORDS: readonly WealthDistributionRecord[] = [
  // Chile
  { country: "CL", year: 2016, mean_usd: 52_042, median_usd: 16_025, adults_thousands: 13_335, mean_fin_usd: 32_750 - 8_543, source: GWD2023(2016) },
  { country: "CL", year: 2017, mean_usd: 58_701, median_usd: 19_000, adults_thousands: 13_611, mean_fin_usd: 37_344 - 9_956, source: GWD2023(2017) },
  { country: "CL", year: 2018, mean_usd: 54_342, median_usd: 17_071, adults_thousands: 13_872, mean_fin_usd: 34_782 - 9_529, source: GWD2023(2018) },
  { country: "CL", year: 2019, mean_usd: 54_665, median_usd: 18_563, adults_thousands: 14_095, mean_fin_usd: 35_748 - 9_504, source: GWD2023(2019) },
  { country: "CL", year: 2020, mean_usd: 57_984, median_usd: 19_564, adults_thousands: 14_259, mean_fin_usd: 37_638 - 9_770, source: GWD2023(2020) },
  { country: "CL", year: 2021, mean_usd: 50_964, median_usd: 17_554, adults_thousands: 14_358, mean_fin_usd: 34_248 - 9_121, source: GWD2023(2021) },
  { country: "CL", year: 2022, mean_usd: 54_082, median_usd: 19_544, gini: 0.788, adults_thousands: 14_409, mean_fin_usd: 35_512 - 10_352, source: GWD2023_WITH_GINI },
  // mean_fin_usd = 62,400 × (fin_share − debt_share)/(1 − debt_share) = ×(0.58 − 0.16)/0.84
  { country: "CL", year: 2025, mean_usd: 62_400, median_usd: 20_400, gini: 0.71, adults_thousands: 14_850, mean_fin_usd: 31_200, reconstructed: true, source: CL_2025_SOURCE },

  // United States
  { country: "US", year: 2016, mean_usd: 385_707, median_usd: 57_398, adults_thousands: 241_360, source: GWD2023(2016) },
  { country: "US", year: 2017, mean_usd: 418_033, median_usd: 62_244, adults_thousands: 243_562, source: GWD2023(2017) },
  { country: "US", year: 2018, mean_usd: 416_660, median_usd: 61_940, adults_thousands: 245_705, source: GWD2023(2018) },
  { country: "US", year: 2019, mean_usd: 463_549, median_usd: 69_349, adults_thousands: 247_862, source: GWD2023(2019) },
  { country: "US", year: 2020, mean_usd: 505_421, median_usd: 79_437, adults_thousands: 249_892, source: GWD2023(2020) },
  { country: "US", year: 2021, mean_usd: 579_051, median_usd: 93_280, adults_thousands: 251_779, source: GWD2023(2021) },
  { country: "US", year: 2022, mean_usd: 551_347, median_usd: 107_739, gini: 0.83, adults_thousands: 253_681, source: GWD2023_WITH_GINI },
  { country: "US", year: 2025, mean_usd: 696_277, median_usd: 68_998, gini: 0.77, source: GWR2026 },

  // Spain
  { country: "ES", year: 2016, mean_usd: 165_872, median_usd: 75_689, adults_thousands: 37_554, source: GWD2023(2016) },
  { country: "ES", year: 2017, mean_usd: 200_862, median_usd: 93_329, adults_thousands: 37_611, source: GWD2023(2017) },
  { country: "ES", year: 2018, mean_usd: 201_025, median_usd: 93_269, adults_thousands: 37_678, source: GWD2023(2018) },
  { country: "ES", year: 2019, mean_usd: 210_397, median_usd: 97_785, adults_thousands: 37_749, source: GWD2023(2019) },
  { country: "ES", year: 2020, mean_usd: 231_725, median_usd: 108_232, adults_thousands: 37_798, source: GWD2023(2020) },
  { country: "ES", year: 2021, mean_usd: 229_692, median_usd: 107_342, adults_thousands: 37_825, source: GWD2023(2021) },
  { country: "ES", year: 2022, mean_usd: 224_209, median_usd: 107_507, gini: 0.683, adults_thousands: 37_855, source: GWD2023_WITH_GINI },
  { country: "ES", year: 2025, mean_usd: 306_412, median_usd: 111_575, gini: 0.57, source: GWR2026 },

  // Switzerland
  { country: "CH", year: 2016, mean_usd: 511_775, median_usd: 105_896, adults_thousands: 6_735, source: GWD2023(2016) },
  { country: "CH", year: 2017, mean_usd: 561_311, median_usd: 113_626, adults_thousands: 6_795, source: GWD2023(2017) },
  { country: "CH", year: 2018, mean_usd: 558_935, median_usd: 115_239, adults_thousands: 6_852, source: GWD2023(2018) },
  { country: "CH", year: 2019, mean_usd: 603_202, median_usd: 139_550, adults_thousands: 6_907, source: GWD2023(2019) },
  { country: "CH", year: 2020, mean_usd: 671_565, median_usd: 153_917, adults_thousands: 6_958, source: GWD2023(2020) },
  { country: "CH", year: 2021, mean_usd: 698_678, median_usd: 168_585, adults_thousands: 7_003, source: GWD2023(2021) },
  { country: "CH", year: 2022, mean_usd: 685_226, median_usd: 167_353, gini: 0.772, adults_thousands: 7_047, source: GWD2023_WITH_GINI },
  { country: "CH", year: 2025, mean_usd: 910_382, median_usd: 145_555, gini: 0.68, source: GWR2026 },

  // United Kingdom
  { country: "UK", year: 2016, mean_usd: 246_788, median_usd: 104_353, adults_thousands: 51_027, source: GWD2023(2016) },
  { country: "UK", year: 2017, mean_usd: 282_198, median_usd: 124_229, adults_thousands: 51_386, source: GWD2023(2017) },
  { country: "UK", year: 2018, mean_usd: 257_703, median_usd: 110_620, adults_thousands: 51_729, source: GWD2023(2018) },
  { country: "UK", year: 2019, mean_usd: 270_553, median_usd: 128_668, adults_thousands: 52_048, source: GWD2023(2019) },
  { country: "UK", year: 2020, mean_usd: 295_309, median_usd: 138_664, adults_thousands: 52_330, source: GWD2023(2020) },
  { country: "UK", year: 2021, mean_usd: 318_501, median_usd: 155_813, adults_thousands: 52_562, source: GWD2023(2021) },
  { country: "UK", year: 2022, mean_usd: 302_783, median_usd: 151_825, gini: 0.702, adults_thousands: 52_752, source: GWD2023_WITH_GINI },
  { country: "UK", year: 2025, mean_usd: 292_808, median_usd: 125_335, gini: 0.59, source: GWR2026 },
];

function geometricInterp(from: number, to: number, fraction: number): number {
  return Math.round(from * Math.pow(to / from, fraction));
}

/** 2023/2024 bridge rows across the methodology break (see module doc). */
function interpolatedRecords(): WealthDistributionRecord[] {
  const out: WealthDistributionRecord[] = [];
  for (const country of WEALTH_COUNTRIES) {
    const from = BASE_RECORDS.find((r) => r.country === country && r.year === 2022);
    const to = BASE_RECORDS.find((r) => r.country === country && r.year === 2025);
    if (!from || !to) throw new Error(`wealthDistributions: missing 2022/2025 anchors for ${country}`);
    for (const year of [2023, 2024]) {
      const fraction = (year - 2022) / 3;
      const rec: WealthDistributionRecord = {
        country,
        year,
        mean_usd: geometricInterp(from.mean_usd, to.mean_usd, fraction),
        interpolated: true,
        source: `Geometric interpolation 2022→2025 (methodology break; endpoints: GWD 2023 / GWR 2026${to.reconstructed ? ", 2025 endpoint own reconstruction" : ""})`,
      };
      if (from.median_usd != null && to.median_usd != null) {
        rec.median_usd = geometricInterp(from.median_usd, to.median_usd, fraction);
      }
      if (from.mean_fin_usd != null && to.mean_fin_usd != null) {
        rec.mean_fin_usd = geometricInterp(from.mean_fin_usd, to.mean_fin_usd, fraction);
      }
      out.push(rec);
    }
  }
  return out;
}

export const WEALTH_DISTRIBUTIONS: readonly WealthDistributionRecord[] = [
  ...BASE_RECORDS,
  ...interpolatedRecords(),
].sort((a, b) => (a.country === b.country ? a.year - b.year : a.country.localeCompare(b.country)));

export function wealthDistributionRecordFor(country: WealthCountry, year: number): WealthDistributionRecord {
  const rec = WEALTH_DISTRIBUTIONS.find((r) => r.country === country && r.year === year);
  if (!rec) throw new Error(`wealthDistributions: no record for ${country} ${year}`);
  return rec;
}

export function maxWealthDistributionYear(): number {
  return Math.max(...WEALTH_DISTRIBUTIONS.map((r) => r.year));
}

export function minWealthDistributionYear(): number {
  return Math.min(...WEALTH_DISTRIBUTIONS.map((r) => r.year));
}

/**
 * Financial-wealth Gini = total Gini + uplift, capped (financial wealth is more
 * concentrated than total wealth). Configurable defaults per the module methodology.
 */
export const GINI_FIN_UPLIFT = 0.08;
export const GINI_FIN_CAP = 0.92;

/**
 * Gini implied by the preferred mean/median lognormal fit: `2·phi(sigma/√2) − 1`.
 *
 * The financial mode uses this — not the published Gini — as its base so the 2016→2025
 * series stays continuous: published Ginis exist only for 2022/2025, and the 2022 one
 * (CL 0.788) reflects tail data the mean/median lognormal fit cannot carry anyway
 * (implied ≈ 0.69). Mixing the two bases would put a spurious jump in the chart.
 */
export function impliedGiniFromMeanMedian(meanUsd: number, medianUsd: number): number {
  const sigma = sigmaFromMeanMedian(meanUsd, medianUsd);
  return 2 * phi(sigma / Math.SQRT2) - 1;
}

function sigmaFromMeanMedian(meanUsd: number, medianUsd: number): number {
  if (!(meanUsd > 0) || !(medianUsd > 0)) {
    throw new Error(`wealthDistributions: mean/median must be positive (${meanUsd}, ${medianUsd})`);
  }
  if (meanUsd <= medianUsd) {
    throw new Error(
      `wealthDistributions: lognormal needs mean > median, got mean=${meanUsd} median=${medianUsd}`
    );
  }
  return Math.sqrt(2 * Math.log(meanUsd / medianUsd));
}

function sigmaFromGini(gini: number): number {
  if (!(gini > 0 && gini < 1)) throw new Error(`wealthDistributions: gini must be in (0,1), got ${gini}`);
  return Math.SQRT2 * phiInv((gini + 1) / 2);
}

export type LognormalParams = { mu: number; sigma: number };

export function lognormalParamsFor(
  country: WealthCountry,
  year: number,
  mode: WealthMode
): LognormalParams {
  const rec = wealthDistributionRecordFor(country, year);
  if (mode === "total") {
    if (rec.median_usd != null) {
      const sigma = sigmaFromMeanMedian(rec.mean_usd, rec.median_usd);
      return { mu: Math.log(rec.median_usd), sigma };
    }
    if (rec.gini != null) {
      const sigma = sigmaFromGini(rec.gini);
      return { mu: Math.log(rec.mean_usd) - (sigma * sigma) / 2, sigma };
    }
    throw new Error(`wealthDistributions: ${country} ${year} has neither median nor gini`);
  }
  // financial: needs mean_fin_usd (CL rows) + the implied-Gini base from mean/median.
  if (rec.mean_fin_usd == null) {
    throw new Error(`wealthDistributions: ${country} ${year} has no mean_fin_usd (financial mode)`);
  }
  if (!(rec.mean_fin_usd > 0)) {
    throw new Error(`wealthDistributions: ${country} ${year} mean_fin_usd must be positive`);
  }
  if (rec.median_usd == null) {
    throw new Error(`wealthDistributions: ${country} ${year} needs median_usd for the implied-Gini base`);
  }
  const giniBase = impliedGiniFromMeanMedian(rec.mean_usd, rec.median_usd);
  const giniFin = Math.min(giniBase + GINI_FIN_UPLIFT, GINI_FIN_CAP);
  const sigma = sigmaFromGini(giniFin);
  return { mu: Math.log(rec.mean_fin_usd) - (sigma * sigma) / 2, sigma };
}

/** Wealth (USD) at percentile q ∈ (0, 1). */
export function lognormalThresholdUsd(params: LognormalParams, q: number): number {
  return Math.exp(params.mu + params.sigma * phiInv(q));
}

/** Percentile (0–1) of a positive net worth W (USD). Callers gate W ≤ 0 (`below_support`). */
export function lognormalPercentile(params: LognormalParams, netWorthUsd: number): number {
  if (!(netWorthUsd > 0)) {
    throw new Error(`lognormalPercentile: W must be > 0, got ${netWorthUsd} (gate below_support first)`);
  }
  return phi((Math.log(netWorthUsd) - params.mu) / params.sigma);
}
