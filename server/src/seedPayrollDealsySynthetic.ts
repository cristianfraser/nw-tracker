export const DEALSYTE_EMPLOYER = {
  employer_name: "DEALSYTE CHILE SPA",
  employer_rut: "76871306-5",
} as const;

export const DEALSYTE_FULL_HABERES = {
  base_salary_clp: 2_063_000,
  colacion_clp: 200_000,
  movilizacion_clp: 200_000,
  gratificacion_clp: 119_146,
  total_imponible_clp: 2_182_146,
  total_no_imponible_clp: 400_000,
  total_haberes_clp: 2_582_146,
  desc_cesantia_clp: 13_093,
  imponible_clp: 2_182_146,
} as const;

/** Mar–May 2019 Dealsyte: AFP+health subtotal stays fixed while tax moves. */
export const DEALSYTE_2019_AFP_HEALTH_POOL_CLP = 387_767;

/** Baseline employee AFP (10% imponible) for pool adjustment in 2020+. */
export const DEALSYTE_BASELINE_AFP_CLP = 218_215;

export const DEALSYTE_MIN_RELIABLE_AFP_CERT_CLP = 100_000;
export const DEALSYTE_SYNTHETIC_PARSE_VERSION = "manual-reconstructed-v1";

/** Feb 2020 líquido — proxy for a full March when employment ended mid-month. */
export const DEALSYTE_2020_FULL_LIQUIDO_REFERENCE_CLP = 2_125_301;

export const DEALSYTE_2019_H2_ROWS = [
  { period_month: "2019-06", movement_id: 8334, liquido_clp: 2_123_338 },
  { period_month: "2019-07", movement_id: 8352, liquido_clp: 2_124_100 },
  { period_month: "2019-08", movement_id: 8360, liquido_clp: 2_124_100 },
  { period_month: "2019-09", movement_id: 8368, liquido_clp: 2_124_271 },
  { period_month: "2019-10", movement_id: 8373, liquido_clp: 2_124_441 },
  { period_month: "2019-11", movement_id: 8383, liquido_clp: 2_124_441 },
  { period_month: "2019-12", movement_id: 8389, liquido_clp: 2_125_127 },
] as const;

export const DEALSYTE_2020_Q1_ROWS = [
  { period_month: "2020-01", movement_id: 8399, liquido_clp: 2_125_214 },
  { period_month: "2020-02", movement_id: 8406, liquido_clp: 2_125_301 },
  {
    period_month: "2020-03",
    movement_id: 8977,
    liquido_clp: 167_139,
    partial_scale_from_liquido: 167_139 / DEALSYTE_2020_FULL_LIQUIDO_REFERENCE_CLP,
    trust_low_afp_cert: true,
  },
] as const;

const PAY_PERIOD_LABELS: Record<string, string> = {
  "2019-06": "JUNIO / 2019",
  "2019-07": "JULIO / 2019",
  "2019-08": "AGOSTO / 2019",
  "2019-09": "SEPTIEMBRE / 2019",
  "2019-10": "OCTUBRE / 2019",
  "2019-11": "NOVIEMBRE / 2019",
  "2019-12": "DICIEMBRE / 2019",
  "2020-01": "ENERO / 2020",
  "2020-02": "FEBRERO / 2020",
  "2020-03": "MARZO / 2020",
};

export type SyntheticDealsyPayrollRow = {
  period_month: string;
  employer_name: string;
  employer_rut: string;
  pay_period_label: string;
  earning_type: "salary";
  base_salary_clp: number;
  colacion_clp: number;
  movilizacion_clp: number;
  gratificacion_clp: number;
  total_imponible_clp: number;
  total_no_imponible_clp: number;
  total_haberes_clp: number;
  desc_afp_clp: number;
  desc_health_clp: number;
  desc_tax_clp: number;
  desc_cesantia_clp: number;
  desc_apv_clp: null;
  desc_other_clp: null;
  total_descuentos_clp: number;
  liquido_clp: number;
  uf_mes: number;
  utm_mes: number;
  tope_previsional_uf: null;
  tope_cesantia_uf: null;
  source_pdf: string;
  parse_version: string;
  movement_id: number;
  link_source: "manual";
};

export type AfpHealthPoolMode = "fixed_2019" | "baseline_adjusted";

function scaleClp(value: number, scale: number): number {
  return Math.round(value * scale);
}

export function afpHealthPoolForDescAfp(
  descAfpClp: number,
  mode: AfpHealthPoolMode
): number {
  if (mode === "fixed_2019") {
    return DEALSYTE_2019_AFP_HEALTH_POOL_CLP;
  }
  return (
    DEALSYTE_2019_AFP_HEALTH_POOL_CLP + (descAfpClp - DEALSYTE_BASELINE_AFP_CLP)
  );
}

export function resolveDescAfpFromCert(
  certMontoAlloc: number,
  imponibleClp: number = DEALSYTE_FULL_HABERES.imponible_clp,
  opts?: { trustLowCert?: boolean }
): number {
  if (opts?.trustLowCert && certMontoAlloc > 0) {
    return certMontoAlloc;
  }
  if (certMontoAlloc >= DEALSYTE_MIN_RELIABLE_AFP_CERT_CLP) {
    return certMontoAlloc;
  }
  return Math.round(imponibleClp * 0.1);
}

