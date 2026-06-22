import type { DeptoMortgageSheetRow } from "./deptoDividendosLedger.js";
import { ufRowOnOrBefore } from "./fxRates.js";

export const MORTGAGE_ANNUAL_RATE = 0.0495;
export const MORTGAGE_NOMINAL_RATE_PCT = 4.95;

export function mortgageMonthlyRateCompound(): number {
  return Math.pow(1 + MORTGAGE_ANNUAL_RATE, 1 / 12) - 1;
}

export function roundUf4(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}

export type MortgageAnalyticsMeta = {
  hipoteca_tras_pie_uf: number | null;
  pie_restante_clp: number | null;
};

function ufClpDayForRow(row: DeptoMortgageSheetRow): number | null {
  if (row.uf_clp_day != null && Number.isFinite(row.uf_clp_day)) return row.uf_clp_day;
  return ufRowOnOrBefore(row.occurred_on)?.clp_per_uf ?? null;
}

function numericCuota(cuota: string): number | null {
  const n = parseInt(String(cuota).trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function balanceUfBeforePayment(row: DeptoMortgageSheetRow): number | null {
  const after = row.credito_restante_uf;
  if (after == null || !Number.isFinite(after)) return null;
  const amort = (row.amortizacion_uf ?? 0) + (row.amortizacion_ext_uf ?? 0);
  return roundUf4(after + amort);
}

export function formatSheetPercent(n: number): string {
  const formatted = new Intl.NumberFormat("es-CL", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(n);
  return `${formatted}\u00a0%`;
}

export function formatAmortInteresText(ratio: number): string {
  return new Intl.NumberFormat("es-CL", {
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  }).format(ratio);
}

function rowForNumericCuota(
  ledger: readonly DeptoMortgageSheetRow[],
  cuotaNum: number
): DeptoMortgageSheetRow | null {
  const key = String(cuotaNum);
  return ledger.find((r) => r.cuota === key) ?? null;
}

function percentChange(current: number, prior: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(prior) || prior <= 0) return null;
  return ((current / prior - 1) * 100);
}

export function computeMortgagePaymentAnalytics(
  row: DeptoMortgageSheetRow,
  prior: DeptoMortgageSheetRow | null,
  ledger: readonly DeptoMortgageSheetRow[],
  meta: MortgageAnalyticsMeta
): Pick<
  DeptoMortgageSheetRow,
  | "pct_dividendo"
  | "mm_pct"
  | "yy_pct"
  | "tasa_plus"
  | "pct_credito_uf"
  | "pct_de_total"
  | "interes_oculto_clp"
  | "interes_oculto_b_clp"
  | "interes_real_clp"
  | "interes_calculado_uf"
  | "amort_interes_text"
  | "delta_credito_amort_clp"
> {
  const ufDay = ufClpDayForRow(row);
  const balanceBefore = balanceUfBeforePayment(row);

  let pct_dividendo: string | null = null;
  if (row.pago_uf != null && balanceBefore != null && balanceBefore > 0) {
    pct_dividendo = formatSheetPercent((row.pago_uf / balanceBefore) * 100);
  }

  let mm_pct: string | null = null;
  const priorUfDay = prior != null ? ufClpDayForRow(prior) : null;
  if (ufDay != null && priorUfDay != null) {
    const mm = percentChange(ufDay, priorUfDay);
    if (mm != null) mm_pct = formatSheetPercent(mm);
  }

  let yy_pct: string | null = null;
  let yyNumeric: number | null = null;
  const cuotaNum = numericCuota(row.cuota);
  if (ufDay != null && cuotaNum != null && cuotaNum > 12) {
    const yearAgo = rowForNumericCuota(ledger, cuotaNum - 12);
    const yearAgoUf = yearAgo != null ? ufClpDayForRow(yearAgo) : null;
    if (yearAgoUf != null) {
      const yy = percentChange(ufDay, yearAgoUf);
      if (yy != null) {
        yyNumeric = yy;
        yy_pct = formatSheetPercent(yy);
      }
    }
  }

  let tasa_plus: number | null = null;
  if (yyNumeric != null) {
    tasa_plus = Math.round((yyNumeric + MORTGAGE_NOMINAL_RATE_PCT) * 100) / 100;
  }

  let pct_credito_uf: string | null = null;
  if (
    row.credito_restante_uf != null &&
    meta.hipoteca_tras_pie_uf != null &&
    meta.hipoteca_tras_pie_uf > 0
  ) {
    pct_credito_uf = formatSheetPercent(
      (row.credito_restante_uf / meta.hipoteca_tras_pie_uf) * 100
    );
  }

  let pct_de_total: string | null = null;
  if (
    row.restante_clp != null &&
    meta.pie_restante_clp != null &&
    meta.pie_restante_clp > 0
  ) {
    pct_de_total = formatSheetPercent((row.restante_clp / meta.pie_restante_clp) * 100);
  }

  let interes_calculado_uf: number | null = null;
  const balanceForReferenceInterest =
    prior?.credito_restante_uf != null && prior.credito_restante_uf > 0
      ? roundUf4(prior.credito_restante_uf)
      : balanceBefore;
  if (balanceForReferenceInterest != null && balanceForReferenceInterest > 0) {
    interes_calculado_uf = roundUf4(
      balanceForReferenceInterest * mortgageMonthlyRateCompound()
    );
  }

  const amortTotalClp = (row.amortizacion_clp ?? 0) + (row.amortizacion_ext_clp ?? 0);
  const delta_credito_amort_clp =
    prior?.restante_clp != null && row.restante_clp != null
      ? prior.restante_clp - row.restante_clp
      : null;

  let interes_oculto_clp: number | null = null;
  if (delta_credito_amort_clp != null) {
    interes_oculto_clp = amortTotalClp - delta_credito_amort_clp;
  }

  const interes_oculto_b_clp =
    interes_oculto_clp != null ? -interes_oculto_clp : null;

  const interes_real_clp =
    row.interes_clp != null && interes_oculto_clp != null
      ? row.interes_clp + interes_oculto_clp
      : null;

  let amort_interes_text: string | null = null;
  const interesUf =
    row.interes_uf != null && row.interes_uf > 0
      ? row.interes_uf
      : ufDay != null && ufDay > 0 && row.interes_clp != null && row.interes_clp > 0
        ? row.interes_clp / ufDay
        : null;
  const amortUfTotal = (row.amortizacion_uf ?? 0) + (row.amortizacion_ext_uf ?? 0);
  if (interesUf != null && interesUf > 0 && amortUfTotal > 0) {
    amort_interes_text = formatAmortInteresText(amortUfTotal / interesUf);
  }

  return {
    pct_dividendo,
    mm_pct,
    yy_pct,
    tasa_plus,
    pct_credito_uf,
    pct_de_total,
    interes_oculto_clp,
    interes_oculto_b_clp,
    interes_real_clp,
    interes_calculado_uf,
    amort_interes_text,
    delta_credito_amort_clp,
  };
}

export function mortgageAnalyticsMetaFromLedger(
  ledger: readonly DeptoMortgageSheetRow[]
): MortgageAnalyticsMeta {
  const pie = ledger.find((r) => r.cuota.toLowerCase() === "pie");
  return {
    hipoteca_tras_pie_uf: pie?.credito_restante_uf ?? null,
    pie_restante_clp: pie?.restante_clp ?? null,
  };
}
