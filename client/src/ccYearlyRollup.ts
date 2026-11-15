import type { CcBillingDetailMonthDto, CcHistorialChartPoint } from "./types";

/**
 * Yearly rollups for the credit-card views when their período is "year".
 * Convention shared by both views: flow metrics (facturado and its cuotas) SUM across the
 * year's billing months — projected plan months included; stock metrics (cupo en cuotas,
 * balance total) take the year's latest month, i.e. the (possibly projected) year-end value.
 * Facturaciones stays monthly by design (per-event raw data), so it has no rollup here.
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
 * `total_facturado` is the plain sum only when every month closed; a year with
 * open/projected months reports null facturado and carries the full-year estimate in
 * `cuota_a_pagar_next_mes` (closed facturado + each unclosed month's cuota-a-pagar —
 * the same substitution the monthly rows render as `≈`). `projected` only when the
 * whole year is plan-only, so the default page still lands on the current year.
 */
export function rollupCcBillingDetailYearly(
  rows: readonly CcBillingDetailMonthDto[]
): CcBillingDetailMonthDto[] {
  const byYear = groupByYearAsc(rows, (r) => r.billing_month);
  return [...byYear.entries()].map(([year, months]) => {
    const latest = months[months.length - 1]!;
    const closedFacturado = sumOrNull(months.map((m) => m.total_facturado));
    const unclosed = months.filter((m) => m.total_facturado == null);
    const estimatedFacturado =
      (closedFacturado ?? 0) + unclosed.reduce((s, m) => s + m.cuota_a_pagar_next_mes, 0);
    return {
      billing_month: `${year}-12`,
      as_of_date: latest.as_of_date,
      as_of_kind: latest.as_of_kind,
      total_facturado_actual: sumOrNull(months.map((m) => m.total_facturado_actual)),
      total_facturado: unclosed.length === 0 ? closedFacturado : null,
      // Month-frame lines: the year's last month WITH a point (a month may have none).
      cupo_en_cuotas: lastFinite(months.map((m) => m.cupo_en_cuotas)),
      cuota_a_pagar_next_mes: estimatedFacturado,
      balance_total: lastFinite(months.map((m) => m.balance_total)),
      cupo_statement: latest.cupo_statement,
      balance_statement: latest.balance_statement,
      projected: months.every((m) => m.projected === true),
    } satisfies CcBillingDetailMonthDto;
  });
}

/**
 * Historial chart: each bar segment sums (projected plan cuotas included), lines take the year's
 * last known value.
 */
/** The months' foreign amounts summed per currency (null when no month billed in a foreign currency). */
function sumForeignAmounts(
  months: readonly ({ currency: string; amount: number }[] | null)[]
): { currency: string; amount: number }[] | null {
  if (months.every((m) => m == null)) return null;
  const out: { currency: string; amount: number }[] = [];
  for (const m of months) {
    for (const f of m ?? []) {
      const hit = out.find((o) => o.currency === f.currency);
      if (hit) hit.amount += f.amount;
      else out.push({ ...f });
    }
  }
  return out;
}

export function rollupCcHistorialChartYearly(
  rows: readonly CcHistorialChartPoint[]
): CcHistorialChartPoint[] {
  const byYear = groupByYearAsc(rows, (r) => r.month);
  return [...byYear.entries()].map(([year, months]) => ({
    month: `${year}-12`,
    facturado_cuotas: sumOrNull(months.map((m) => m.facturado_cuotas)),
    facturado_rest: sumOrNull(months.map((m) => m.facturado_rest)),
    facturado_foreign_total: sumOrNull(months.map((m) => m.facturado_foreign_total)),
    facturado_foreign: sumForeignAmounts(months.map((m) => m.facturado_foreign)),
    facturado_total: sumOrNull(months.map((m) => m.facturado_total)),
    cupo_en_cuotas: lastFinite(months.map((m) => m.cupo_en_cuotas)),
    balance_total: lastFinite(months.map((m) => m.balance_total)),
  }));
}
