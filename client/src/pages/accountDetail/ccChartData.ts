import type {
  CcBillingDetailMonthDto,
  CcFacturacionDto,
  CcFinancingPlMonthDto,
  CcInstallmentHistoryMonthPoint,
} from "../../types";

export type CcBillingMonthChartPoint = {
  billing_month: string;
  facturado_clp: number | null;
  facturado_usd_clp: number | null;
  financing_cost_clp: number | null;
  ytd_financing_cost_clp: number | null;
};

export function facturadoFromFacturaciones(
  facturaciones: CcFacturacionDto[] | undefined
): Map<string, { facturado_clp: number | null; facturado_usd_clp: number | null }> {
  const out = new Map<string, { facturado_clp: number | null; facturado_usd_clp: number | null }>();
  if (!facturaciones?.length) return out;
  for (const row of facturaciones) {
    out.set(row.billing_month, {
      facturado_clp: row.facturado_clp,
      facturado_usd_clp: row.facturado_usd_clp,
    });
  }
  return out;
}

export function buildCcBillingMonthChartPoints(
  facturaciones: CcFacturacionDto[] | undefined,
  financingPl: CcFinancingPlMonthDto[] | undefined
): CcBillingMonthChartPoint[] {
  const months = new Set<string>();
  for (const f of facturaciones ?? []) months.add(f.billing_month);
  for (const p of financingPl ?? []) months.add(p.billing_month);
  const factByMonth = facturadoFromFacturaciones(facturaciones);
  const finByMonth = new Map((financingPl ?? []).map((r) => [r.billing_month, r] as const));

  return [...months]
    .sort((a, b) => a.localeCompare(b))
    .map((billing_month) => {
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

/** Historial chart: billing-month axis aligned with Detalle por mes. */
export type CcHistorialChartRow = {
  month: string;
  installment_payments_clp: number;
  facturado_clp: number | null;
  cupo_en_cuotas_clp: number | null;
  balance_total_clp: number | null;
};

function cupoFromHistPoint(h: CcInstallmentHistoryMonthPoint): number | null {
  const cupo = h.ledger_remaining_installments_clp ?? h.remaining_balance_clp;
  return cupo != null && Number.isFinite(cupo) ? cupo : null;
}

function histHasProjectedInstallmentData(h: CcInstallmentHistoryMonthPoint): boolean {
  const cupo = cupoFromHistPoint(h);
  return h.installment_payments_clp > 0 || (cupo != null && cupo > 0);
}

function collectHistorialChartMonths(
  hist: CcInstallmentHistoryMonthPoint[],
  detalle: CcBillingDetailMonthDto[] | undefined
): string[] {
  const months = new Set<string>();
  for (const d of detalle ?? []) {
    months.add(d.billing_month);
  }

  const lastDetalleYm =
    detalle && detalle.length > 0
      ? [...detalle].sort((a, b) => b.billing_month.localeCompare(a.billing_month))[0]!
          .billing_month
      : null;

  let maxProjectedYm: string | null = null;
  for (const h of hist) {
    if (lastDetalleYm != null && h.month.localeCompare(lastDetalleYm) <= 0) continue;
    if (!histHasProjectedInstallmentData(h)) continue;
    if (maxProjectedYm == null || h.month.localeCompare(maxProjectedYm) > 0) {
      maxProjectedYm = h.month;
    }
  }

  if (maxProjectedYm != null) {
    for (const h of hist) {
      if (lastDetalleYm != null && h.month.localeCompare(lastDetalleYm) <= 0) continue;
      if (h.month.localeCompare(maxProjectedYm) > 0) continue;
      if (histHasProjectedInstallmentData(h)) months.add(h.month);
    }
  }

  if (months.size === 0) {
    for (const h of hist) {
      if (histHasProjectedInstallmentData(h)) months.add(h.month);
    }
  }

  return [...months].sort((a, b) => a.localeCompare(b));
}

export function buildCcHistorialChartRows(
  hist: CcInstallmentHistoryMonthPoint[],
  detalle: CcBillingDetailMonthDto[] | undefined,
  facturaciones: CcFacturacionDto[] | undefined
): CcHistorialChartRow[] {
  const histByMonth = new Map(hist.map((h) => [h.month, h] as const));
  const detalleByMonth = new Map((detalle ?? []).map((d) => [d.billing_month, d] as const));
  const facturacionByMonth = new Map((facturaciones ?? []).map((f) => [f.billing_month, f] as const));
  const facturadoByMonth = new Map(
    (facturaciones ?? []).map(
      (f) =>
        [
          f.billing_month,
          f.facturado_total_clp ?? (f.facturado_clp ?? 0) + (f.facturado_usd_clp ?? 0),
        ] as const
    )
  );

  const months = collectHistorialChartMonths(hist, detalle);

  return months.map((month) => {
    const d = detalleByMonth.get(month);
    const h = histByMonth.get(month);
    const fact = facturacionByMonth.get(month);
    const facturado =
      facturadoByMonth.get(month) ?? d?.total_facturado_clp ?? null;
    const cupo =
      d?.cupo_en_cuotas_clp ?? (h != null ? cupoFromHistPoint(h) : null);
    let balance_total_clp = d?.balance_total_clp ?? null;
    if (balance_total_clp == null && cupo != null) {
      balance_total_clp = (facturado ?? 0) + cupo;
    }
    const installment_payments_clp =
      fact?.cuota_a_pagar_clp ??
      d?.cuota_a_pagar_next_mes_clp ??
      h?.installment_payments_clp ??
      0;
    return {
      month,
      installment_payments_clp,
      facturado_clp: facturado,
      cupo_en_cuotas_clp: cupo,
      balance_total_clp,
    };
  });
}
