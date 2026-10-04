import type { TFunction } from "i18next";
import { formatPct } from "./format";
import type { BenchmarkOption } from "./types";

/**
 * The label keys the server's `benchmarks` rows name (`label_i18n_key`, migration 207). A row
 * whose key is not here has no translation: adding a benchmark means adding its label too.
 */
const BENCHMARK_LABEL_KEYS: ReadonlySet<string> = new Set([
  "benchmarks.mortgage",
  "benchmarks.spy",
  "benchmarks.riskyNorris",
  "benchmarks.uf",
]);

/** A benchmark's display name, its rate (UF + x%) formatted at render time. */
export function benchmarkOptionLabel(t: TFunction, o: BenchmarkOption): string {
  if (!BENCHMARK_LABEL_KEYS.has(o.label_i18n_key)) {
    throw new Error(`benchmark ${o.slug}: no translation for ${o.label_i18n_key}`);
  }
  return t(o.label_i18n_key, { rate: o.rate_pct != null ? formatPct(o.rate_pct) : "" });
}
