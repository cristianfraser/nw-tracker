import type { ProportionalSeriesBlock, ProportionalSeriesLineMeta } from "./proportionalSeries.js";

/**
 * Coverage of the liabilities by the chart host's reference lines (Pasivos: «Disponible» and
 * «Disponible total»): each reference value ÷ the total owed on the same date — every liability
 * account on the page, the mortgage balance plus the cards' owed-on-date — as a fraction (1 = the
 * money would clear every debt). A date without positive debt has no coverage (null): before the
 * first loan, or once everything is paid off.
 *
 * Shaped like the proportional blocks (`dates` + `series[].values`) so the monthly and daily
 * payloads carry the same thing and the client draws it the same way at every grain.
 */
export type CoverageInputLine = ProportionalSeriesLineMeta & { values: readonly (number | null)[] };

export function buildReferenceCoverage(
  dates: readonly string[],
  liabilities: readonly (number | null)[],
  references: readonly CoverageInputLine[]
): ProportionalSeriesBlock | null {
  if (liabilities.length !== dates.length) {
    throw new Error(`reference coverage: ${liabilities.length} liability values for ${dates.length} dates`);
  }
  const series = references.map((ref) => {
    if (ref.values.length !== dates.length) {
      throw new Error(`reference coverage: ${ref.dataKey} has ${ref.values.length} values for ${dates.length} dates`);
    }
    const { values, ...meta } = ref;
    return {
      ...meta,
      dataKey: `coverage:${ref.dataKey}`,
      values: dates.map((_, i) => {
        const owed = liabilities[i];
        const v = values[i];
        if (owed == null || !(owed > 0) || v == null || !Number.isFinite(v)) return null;
        return v / owed;
      }),
    };
  });
  if (!series.some((s) => s.values.some((v) => v != null))) return null;
  return { dates: [...dates], series };
}

/** Σ of the given keys per row; null on a row where none of them has a number. */
export function sumKeysPerRow(
  rows: readonly Record<string, unknown>[],
  keys: readonly string[]
): (number | null)[] {
  return rows.map((row) => {
    let sum = 0;
    let any = false;
    for (const k of keys) {
      const v = row[k];
      if (typeof v === "number" && Number.isFinite(v)) {
        sum += v;
        any = true;
      }
    }
    return any ? sum : null;
  });
}

/** Index-aligned Σ of several value arrays; null where none of them has a number. */
export function sumAlignedValues(arrays: readonly (readonly (number | null)[])[], length: number): (number | null)[] {
  return Array.from({ length }, (_, i) => {
    let sum = 0;
    let any = false;
    for (const a of arrays) {
      const v = a[i];
      if (v != null && Number.isFinite(v)) {
        sum += v;
        any = true;
      }
    }
    return any ? sum : null;
  });
}
