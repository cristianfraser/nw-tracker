/** DTOs for /wealth-percentile (see server wealthPercentile.ts). */
import type { DisplayUnitCode } from "./core.js";

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
  /** The distribution's thresholds as printed (USD). */
  p50_usd: number; // convention-ok: the databook's thresholds as printed, in dollars
  p90_usd: number; // convention-ok: the databook's thresholds as printed, in dollars
  p99_usd: number; // convention-ok: the databook's thresholds as printed, in dollars
  /** The same thresholds in the response's `unit` at the row's year-end rate. */
  p50: number;
  p90: number;
  p99: number;
}

export interface WealthPercentileYearRow {
  year: number;
  /** Valuation date: YYYY-12-31, or today for the current year. */
  as_of_date: string;
  /** Seed row year backing every cell's distribution (< year once the databook lags). */
  distribution_year: number;
  fx_clp_per_usd: number; // convention-ok: the USD/CLP rate the year-end row converts at
  fx_date: string;
  /** Distribution parameters interpolated across the 2022→2025 methodology break. */
  interpolated: boolean;
  /** CL distribution is an own reconstruction (2025), not an official UBS figure. */
  reconstructed: boolean;
  /** CLP per one unit of the response's `unit` at the row's year-end (1 for CLP, the observado for USD). */
  clp_per_unit: number;
  /** Net worth in the response's `unit`. */
  net_worth: number;
  /** Total − real_estate bucket (ex real estate, ex mortgage), in `unit`. */
  fin_net_worth: number;
  cl_total: WealthPercentileCell;
  cl_financial: WealthPercentileCell;
  benchmarks: Record<WealthBenchmarkCountry, WealthPercentileCell>;
}

/** `GET /api/wealth-percentile?unit=` */
export interface WealthPercentileResponse {
  unit: DisplayUnitCode;
  rows: WealthPercentileYearRow[];
}
