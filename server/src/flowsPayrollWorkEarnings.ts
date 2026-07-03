import { db } from "./db.js";

export type PayrollEarningType = "salary" | "severance";

export type FlowWorkEarningRow = {
  id: number;
  period_month: string;
  employer_name: string;
  employer_rut: string | null;
  pay_period_label: string | null;
  earning_type: PayrollEarningType;
  base_salary_clp: number | null;
  colacion_clp: number | null;
  movilizacion_clp: number | null;
  gratificacion_clp: number | null;
  total_imponible_clp: number | null;
  total_no_imponible_clp: number | null;
  total_haberes_clp: number | null;
  desc_afp_clp: number | null;
  desc_health_clp: number | null;
  desc_tax_clp: number | null;
  desc_cesantia_clp: number | null;
  desc_apv_clp: number | null;
  desc_other_clp: number | null;
  total_descuentos_clp: number | null;
  liquido_clp: number;
  liquido_usd: number | null;
  wire_received_on: string | null;
  uf_mes: number | null;
  utm_mes: number | null;
  tope_previsional_uf: number | null;
  tope_cesantia_uf: number | null;
  source_pdf: string;
  movement_id: number | null;
  link_source: "auto" | "manual" | null;
  linked_received_on: string | null;
  linked_amount_clp: number | null;
  linked_account_label: string | null;
};

type DbPayrollRow = {
  id: number;
  period_month: string;
  employer_name: string;
  employer_rut: string | null;
  pay_period_label: string | null;
  earning_type: PayrollEarningType;
  base_salary_clp: number | null;
  colacion_clp: number | null;
  movilizacion_clp: number | null;
  gratificacion_clp: number | null;
  total_imponible_clp: number | null;
  total_no_imponible_clp: number | null;
  total_haberes_clp: number | null;
  desc_afp_clp: number | null;
  desc_health_clp: number | null;
  desc_tax_clp: number | null;
  desc_cesantia_clp: number | null;
  desc_apv_clp: number | null;
  desc_other_clp: number | null;
  total_descuentos_clp: number | null;
  liquido: number;
  liquido_currency: string;
  wire_received_on: string | null;
  uf_mes: number | null;
  utm_mes: number | null;
  tope_previsional_uf: number | null;
  tope_cesantia_uf: number | null;
  source_pdf: string;
  movement_id: number | null;
  link_source: "auto" | "manual" | null;
  linked_received_on: string | null;
  linked_amount_clp: number | null;
  linked_account_label: string | null;
};

export function loadPayrollWorkEarnings(): FlowWorkEarningRow[] {
  const rows = db
    .prepare(
      `SELECT
         p.id, p.period_month, p.employer_name, p.employer_rut, p.pay_period_label,
         p.earning_type,
         p.base_salary_clp, p.colacion_clp, p.movilizacion_clp, p.gratificacion_clp,
         p.total_imponible_clp, p.total_no_imponible_clp, p.total_haberes_clp,
         p.desc_afp_clp, p.desc_health_clp, p.desc_tax_clp, p.desc_cesantia_clp,
         p.desc_apv_clp, p.desc_other_clp, p.total_descuentos_clp, p.liquido,
         p.liquido_currency, p.wire_received_on,
         p.uf_mes, p.utm_mes, p.tope_previsional_uf, p.tope_cesantia_uf,
         p.source_pdf, p.movement_id, p.link_source,
         m.occurred_on AS linked_received_on,
         m.amount_clp AS linked_amount_clp,
         a.name AS linked_account_label
       FROM payroll_work_earnings p
       LEFT JOIN movements m ON m.id = p.movement_id
       LEFT JOIN accounts a ON a.id = m.account_id
       ORDER BY p.period_month DESC, p.id DESC`
    )
    .all() as DbPayrollRow[];

  return rows.map((row) => {
    const { liquido, liquido_currency, ...rest } = row;
    let liquido_clp: number;
    let liquido_usd: number | null;
    if (liquido_currency === "clp") {
      liquido_clp = Math.round(liquido);
      liquido_usd = null;
    } else if (liquido_currency === "usd") {
      // USD-native líquido (Deel): the CLP equivalent is the stored CLP breakdown
      // (haberes/descuentos converted at the wire date when the row was written), so
      // haberes − descuentos keeps the líquido identity exact — no fx call at read.
      if (row.total_haberes_clp == null || row.total_descuentos_clp == null) {
        throw new Error(
          `work earning ${row.id}: usd líquido without CLP haberes/descuentos breakdown`
        );
      }
      liquido_usd = liquido;
      liquido_clp = Math.round(row.total_haberes_clp - row.total_descuentos_clp);
    } else {
      throw new Error(`work earning ${row.id}: unexpected liquido_currency ${liquido_currency}`);
    }
    return {
      ...rest,
      liquido_clp,
      liquido_usd,
      linked_amount_clp:
        row.linked_amount_clp == null ? null : Math.round(row.linked_amount_clp),
    };
  });
}

