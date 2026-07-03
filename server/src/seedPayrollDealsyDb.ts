import { db } from "../src/db.js";
import {
  buildSyntheticDealsyRow,
  DEALSYTE_2019_H2_ROWS,
  DEALSYTE_2020_Q1_ROWS,
  DEALSYTE_2020_FULL_LIQUIDO_REFERENCE_CLP,
  resolveDescAfpFromCert,
  type SyntheticDealsyPayrollRow,
} from "../src/seedPayrollDealsySynthetic.js";

export const PAYROLL_SYNTHETIC_UPSERT_SQL = `
INSERT INTO payroll_work_earnings (
  period_month, employer_name, employer_rut, pay_period_label, earning_type,
  base_salary_clp, colacion_clp, movilizacion_clp, gratificacion_clp,
  total_imponible_clp, total_no_imponible_clp, total_haberes_clp,
  desc_afp_clp, desc_health_clp, desc_tax_clp, desc_cesantia_clp, desc_apv_clp, desc_other_clp,
  total_descuentos_clp, liquido, liquido_currency,
  uf_mes, utm_mes, tope_previsional_uf, tope_cesantia_uf,
  source_pdf, parse_version, movement_id, link_source
) VALUES (
  ?, ?, ?, ?, ?,
  ?, ?, ?, ?,
  ?, ?, ?,
  ?, ?, ?, ?, ?, ?,
  ?, ?, 'clp',
  ?, ?, ?, ?,
  ?, ?, ?, ?
)
ON CONFLICT(source_pdf) DO UPDATE SET
  period_month = excluded.period_month,
  employer_name = excluded.employer_name,
  employer_rut = excluded.employer_rut,
  pay_period_label = excluded.pay_period_label,
  earning_type = excluded.earning_type,
  base_salary_clp = excluded.base_salary_clp,
  colacion_clp = excluded.colacion_clp,
  movilizacion_clp = excluded.movilizacion_clp,
  gratificacion_clp = excluded.gratificacion_clp,
  total_imponible_clp = excluded.total_imponible_clp,
  total_no_imponible_clp = excluded.total_no_imponible_clp,
  total_haberes_clp = excluded.total_haberes_clp,
  desc_afp_clp = excluded.desc_afp_clp,
  desc_health_clp = excluded.desc_health_clp,
  desc_tax_clp = excluded.desc_tax_clp,
  desc_cesantia_clp = excluded.desc_cesantia_clp,
  desc_apv_clp = excluded.desc_apv_clp,
  desc_other_clp = excluded.desc_other_clp,
  total_descuentos_clp = excluded.total_descuentos_clp,
  liquido = excluded.liquido,
  liquido_currency = excluded.liquido_currency,
  uf_mes = excluded.uf_mes,
  utm_mes = excluded.utm_mes,
  tope_previsional_uf = excluded.tope_previsional_uf,
  tope_cesantia_uf = excluded.tope_cesantia_uf,
  parse_version = excluded.parse_version,
  imported_at = datetime('now'),
  movement_id = excluded.movement_id,
  link_source = excluded.link_source
`;

export function loadAfpCertMontoAlloc(periodMonth: string): number {
  const rows = db
    .prepare(`SELECT note FROM movements WHERE note LIKE ?`)
    .all(`%afp-cert:period=${periodMonth}%`) as { note: string }[];
  if (rows.length === 0) {
    throw new Error(`missing AFP cert movement for period ${periodMonth}`);
  }
  if (rows.length > 1) {
    throw new Error(`ambiguous AFP cert movements for period ${periodMonth}`);
  }
  const m = /cert_monto_alloc=([\d.]+)/.exec(rows[0]!.note);
  if (!m) {
    throw new Error(`missing cert_monto_alloc in AFP note for period ${periodMonth}`);
  }
  return Math.round(Number(m[1]));
}

export function loadUfMes(periodMonth: string): number {
  const row = db
    .prepare(
      `SELECT clp_per_uf FROM uf_daily
       WHERE date LIKE ? || '%'
       ORDER BY date DESC
       LIMIT 1`
    )
    .get(periodMonth) as { clp_per_uf: number } | undefined;
  if (!row) {
    throw new Error(`missing uf_daily for period ${periodMonth}`);
  }
  return row.clp_per_uf;
}

