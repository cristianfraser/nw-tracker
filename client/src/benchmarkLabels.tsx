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
  "benchmarks.dap",
]);

/**
 * A benchmark's display name, its rate (UF + x%) formatted at render time. One of the user's own
 * groups is named by its group (nav label key, else the stored label).
 */
export function benchmarkOptionLabel(t: TFunction, o: BenchmarkOption): string {
  if (o.kind === "portfolio_group") {
    if (o.label_i18n_key) return t(o.label_i18n_key);
    if (!o.label) throw new Error(`benchmark ${o.slug}: a group row without a label`);
    return o.label;
  }
  if (o.label_i18n_key == null || !BENCHMARK_LABEL_KEYS.has(o.label_i18n_key)) {
    throw new Error(`benchmark ${o.slug}: no translation for ${o.label_i18n_key}`);
  }
  return t(o.label_i18n_key, { rate: o.rate_pct != null ? formatPct(o.rate_pct) : "" });
}

/** Select options: market benchmarks first, then the user's own groups under their own heading. */
export function BenchmarkSelectOptions({
  t,
  options,
}: {
  t: TFunction;
  options: readonly BenchmarkOption[];
}) {
  const market = options.filter((o) => o.kind !== "portfolio_group");
  const own = options.filter((o) => o.kind === "portfolio_group");
  return (
    <>
      {market.map((o) => (
        <option key={o.slug} value={o.slug}>
          {benchmarkOptionLabel(t, o)}
        </option>
      ))}
      {own.length ? (
        <optgroup label={t("benchmarks.ownPortfolios")}>
          {own.map((o) => (
            <option key={o.slug} value={o.slug}>
              {benchmarkOptionLabel(t, o)}
            </option>
          ))}
        </optgroup>
      ) : null}
    </>
  );
}
