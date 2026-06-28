import { expandYearMonthsInclusive } from "./calendarMonth.js";
import type { CcBillingDetailMonthRow, CcFacturacionRow } from "./ccBillingViews.js";
import type { CcFinancingPlMonthRow } from "./creditCardPerformancePl.js";

// ─── Historial chart ──────────────────────────────────────────────────────────

export type CcHistorialChartPoint = {
  month: string;
  installment_payments_clp: number;
  facturado_clp: number | null;
  cupo_en_cuotas_clp: number | null;
  balance_total_clp: number | null;
};

type HistMonthPoint = {
  month: string;
  remaining_balance_clp: number;
  installment_payments_clp: number;
  ledger_remaining_installments_clp?: number;
};

function cupoFromHistPoint(h: HistMonthPoint): number | null {
  const cupo = h.ledger_remaining_installments_clp ?? h.remaining_balance_clp;
  return cupo != null && Number.isFinite(cupo) ? cupo : null;
}

function histHasProjectedInstallmentData(h: HistMonthPoint): boolean {
  const cupo = cupoFromHistPoint(h);
  return h.installment_payments_clp > 0 || (cupo != null && cupo > 0);
}

function collectHistorialBaseMonths(
  hist: HistMonthPoint[],
  detalle: CcBillingDetailMonthRow[] | undefined
): string[] {
  const months = new Set<string>();
  for (const d of detalle ?? []) months.add(d.billing_month);

  const lastDetalleYm =
    detalle && detalle.length > 0
      ? [...detalle].sort((a, b) => b.billing_month.localeCompare(a.billing_month))[0]!.billing_month
      : null;

  // Extend into projected future months from the ledger plan
  let maxProjectedYm: string | null = null;
  for (const h of hist) {
    if (lastDetalleYm != null && h.month.localeCompare(lastDetalleYm) <= 0) continue;
    if (!histHasProjectedInstallmentData(h)) continue;
    if (maxProjectedYm == null || h.month.localeCompare(maxProjectedYm) > 0) maxProjectedYm = h.month;
  }
  if (maxProjectedYm != null) {
    for (const h of hist) {
      if (lastDetalleYm != null && h.month.localeCompare(lastDetalleYm) <= 0) continue;
      if (h.month.localeCompare(maxProjectedYm) > 0) continue;
      if (histHasProjectedInstallmentData(h)) months.add(h.month);
    }
  }

  // Fallback: no detalle at all — use the hist data directly
  if (months.size === 0) {
    for (const h of hist) {
      if (histHasProjectedInstallmentData(h)) months.add(h.month);
    }
  }

  return [...months].sort((a, b) => a.localeCompare(b));
}

/**
 * Dense historial chart series for the CC installment history chart.
 * Every interior month between min and max is included (null values for
 * missing data so the chart X-axis is continuous).
 */
export function buildCcHistorialChartSeries(
  hist: HistMonthPoint[],
  detalle: CcBillingDetailMonthRow[] | undefined,
  facturaciones: CcFacturacionRow[] | undefined
): CcHistorialChartPoint[] {
  const histByMonth = new Map(hist.map((h) => [h.month, h] as const));
  const detalleByMonth = new Map((detalle ?? []).map((d) => [d.billing_month, d] as const));
  const facturadoByMonth = new Map(
    (facturaciones ?? []).map((f) => [
      f.billing_month,
      f.facturado_total_clp ?? (f.facturado_clp ?? 0) + (f.facturado_usd_clp ?? 0),
    ] as const)
  );
  const facturacionByMonth = new Map((facturaciones ?? []).map((f) => [f.billing_month, f] as const));

  const sparseMonths = collectHistorialBaseMonths(hist, detalle);
  if (sparseMonths.length === 0) return [];

  // Fill every interior month so the chart axis has no gaps
  const minYm = sparseMonths[0]!;
  const maxYm = sparseMonths[sparseMonths.length - 1]!;
  const allMonths = expandYearMonthsInclusive(minYm, maxYm);

  return allMonths.map((month) => {
    const d = detalleByMonth.get(month);
    const h = histByMonth.get(month);
    const fact = facturacionByMonth.get(month);
    const facturado = facturadoByMonth.get(month) ?? d?.total_facturado_clp ?? null;
    const cupo = d?.cupo_en_cuotas_clp ?? (h != null ? cupoFromHistPoint(h) : null);
    let balance_total_clp = d?.balance_total_clp ?? null;
    if (balance_total_clp == null && cupo != null) {
      balance_total_clp = (facturado ?? 0) + cupo;
    }
    const installment_payments_clp =
      fact?.cuota_a_pagar_clp ?? d?.cuota_a_pagar_next_mes_clp ?? h?.installment_payments_clp ?? 0;
    return {
      month,
      installment_payments_clp,
      facturado_clp: facturado,
      cupo_en_cuotas_clp: cupo,
      balance_total_clp,
    };
  });
}

// ─── Billing-month chart ──────────────────────────────────────────────────────

export type CcBillingMonthChartPoint = {
  billing_month: string;
  facturado_clp: number | null;
  facturado_usd_clp: number | null;
  financing_cost_clp: number | null;
  ytd_financing_cost_clp: number | null;
};

/**
 * Dense billing-month chart series for the facturado / financing-cost chart.
 * Every interior month between min and max is included (null values for months
 * with no data so the chart axis is continuous).
 */
export function buildCcBillingMonthChartSeries(
  facturaciones: CcFacturacionRow[] | undefined,
  financingPl: CcFinancingPlMonthRow[] | undefined
): CcBillingMonthChartPoint[] {
  const factByMonth = new Map(
    (facturaciones ?? []).map((f) => [f.billing_month, f] as const)
  );
  const finByMonth = new Map(
    (financingPl ?? []).map((r) => [r.billing_month, r] as const)
  );

  const sparseMonths = new Set<string>();
  for (const f of facturaciones ?? []) sparseMonths.add(f.billing_month);
  for (const p of financingPl ?? []) sparseMonths.add(p.billing_month);
  if (sparseMonths.size === 0) return [];

  const sorted = [...sparseMonths].sort((a, b) => a.localeCompare(b));
  const minYm = sorted[0]!;
  const maxYm = sorted[sorted.length - 1]!;
  const allMonths = expandYearMonthsInclusive(minYm, maxYm);

  return allMonths.map((billing_month) => {
    const fact = factByMonth.get(billing_month);
    const fin = finByMonth.get(billing_month);
    return {
      billing_month,
      facturado_clp: fact?.facturado_clp ?? null,
      facturado_usd_clp: fact?.facturado_usd_clp ?? null,
      financing_cost_clp: fin?.financing_cost_clp ?? null,
      ytd_financing_cost_clp: fin?.ytd_financing_cost_clp ?? null,
    };
  });
}
