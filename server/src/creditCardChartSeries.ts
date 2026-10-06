import { expandYearMonthsInclusive } from "./calendarMonth.js";
import type { CcBillingDetailMonthRow, CcFacturacionRow } from "./ccBillingViews.js";

// ─── Historial chart ──────────────────────────────────────────────────────────

/**
 * One facturación's bar, stacked: the cuotas it bills, the rest of its CLP facturado and its
 * dollar facturado in pesos. Cuota plans are CLP-only, so the first two split the CLP facturado
 * exactly and the three add up to the facturación's total.
 */
export type CcFacturadoBarSegments = {
  /** «Facturado CLP (cuotas)»: the cuotas the facturación bills — a future month's, what the plan will bill. */
  facturado_cuotas_clp: number | null;
  /**
   * «Facturado CLP»: the CLP facturado minus those cuotas — únicos and the bank's charges, net of
   * notas de crédito (negative when the credits outweigh them). Null until something is billed.
   */
  facturado_rest_clp: number | null;
  /** «Facturado US$»: the dollar facturado in pesos (at its pay-by fx)… */
  facturado_usd_clp: number | null;
  /** …and in dollars, for the tooltip. */
  facturado_usd: number | null;
  /** Σ of the three pesos segments — the tooltip's total. */
  facturado_total_clp: number | null;
};

export type CcHistorialChartPoint = CcFacturadoBarSegments & {
  month: string;
  cupo_en_cuotas_clp: number | null;
  balance_total_clp: number | null;
};

/** A card's facturación bar on that card's close date — the day-period historial's bars. */
export type CcFacturacionBarPoint = CcFacturadoBarSegments & { as_of_date: string };

const NO_BAR: CcFacturadoBarSegments = {
  facturado_cuotas_clp: null,
  facturado_rest_clp: null,
  facturado_usd_clp: null,
  facturado_usd: null,
  facturado_total_clp: null,
};

function sumNullable(a: number | null, b: number | null): number | null {
  if (a == null && b == null) return null;
  return (a ?? 0) + (b ?? 0);
}

function withTotal(s: Omit<CcFacturadoBarSegments, "facturado_total_clp">): CcFacturadoBarSegments {
  const parts = [s.facturado_cuotas_clp, s.facturado_rest_clp, s.facturado_usd_clp].filter(
    (v): v is number => v != null
  );
  return { ...s, facturado_total_clp: parts.length > 0 ? parts.reduce((a, b) => a + b, 0) : null };
}

