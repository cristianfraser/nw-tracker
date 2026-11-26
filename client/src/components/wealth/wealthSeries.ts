import { formatGroupedDecimal } from "../../format";
import type { WealthBenchmarkCountry } from "../../types";

/** Every benchmark country, in the picker's fixed order. */
export const BENCHMARK_COUNTRIES: readonly WealthBenchmarkCountry[] = [
  "US",
  "ES",
  "CH",
  "UK",
  "AU",
  "DE",
  "JP",
  "MX",
  "BR",
  "CN",
];

/** Distinct hues from the app palette families; the Chile pair below is white / gray, so no grays here. */
export const BENCHMARK_STROKE: Record<WealthBenchmarkCountry, string> = {
  US: "#22c55e",
  ES: "#eab308",
  CH: "#ec4899",
  UK: "#a78bfa",
  AU: "#fb923c",
  DE: "#38bdf8",
  JP: "#f87171",
  MX: "#2dd4bf",
  BR: "#e879f9",
  CN: "#fcd34d",
};

/** The two Chile lines share one neutral hue so the benchmarks carry the colour. */
export const CL_TOTAL_STROKE = "#ffffff";
export const CL_FINANCIAL_STROKE = "#94a3b8";

/** «p96,7»: a percentile at the one decimal the page shows. */
export function percentileLabel(percentile: number): string {
  return `p${formatGroupedDecimal(percentile, 1)}`;
}

const THRESHOLD_PERCENTILES = [50, 90, 99] as const;

/**
 * A percentile beside the p50 / p90 / p99 thresholds. It reads as everywhere else on the page
 * (one decimal, rounded) unless rounding would lift it onto a threshold it is under: 89,96 is
 * «p89,9», not «p90,0». Above p99 two decimals, truncated, where one would show «p99,9» for 99,96.
 */
export function percentileLabelBelowThreshold(percentile: number): string {
  if (percentile >= 99) return `p${formatGroupedDecimal(Math.floor(percentile * 100) / 100, 2)}`;
  const rounded = Math.round(percentile * 10) / 10;
  const crosses = THRESHOLD_PERCENTILES.some((threshold) => percentile < threshold && rounded >= threshold);
  return `p${formatGroupedDecimal(crosses ? Math.floor(percentile * 10) / 10 : rounded, 1)}`;
}