export function payPeriodLabelForDealsyMonth(periodMonth: string): string {
  const label = PAY_PERIOD_LABELS[periodMonth];
  if (!label) {
    throw new Error(`missing pay period label for ${periodMonth}`);
  }
  return label;
}

function sourcePdfForPeriod(periodMonth: string): string {
  const year = periodMonth.slice(0, 4);
  return `synthetic:liquidaciones/${year}/${periodMonth}.pdf`;
}

export function buildSyntheticDealsyRow(input: {
  period_month: string;
  movement_id: number;
  liquido_clp: number;
  desc_afp_clp: number;
  uf_mes: number;
  utm_mes: number;
  afp_health_pool_mode: AfpHealthPoolMode;
  partial_scale?: number;
  afp_health_pool_reference_afp?: number;
}): SyntheticDealsyPayrollRow {
  const h = DEALSYTE_FULL_HABERES;
  const scale = input.partial_scale ?? 1;

  const base_salary_clp = scaleClp(h.base_salary_clp, scale);
  const colacion_clp = scaleClp(h.colacion_clp, scale);
  const movilizacion_clp = scaleClp(h.movilizacion_clp, scale);
  const gratificacion_clp = scaleClp(h.gratificacion_clp, scale);
  const total_imponible_clp = scaleClp(h.total_imponible_clp, scale);
  const total_no_imponible_clp = scaleClp(h.total_no_imponible_clp, scale);
  const total_haberes_clp = scaleClp(h.total_haberes_clp, scale);

  const total_descuentos_clp = total_haberes_clp - input.liquido_clp;
  if (total_descuentos_clp < 0) {
    throw new Error(
      `${input.period_month}: líquido ${input.liquido_clp} exceeds haberes ${total_haberes_clp}`
    );
  }

  const desc_afp_clp = input.desc_afp_clp;
  const desc_cesantia_clp = scaleClp(h.desc_cesantia_clp, scale);

  const poolReferenceAfp =
    input.afp_health_pool_reference_afp ?? desc_afp_clp;
  let afpHealthPool = afpHealthPoolForDescAfp(
    poolReferenceAfp,
    input.afp_health_pool_mode
  );
  if (scale !== 1) {
    afpHealthPool = scaleClp(afpHealthPool, scale);
  }

  const desc_health_clp = afpHealthPool - desc_afp_clp;
  if (desc_health_clp <= 0) {
    throw new Error(
      `${input.period_month}: desc_health_clp must be positive, got ${desc_health_clp}`
    );
  }

  const desc_tax_clp =
    total_descuentos_clp - desc_cesantia_clp - desc_afp_clp - desc_health_clp;

  if (desc_tax_clp <= 0) {
    throw new Error(
      `${input.period_month}: desc_tax_clp must be positive, got ${desc_tax_clp}`
    );
  }

  const partsSum =
    desc_cesantia_clp + desc_afp_clp + desc_health_clp + desc_tax_clp;
  if (partsSum !== total_descuentos_clp) {
    throw new Error(
      `${input.period_month}: deduction parts sum ${partsSum} !== total ${total_descuentos_clp}`
    );
  }

  return {
    period_month: input.period_month,
    employer_name: DEALSYTE_EMPLOYER.employer_name,
    employer_rut: DEALSYTE_EMPLOYER.employer_rut,
    pay_period_label: payPeriodLabelForDealsyMonth(input.period_month),
    earning_type: "salary",
    base_salary_clp,
    colacion_clp,
    movilizacion_clp,
    gratificacion_clp,
    total_imponible_clp,
    total_no_imponible_clp,
    total_haberes_clp,
    desc_afp_clp,
    desc_health_clp,
    desc_tax_clp,
    desc_cesantia_clp,
    desc_apv_clp: null,
    desc_other_clp: null,
    total_descuentos_clp,
    liquido_clp: input.liquido_clp,
    uf_mes: input.uf_mes,
    utm_mes: input.utm_mes,
    tope_previsional_uf: null,
    tope_cesantia_uf: null,
    source_pdf: sourcePdfForPeriod(input.period_month),
    parse_version: DEALSYTE_SYNTHETIC_PARSE_VERSION,
    movement_id: input.movement_id,
    link_source: "manual",
  };
}

// Back-compat alias used by 2019 H2 tests/imports.
export const DEALSYTE_2019_H2_CONSTANTS = {
  ...DEALSYTE_EMPLOYER,
  ...DEALSYTE_FULL_HABERES,
  afp_health_pool_clp: DEALSYTE_2019_AFP_HEALTH_POOL_CLP,
  min_reliable_afp_cert_clp: DEALSYTE_MIN_RELIABLE_AFP_CERT_CLP,
  parse_version: DEALSYTE_SYNTHETIC_PARSE_VERSION,
} as const;
