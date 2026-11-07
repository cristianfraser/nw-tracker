/** DTOs for /wealth-percentile (see server wealthPercentile.ts). */

export type WealthCountry =
  | "CL"
  | "US"
  | "ES"
  | "CH"
  | "UK"
  | "AU"
  | "DE"
  | "JP"
  | "MX"
  | "BR"
  | "CN";
export type WealthBenchmarkCountry = Exclude<WealthCountry, "CL">;

/** One net worth placed in one country-mode distribution. */
export interface WealthPercentileCell {
  /** 0–100, or null when the compared net worth ≤ 0 (`below_support`). */
  percentile: number | null;
  below_support: boolean;
  p50_usd: number;
  p90_usd: number;
  p99_usd: number;
  p50_clp: number;
  p90_clp: number;
  p99_clp: number;
}

export interface WealthPercentileYearRow {
  year: number;
  /** Valuation date: YYYY-12-31, or today for the current year. */
  as_of_date: string;
  /** Seed row year backing every cell's distribution (< year once the databook lags). */
  distribution_year: number;
  fx_clp_per_usd: number;
  fx_date: string;
  /** Distribution parameters interpolated across the 2022→2025 methodology break. */
  interpolated: boolean;
  /** CL distribution is an own reconstruction (2025), not an official UBS figure. */
  reconstructed: boolean;
  net_worth_clp: number;
  net_worth_usd: number;
  /** Total − real_estate bucket (ex real estate, ex mortgage). */
  fin_net_worth_clp: number;
  fin_net_worth_usd: number;
  cl_total: WealthPercentileCell;
  cl_financial: WealthPercentileCell;
  benchmarks: Record<WealthBenchmarkCountry, WealthPercentileCell>;
}

export interface WealthPercentileResponse {
  rows: WealthPercentileYearRow[];
}