export function loadUtmMes(periodMonth: string): number {
  const row = db
    .prepare(
      `SELECT utm_clp FROM utm_daily
       WHERE date LIKE ? || '%'
       ORDER BY date ASC
       LIMIT 1`
    )
    .get(periodMonth) as { utm_clp: number } | undefined;
  if (!row) {
    throw new Error(`missing utm_daily for period ${periodMonth}`);
  }
  return row.utm_clp;
}

export function assertMovementMatchesLiquido(
  movementId: number,
  liquidoClp: number
): void {
  const row = db
    .prepare(`SELECT amount_clp FROM movements WHERE id = ?`)
    .get(movementId) as { amount_clp: number } | undefined;
  if (!row) {
    throw new Error(`movement ${movementId} not found`);
  }
  const amount = Math.round(row.amount_clp);
  if (amount !== liquidoClp) {
    throw new Error(
      `movement ${movementId} amount ${amount} !== líquido ${liquidoClp}`
    );
  }
}

type RowSpec = {
  period_month: string;
  movement_id: number;
  liquido_clp: number;
  partial_scale_from_liquido?: number;
  trust_low_afp_cert?: boolean;
};

function buildRowFromSpec(
  spec: RowSpec,
  afpHealthPoolMode: "fixed_2019" | "baseline_adjusted"
): SyntheticDealsyPayrollRow {
  assertMovementMatchesLiquido(spec.movement_id, spec.liquido_clp);
  const certMonto = loadAfpCertMontoAlloc(spec.period_month);
  const partialScale = spec.partial_scale_from_liquido;
  const scaledImponible = partialScale
    ? Math.round(2_182_146 * partialScale)
    : undefined;
  const desc_afp_clp = resolveDescAfpFromCert(
    certMonto,
    scaledImponible,
    spec.trust_low_afp_cert ? { trustLowCert: true } : undefined
  );

  let afpHealthPoolReferenceAfp = desc_afp_clp;
  if (partialScale) {
    const febCert = loadAfpCertMontoAlloc("2020-02");
    afpHealthPoolReferenceAfp = resolveDescAfpFromCert(febCert);
  }

  return buildSyntheticDealsyRow({
    period_month: spec.period_month,
    movement_id: spec.movement_id,
    liquido_clp: spec.liquido_clp,
    desc_afp_clp,
    uf_mes: loadUfMes(spec.period_month),
    utm_mes: loadUtmMes(spec.period_month),
    afp_health_pool_mode: afpHealthPoolMode,
    partial_scale: partialScale,
    afp_health_pool_reference_afp: afpHealthPoolReferenceAfp,
  });
}

export function buildDealsy2019H2RowsFromDb(): SyntheticDealsyPayrollRow[] {
  return DEALSYTE_2019_H2_ROWS.map((spec) =>
    buildRowFromSpec(spec, "fixed_2019")
  );
}

export function buildDealsy2020Q1RowsFromDb(): SyntheticDealsyPayrollRow[] {
  return DEALSYTE_2020_Q1_ROWS.map((spec) =>
    buildRowFromSpec(spec, "baseline_adjusted")
  );
}

export function upsertSyntheticPayrollRow(row: SyntheticDealsyPayrollRow): void {
  db.prepare(PAYROLL_SYNTHETIC_UPSERT_SQL).run(
    row.period_month,
    row.employer_name,
    row.employer_rut,
    row.pay_period_label,
    row.earning_type,
    row.base_salary_clp,
    row.colacion_clp,
    row.movilizacion_clp,
    row.gratificacion_clp,
    row.total_imponible_clp,
    row.total_no_imponible_clp,
    row.total_haberes_clp,
    row.desc_afp_clp,
    row.desc_health_clp,
    row.desc_tax_clp,
    row.desc_cesantia_clp,
    row.desc_apv_clp,
    row.desc_other_clp,
    row.total_descuentos_clp,
    row.liquido_clp,
    row.uf_mes,
    row.utm_mes,
    row.tope_previsional_uf,
    row.tope_cesantia_uf,
    row.source_pdf,
    row.parse_version,
    row.movement_id,
    row.link_source
  );
}

export { DEALSYTE_2020_FULL_LIQUIDO_REFERENCE_CLP };