function sumBars(a: CcFacturadoBarSegments | undefined, b: CcFacturadoBarSegments): CcFacturadoBarSegments {
  return withTotal({
    facturado_cuotas_clp: sumNullable(a?.facturado_cuotas_clp ?? null, b.facturado_cuotas_clp),
    facturado_rest_clp: sumNullable(a?.facturado_rest_clp ?? null, b.facturado_rest_clp),
    facturado_usd_clp: sumNullable(a?.facturado_usd_clp ?? null, b.facturado_usd_clp),
    facturado_usd: sumNullable(a?.facturado_usd ?? null, b.facturado_usd),
  });
}

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
 * One card's bar for a month. A facturación splits its CLP facturado into the cuotas it bills
 * (`cuota_a_pagar_clp`, the plan schedule — the statement's billed cuotas) and the rest; a month
 * the plan only projects carries just what it will bill.
 */
function barForMonth(
  month: string,
  fact: CcFacturacionRow | undefined,
  detalle: CcBillingDetailMonthRow | undefined,
  hist: HistMonthPoint | undefined
): CcFacturadoBarSegments {
  if (fact) {
    const cuotas = fact.cuota_a_pagar_clp;
    if (cuotas != null && fact.facturado_clp == null) {
      throw new Error(`Historial ${month}: ${cuotas} of cuotas billed with no CLP facturado to hold them`);
    }
    return withTotal({
      facturado_cuotas_clp: cuotas,
      facturado_rest_clp: fact.facturado_clp != null ? fact.facturado_clp - (cuotas ?? 0) : null,
      facturado_usd_clp: fact.facturado_usd_clp,
      facturado_usd: fact.facturado_usd,
    });
  }
  if (detalle?.total_facturado_clp != null) {
    // Billing detail knows the month but facturaciones do not: an open month no line has landed
    // in yet (no statement, no bucket). With no lines there is nothing in dollars — its facturado
    // is the open-month estimate, the plan's cuotas plus any bucket únicos, all CLP.
    const cuotas = detalle.cuota_a_pagar_next_mes_clp > 0 ? detalle.cuota_a_pagar_next_mes_clp : null;
    return withTotal({
      facturado_cuotas_clp: cuotas,
      facturado_rest_clp: detalle.total_facturado_clp - (cuotas ?? 0),
      facturado_usd_clp: null,
      facturado_usd: null,
    });
  }
  const planned = detalle?.cuota_a_pagar_next_mes_clp ?? hist?.installment_payments_clp ?? 0;
  return planned > 0
    ? withTotal({
        facturado_cuotas_clp: planned,
        facturado_rest_clp: null,
        facturado_usd_clp: null,
        facturado_usd: null,
      })
    : NO_BAR;
}

function barOf(p: CcFacturadoBarSegments): CcFacturadoBarSegments {
  return {
    facturado_cuotas_clp: p.facturado_cuotas_clp,
    facturado_rest_clp: p.facturado_rest_clp,
    facturado_usd_clp: p.facturado_usd_clp,
    facturado_usd: p.facturado_usd,
    facturado_total_clp: p.facturado_total_clp,
  };
}

export type CcHistorialChartOptions = {
  /**
   * Both lines per chart month, read from the daily data (ascending months in; null = no data,
   * keep the billing frame): «saldo total» and «deuda en cuotas» on the month's last day, today
   * for the current month (`ccHistorialLinesAtMonthEndsClp`), so the monthly chart shows what the
   * daily chart shows on that day. The detalle table keeps the BILLING frame — a closed month's
   * billed cuotas ride inside its facturado, facturado + cupo = balance — while the daily line is
   * the PAYMENT frame, where a cycle's cuotas stay until that facturación is paid.
   */
  linesForMonths?: (
    months: readonly string[]
  ) => ReadonlyMap<string, { balance_clp: number | null; plan_debt_clp: number | null }> | null;
  /**
   * A group's member cards' own series: the group's bar for a month is the Σ of its cards' bars,
   * never split again from merged facturaciones — a month one card has billed (or opened) while
   * another only projects its plan has no merged facturación carrying the second card's cuotas.
   */
  memberSeries?: readonly (readonly CcHistorialChartPoint[])[];
};

/**
 * Dense historial chart series for the CC installment history chart.
 * Every interior month between min and max is included (null values for
 * missing data so the chart X-axis is continuous).
 */
export function buildCcHistorialChartSeries(
  hist: HistMonthPoint[],
  detalle: CcBillingDetailMonthRow[] | undefined,
  facturaciones: CcFacturacionRow[] | undefined,
  opts?: CcHistorialChartOptions
): CcHistorialChartPoint[] {
  const histByMonth = new Map(hist.map((h) => [h.month, h] as const));
  const detalleByMonth = new Map((detalle ?? []).map((d) => [d.billing_month, d] as const));
  const facturacionByMonth = new Map((facturaciones ?? []).map((f) => [f.billing_month, f] as const));

  const sparseMonths = collectHistorialBaseMonths(hist, detalle);
  if (sparseMonths.length === 0) return [];

  // Fill every interior month so the chart axis has no gaps
  const minYm = sparseMonths[0]!;
  const maxYm = sparseMonths[sparseMonths.length - 1]!;
  const allMonths = expandYearMonthsInclusive(minYm, maxYm);
  const linesByMonth = opts?.linesForMonths?.(allMonths) ?? null;

  let memberBarByMonth: Map<string, CcFacturadoBarSegments> | null = null;
  if (opts?.memberSeries) {
    memberBarByMonth = new Map();
    for (const series of opts.memberSeries) {
      for (const p of series) {
        if (p.facturado_total_clp == null) continue;
        memberBarByMonth.set(p.month, sumBars(memberBarByMonth.get(p.month), p));
      }
    }
    const inRange = new Set(allMonths);
    for (const month of memberBarByMonth.keys()) {
      if (!inRange.has(month)) {
        throw new Error(`Historial: a member card's ${month} bar lies outside the group's months ${minYm}..${maxYm}`);
      }
    }
  }

  return allMonths.map((month) => {
    const d = detalleByMonth.get(month);
    const h = histByMonth.get(month);
    const fact = facturacionByMonth.get(month);
    const facturadoTotal = fact
      ? (fact.facturado_total_clp ?? (fact.facturado_clp ?? 0) + (fact.facturado_usd_clp ?? 0))
      : null;
    // Billing frame: pairs with facturado for a month with no detail row's balance.
    const billingCupo = d?.cupo_en_cuotas_clp ?? (h != null ? cupoFromHistPoint(h) : null);
    const lines = linesByMonth?.get(month);
    const cupo = linesByMonth != null ? (lines?.plan_debt_clp ?? null) : billingCupo;
    let balance_total_clp = linesByMonth != null ? (lines?.balance_clp ?? null) : (d?.balance_total_clp ?? null);
    if (linesByMonth == null && balance_total_clp == null && billingCupo != null) {
      balance_total_clp = (facturadoTotal ?? 0) + billingCupo;
    }
    const bar = memberBarByMonth
      ? (memberBarByMonth.get(month) ?? NO_BAR)
      : barForMonth(month, fact, d, h);
    return {
      month,
      ...bar,
      cupo_en_cuotas_clp: cupo,
      balance_total_clp,
    };
  });
}

/**
 * The day-period historial's bars: each card's monthly bar on that card's close date, cards
 * closing the same day stacked together. The same per-card monthly series feeds the monthly
 * bars, so a card's facturación reads the same numbers in both grains.
 */
export function facturacionBarsOnCloseDates(
  cards: readonly {
    points: readonly CcHistorialChartPoint[];
    closeIsoForMonth: (billingMonth: string) => string;
  }[]
): CcFacturacionBarPoint[] {
  const byDate = new Map<string, CcFacturadoBarSegments>();
  for (const card of cards) {
    for (const p of card.points) {
      if (p.facturado_total_clp == null) continue;
      const date = card.closeIsoForMonth(p.month);
      const prev = byDate.get(date);
      byDate.set(date, prev ? sumBars(prev, p) : barOf(p));
    }
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([as_of_date, bar]) => ({ as_of_date, ...bar }));
}

// ─── Daily installment-debt series ────────────────────────────────────────────

/**
 * Plan debt («deuda en cuotas») per calendar day from signed events: +full contract value
 * on each purchase date (cupo consumed at purchase), −the facturación's billed cuotas on
 * their pay-by date (cuotas leave the debt when paid, not at the close that bills them).
 * Null before the first event (line not drawn); clamped at 0 — tiny end-of-schedule
 * residue from interest rounding must not draw a negative debt.
 */
export function buildCcInstallmentDebtDailySeries(
  datesAsc: readonly string[],
  events: readonly { iso: string; clp: number }[]
): (number | null)[] {
  const sorted = [...events].sort((a, b) => a.iso.localeCompare(b.iso));
  const firstIso = sorted[0]?.iso ?? null;
  let i = 0;
  let cum = 0;
  return datesAsc.map((d) => {
    while (i < sorted.length && sorted[i]!.iso <= d) {
      cum += sorted[i]!.clp;
      i++;
    }
    if (firstIso == null || d < firstIso) return null;
    return Math.max(0, Math.round(cum));
  });
}
