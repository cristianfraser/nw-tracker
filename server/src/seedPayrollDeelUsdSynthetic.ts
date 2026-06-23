import { usdToClpAtPaymentRounded } from "./fxRates.js";

export const DEEL_EMPLOYER_NAME = "Deel (USD wire)";

export const DEEL_GROSS_USD_FULL_MONTH = 4500;
export const DEEL_WIRE_FEE_USD = 50;
export const DEEL_SYNTHETIC_PARSE_VERSION = "manual-usd-wire-v1";

/** Employment started 2021-01-14; August 2021 was two worked weeks only. */
export const DEEL_2021_JAN_PARTIAL_SCALE = 18 / 31;
export const DEEL_2021_AUG_PARTIAL_SCALE = 0.5;

export type SyntheticDeelUsdPayrollRow = {
  period_month: string;
  employer_name: string;
  employer_rut: null;
  pay_period_label: string;
  earning_type: "salary";
  base_salary_clp: null;
  colacion_clp: null;
  movilizacion_clp: null;
  gratificacion_clp: null;
  total_imponible_clp: null;
  total_no_imponible_clp: null;
  total_haberes_clp: number;
  desc_afp_clp: null;
  desc_health_clp: null;
  desc_tax_clp: null;
  desc_cesantia_clp: null;
  desc_apv_clp: null;
  desc_other_clp: number;
  total_descuentos_clp: number;
  liquido_clp: number;
  liquido_usd: number;
  wire_received_on: string;
  uf_mes: null;
  utm_mes: null;
  tope_previsional_uf: null;
  tope_cesantia_uf: null;
  source_pdf: string;
  parse_version: string;
  movement_id: null;
  link_source: "manual";
};

const PAY_PERIOD_LABELS: Record<string, string> = {
  "2021-01": "ENERO / 2021",
  "2021-02": "FEBRERO / 2021",
  "2021-03": "MARZO / 2021",
  "2021-04": "ABRIL / 2021",
  "2021-05": "MAYO / 2021",
  "2021-06": "JUNIO / 2021",
  "2021-07": "JULIO / 2021",
  "2021-08": "AGOSTO / 2021",
};

export const DEEL_2021_H1_SPECS = [
  {
    period_month: "2021-01",
    gross_scale: DEEL_2021_JAN_PARTIAL_SCALE,
    wire_received_on: "2021-01-20",
  },
  { period_month: "2021-02", gross_scale: 1, wire_received_on: "2021-02-08" },
  { period_month: "2021-03", gross_scale: 1, wire_received_on: "2021-03-08" },
  { period_month: "2021-04", gross_scale: 1, wire_received_on: "2021-04-08" },
  { period_month: "2021-05", gross_scale: 1, wire_received_on: "2021-05-08" },
  { period_month: "2021-06", gross_scale: 1, wire_received_on: "2021-06-08" },
  { period_month: "2021-07", gross_scale: 1, wire_received_on: "2021-07-08" },
  {
    period_month: "2021-08",
    gross_scale: DEEL_2021_AUG_PARTIAL_SCALE,
    wire_received_on: "2021-08-08",
  },
] as const;

/**
 * Cartola credits that are CLP from selling Deel USD — not separate income.
 * `link_source=manual` exclusions are not overwritten by payroll import.
 */
export const DEEL_2021_EXCLUDED_CHECKING_INCOME_MOVEMENT_IDS = [
  7529, // Feb Depósito en Efectivo
  7533, // Feb Depósito en Efectivo (main FX)
  7802, // Mar SOCIEDAD AD (partial FX)
  7811, // Mar Depósito en Efectivo
  7332, // Apr Depósito en Efectivo
  7829, // May Venta Moneda Extranjera
  7363, // Jun PST PAGO FACIL (wire landing / FX)
  7374, // Jul Depósito en Efectivo
  7383, // Aug Depósito en Efectivo
] as const;

export function sourcePdfForDeelPeriod(periodMonth: string): string {
  return `synthetic:deel-usd|${periodMonth}`;
}

export function deelNetUsdForGrossScale(grossScale: number): number {
  if (grossScale <= 0 || grossScale > 1) {
    throw new Error(`invalid Deel gross scale: ${grossScale}`);
  }
  const grossUsd = DEEL_GROSS_USD_FULL_MONTH * grossScale;
  const netUsd = grossUsd - DEEL_WIRE_FEE_USD;
  if (netUsd <= 0) {
    throw new Error(`Deel net USD must be positive, got ${netUsd} (scale=${grossScale})`);
  }
  return Math.round(netUsd * 100) / 100;
}

export function buildSyntheticDeelUsdRow(spec: {
  period_month: string;
  gross_scale: number;
  wire_received_on: string;
}): SyntheticDeelUsdPayrollRow {
  const payPeriodLabel = PAY_PERIOD_LABELS[spec.period_month];
  if (!payPeriodLabel) {
    throw new Error(`missing pay period label for ${spec.period_month}`);
  }

  const grossUsd = DEEL_GROSS_USD_FULL_MONTH * spec.gross_scale;
  const liquido_usd = deelNetUsdForGrossScale(spec.gross_scale);
  const feeUsd = DEEL_WIRE_FEE_USD;

  const total_haberes_clp = usdToClpAtPaymentRounded(grossUsd, spec.wire_received_on);
  const desc_other_clp = usdToClpAtPaymentRounded(feeUsd, spec.wire_received_on);

  if (total_haberes_clp == null || desc_other_clp == null) {
    throw new Error(
      `${spec.period_month}: missing fx_daily for wire date ${spec.wire_received_on}`
    );
  }

  const total_descuentos_clp = desc_other_clp;
  const liquido_clp = Math.round(total_haberes_clp - total_descuentos_clp);
  if (liquido_clp <= 0) {
    throw new Error(`${spec.period_month}: liquido_clp must be positive, got ${liquido_clp}`);
  }

  return {
    period_month: spec.period_month,
    employer_name: DEEL_EMPLOYER_NAME,
    employer_rut: null,
    pay_period_label: payPeriodLabel,
    earning_type: "salary",
    base_salary_clp: null,
    colacion_clp: null,
    movilizacion_clp: null,
    gratificacion_clp: null,
    total_imponible_clp: null,
    total_no_imponible_clp: null,
    total_haberes_clp,
    desc_afp_clp: null,
    desc_health_clp: null,
    desc_tax_clp: null,
    desc_cesantia_clp: null,
    desc_apv_clp: null,
    desc_other_clp,
    total_descuentos_clp,
    liquido_clp,
    liquido_usd,
    wire_received_on: spec.wire_received_on,
    uf_mes: null,
    utm_mes: null,
    tope_previsional_uf: null,
    tope_cesantia_uf: null,
    source_pdf: sourcePdfForDeelPeriod(spec.period_month),
    parse_version: DEEL_SYNTHETIC_PARSE_VERSION,
    movement_id: null,
    link_source: "manual",
  };
}

export function buildDeel2021H1Rows(): SyntheticDeelUsdPayrollRow[] {
  return DEEL_2021_H1_SPECS.map((spec) => buildSyntheticDeelUsdRow(spec));
}