export function incomeKindByMovementId(): Map<number, PayrollEarningType> {
  const rows = db
    .prepare(
      `SELECT movement_id, earning_type
       FROM payroll_work_earnings
       WHERE movement_id IS NOT NULL`
    )
    .all() as { movement_id: number; earning_type: PayrollEarningType }[];

  const out = new Map<number, PayrollEarningType>();
  for (const row of rows) {
    out.set(row.movement_id, row.earning_type);
  }
  return out;
}

export function incomeKindByMovementIdRecord(): Record<number, PayrollEarningType> {
  const out: Record<number, PayrollEarningType> = {};
  for (const [movementId, kind] of incomeKindByMovementId()) {
    out[movementId] = kind;
  }
  return out;
}

export function payrollPeriodByMovementIdRecord(): Record<number, string> {
  const rows = db
    .prepare(
      `SELECT movement_id, period_month
       FROM payroll_work_earnings
       WHERE movement_id IS NOT NULL`
    )
    .all() as { movement_id: number; period_month: string }[];

  const out: Record<number, string> = {};
  for (const row of rows) {
    out[row.movement_id] = row.period_month;
  }
  return out;
}

export function getPayrollWorkEarningById(id: number): FlowWorkEarningRow | null {
  const rows = loadPayrollWorkEarnings();
  return rows.find((r) => r.id === id) ?? null;
}

export function updatePayrollWorkEarning(
  id: number,
  patch: {
    earning_type?: PayrollEarningType;
    movement_id?: number | null;
  }
): FlowWorkEarningRow {
  const existing = db
    .prepare(`SELECT id, link_source FROM payroll_work_earnings WHERE id = ?`)
    .get(id) as { id: number; link_source: string | null } | undefined;
  if (!existing) {
    throw new Error(`payroll work earning ${id} not found`);
  }

  if (patch.movement_id !== undefined && patch.movement_id != null) {
    const taken = db
      .prepare(
        `SELECT id FROM payroll_work_earnings WHERE movement_id = ? AND id != ?`
      )
      .get(patch.movement_id, id) as { id: number } | undefined;
    if (taken) {
      throw new Error(
        `movement ${patch.movement_id} already linked to payroll work earning ${taken.id}`
      );
    }
  }

  const sets: string[] = [];
  const values: unknown[] = [];

  if (patch.earning_type != null) {
    sets.push("earning_type = ?");
    values.push(patch.earning_type);
  }
  if (patch.movement_id !== undefined) {
    sets.push("movement_id = ?");
    values.push(patch.movement_id);
    sets.push("link_source = ?");
    values.push(patch.movement_id == null ? null : "manual");
  }

  if (sets.length === 0) {
    const row = getPayrollWorkEarningById(id);
    if (!row) throw new Error(`payroll work earning ${id} not found`);
    return row;
  }

  db.prepare(
    `UPDATE payroll_work_earnings SET ${sets.join(", ")} WHERE id = ?`
  ).run(...values, id);

  const row = getPayrollWorkEarningById(id);
  if (!row) throw new Error(`payroll work earning ${id} not found after update`);
  return row;
}
