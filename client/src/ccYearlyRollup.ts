import type {
  CcBillingDetailMonthDto,
  CcBillingMonthChartPoint,
  CcHistorialChartPoint,
} from "./types";

/**
 * Yearly rollups for the credit-card views when the global metrics period is "year".
 * Convention shared by the three views: flow metrics (facturado, coste financiero,
 * pagos de cuotas) SUM across the year's billing months — projected plan months
 * included; stock metrics (cupo en cuotas, balance total) take the year's latest
 * month, i.e. the (possibly projected) year-end value. Facturaciones stays monthly
 * by design (per-event raw data), so it has no rollup here.
 */

function sumOrNull(values: readonly (number | null | undefined)[]): number | null {
  let sum = 0;
  let any = false;
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v)) {
      sum += v;
      any = true;
    }
  }
  return any ? sum : null;
}

function lastFinite(values: readonly (number | null | undefined)[]): number | null {
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

function groupByYearAsc<T>(rows: readonly T[], ymOf: (row: T) => string): Map<string, T[]> {
  const byYear = new Map<string, T[]>();
  for (const row of rows) {
    const year = ymOf(row).slice(0, 4);
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year)!.push(row);
  }
  for (const months of byYear.values()) {
    months.sort((a, b) => ymOf(a).localeCompare(ymOf(b)));
  }
  return new Map([...byYear.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * One Detalle row per year (`billing_month` = `YYYY-12`), years ascending.
 * `total_facturado_clp` is the plain sum only when every month closed; a year with
 * open/projected months reports null facturado and carries the full-year estimate in
 * `cuota_a_pagar_next_mes_clp` (closed facturado + each unclosed month's cuota-a-pagar —
 * the same substitution the monthly rows render as `≈`). `projected` only when the
 * whole year is plan-only, so the default page still lands on the current year.
 */
export function rollupCcBillingDetailYearly(
  rows: readonly CcBillingDetailMonthDto[]
): CcBillingDetailMonthDto[] {
  const byYear = groupByYearAsc(rows, (r) => r.billing_month);
  return [...byYear.entries()].map(([year, months]) => {
    const latest = months[months.length - 1]!;
    const closedFacturado = sumOrNull(months.map((m) => m.total_facturado_clp));
    const unclosed = months.filter((m) => m.total_facturado_clp == null);
    const estimatedFacturado =
      (closedFacturado ?? 0) + unclosed.reduce((s, m) => s + m.cuota_a_pagar_next_mes_clp, 0);
    return {
      billing_month: `${year}-12`,
      as_of_date: latest.as_of_date,
      as_of_kind: latest.as_of_kind,
      total_facturado_actual_clp: sumOrNull(months.map((m) => m.total_facturado_actual_clp)),
      total_facturado_clp: unclosed.length === 0 ? closedFacturado : null,
      cupo_en_cuotas_clp: latest.cupo_en_cuotas_clp,
      cuota_a_pagar_next_mes_clp: estimatedFacturado,
      balance_total_clp: latest.balance_total_clp,
      projected: months.every((m) => m.projected === true),
    } satisfies CcBillingDetailMonthDto;
  });
}

/** Historial chart: bars sum (projected plan cuotas included), lines take the year's last known value. */
export function rollupCcHistorialChartYearly(
  rows: readonly CcHistorialChartPoint[]
): CcHistorialChartPoint[] {
  const byYear = groupByYearAsc(rows, (r) => r.month);
  return [...byYear.entries()].map(([year, months]) => ({
    month: `${year}-12`,
    installment_payments_clp: months.reduce((s, m) => s + m.installment_payments_clp, 0),
    facturado_clp: sumOrNull(months.map((m) => m.facturado_clp)),
    cupo_en_cuotas_clp: lastFinite(months.map((m) => m.cupo_en_cuotas_clp)),
    balance_total_clp: lastFinite(months.map((m) => m.balance_total_clp)),
  }));
}

/**
 * Facturado / coste-financiero chart: all three bars are flows and sum per year.
 * The YTD running series is redundant at year granularity (it would equal the
 * financing-cost bar every December) and is dropped.
 */
export function rollupCcBillingMonthChartYearly(
  points: readonly CcBillingMonthChartPoint[]
): CcBillingMonthChartPoint[] {
  const byYear = groupByYearAsc(points, (p) => p.billing_month);
  return [...byYear.entries()].map(([year, months]) => ({
    billing_month: `${year}-12`,
    facturado_clp: sumOrNull(months.map((m) => m.facturado_clp)),
    facturado_usd_clp: sumOrNull(months.map((m) => m.facturado_usd_clp)),
    financing_cost_clp: sumOrNull(months.map((m) => m.financing_cost_clp)),
    ytd_financing_cost_clp: null,
  }));
}
