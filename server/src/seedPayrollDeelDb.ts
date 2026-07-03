import { db } from "./db.js";
import { upsertCheckingIncomeMovementOverride } from "./flowsCheckingIncomeOverrides.js";
import {
  buildDeel2021H1Rows,
  DEEL_2021_EXCLUDED_CHECKING_INCOME_MOVEMENT_IDS,
  type SyntheticDeelUsdPayrollRow,
} from "./seedPayrollDeelUsdSynthetic.js";

export const PAYROLL_DEEL_USD_UPSERT_SQL = `
INSERT INTO payroll_work_earnings (
  period_month, employer_name, employer_rut, pay_period_label, earning_type,
  base_salary_clp, colacion_clp, movilizacion_clp, gratificacion_clp,
  total_imponible_clp, total_no_imponible_clp, total_haberes_clp,
  desc_afp_clp, desc_health_clp, desc_tax_clp, desc_cesantia_clp, desc_apv_clp, desc_other_clp,
  total_descuentos_clp, liquido, liquido_currency, wire_received_on,
  uf_mes, utm_mes, tope_previsional_uf, tope_cesantia_uf,
  source_pdf, parse_version, movement_id, link_source
) VALUES (
  ?, ?, ?, ?, ?,
  ?, ?, ?, ?,
  ?, ?, ?,
  ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?,
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
  wire_received_on = excluded.wire_received_on,
  uf_mes = excluded.uf_mes,
  utm_mes = excluded.utm_mes,
  tope_previsional_uf = excluded.tope_previsional_uf,
  tope_cesantia_uf = excluded.tope_cesantia_uf,
  parse_version = excluded.parse_version,
  imported_at = datetime('now'),
  movement_id = excluded.movement_id,
  link_source = excluded.link_source
`;

export function upsertSyntheticDeelUsdPayrollRow(row: SyntheticDeelUsdPayrollRow): void {
  db.prepare(PAYROLL_DEEL_USD_UPSERT_SQL).run(
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
    row.liquido,
    row.liquido_currency,
    row.wire_received_on,
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

export function excludeDeelFxCheckingIncomeMovement(movementId: number): void {
  upsertCheckingIncomeMovementOverride(movementId, {
    excluded: true,
    note: "auto:deel-usd-fx|not separate income",
  });
}

export function seedDeel2021H1PayrollAndExclusions(): {
  payroll_rows: SyntheticDeelUsdPayrollRow[];
  excluded_movement_ids: number[];
} {
  const payroll_rows = buildDeel2021H1Rows();
  for (const row of payroll_rows) {
    upsertSyntheticDeelUsdPayrollRow(row);
  }

  const excluded_movement_ids: number[] = [];
  for (const movementId of DEEL_2021_EXCLUDED_CHECKING_INCOME_MOVEMENT_IDS) {
    excludeDeelFxCheckingIncomeMovement(movementId);
    excluded_movement_ids.push(movementId);
  }

  return { payroll_rows, excluded_movement_ids };
}
