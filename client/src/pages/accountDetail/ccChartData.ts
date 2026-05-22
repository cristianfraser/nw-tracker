import type {
  CcBillingDetailMonthDto,
  CcBillingMonthBalanceDto,
  CcInstallmentHistoryMonthPoint,
} from "../../types";

export function facturadoClpByBillingMonth(
  billingRows: CcBillingMonthBalanceDto[] | undefined
): Map<string, number> {
  const out = new Map<string, number>();
  if (!billingRows?.length) return out;
  for (const row of billingRows) {
    if (row.as_of_kind !== "statement") continue;
    if (row.facturado_clp != null && Number.isFinite(row.facturado_clp)) {
      out.set(row.billing_month, row.facturado_clp);
    }
  }
  return out;
}

/** Historial chart: billing-month axis aligned with Detalle por mes. */
export type CcHistorialChartRow = {
  month: string;
  installment_payments_clp: number;
  facturado_clp: number | null;
  cupo_en_cuotas_clp: number | null;
  balance_total_clp: number | null;
};

export function buildCcHistorialChartRows(
  hist: CcInstallmentHistoryMonthPoint[],
  detalle: CcBillingDetailMonthDto[] | undefined,
  billingRows: CcBillingMonthBalanceDto[] | undefined
): CcHistorialChartRow[] {
  const payByMonth = new Map(
    hist.map((h) => [h.month, h.installment_payments_clp] as const)
  );
  const facturadoByMonth = facturadoClpByBillingMonth(billingRows);

  if (detalle?.length) {
    return [...detalle]
      .sort((a, b) => a.billing_month.localeCompare(b.billing_month))
      .map((d) => ({
        month: d.billing_month,
        installment_payments_clp: payByMonth.get(d.billing_month) ?? 0,
        facturado_clp: facturadoByMonth.get(d.billing_month) ?? null,
        cupo_en_cuotas_clp: d.cupo_en_cuotas_clp,
        balance_total_clp: d.balance_total_clp,
      }));
  }

  return [...hist]
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((h) => ({
      month: h.month,
      installment_payments_clp: h.installment_payments_clp,
      facturado_clp: facturadoByMonth.get(h.month) ?? null,
      cupo_en_cuotas_clp: null,
      balance_total_clp: null,
    }));
}

export function monthKeyFromAsOfDate(asOf: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(String(asOf ?? "").trim());
  return m ? `${m[1]}-${m[2]}` : "";
}

export function mergeFacturadoIntoPerfPoints<T extends Record<string, string | number | null>>(
  points: T[],
  billingRows: CcBillingMonthBalanceDto[] | undefined
): (T & { facturado_clp: number | null })[] {
  const byMonth = facturadoClpByBillingMonth(billingRows);
  return points.map((p) => ({
    ...p,
    facturado_clp: byMonth.get(monthKeyFromAsOfDate(String(p.as_of_date ?? ""))) ?? null,
  }));
}
