/**
 * `employment.payslips` → `payroll_work_earnings`, each payslip paired with the checking deposit
 * that paid it (formerly `server/scripts/import-payroll-liquidaciones.ts`).
 *
 * A payslip is keyed by its document (`source_pdf`): a re-import updates the printed fields and
 * keeps a hand-made pairing (`link_source = 'manual'`) and the earning type set with it. Pairing
 * (`findPayrollAutoLinkMovement`) runs over the whole set in the order sent, so a deposit already
 * taken — by hand, or by an earlier payslip of the set — is never taken twice. A payslip no
 * deposit pays (or several could) is reported; it stays stored unpaired. Its printed lines
 * (`payslip_lines`) are replaced as a whole on every import.
 */
import type { EmploymentPayslipsApplyDetails, EmploymentPayslipsPayload, Payslip, PayslipLine } from "nw-tracker-contracts";
import { db } from "./db.js";
import { findPayrollAutoLinkMovement, listPayrollLinkCandidates } from "./payrollWorkEarningsLinking.js";

const UPSERT_SQL = `
INSERT INTO payroll_work_earnings (
  period_month, employer_name, employer_rut, pay_period_label, earning_type,
  base_salary_clp, colacion_clp, movilizacion_clp, gratificacion_clp,
  total_imponible_clp, total_no_imponible_clp, total_haberes_clp,
  desc_afp_clp, desc_health_clp, desc_tax_clp, desc_cesantia_clp, desc_apv_clp, desc_other_clp,
  total_descuentos_clp, liquido, liquido_currency,
  uf_mes, utm_mes, tope_previsional_uf, tope_cesantia_uf,
  source_pdf, parse_version, movement_id, link_source
) VALUES (
  @period_month, @employer_name, @employer_rut, @pay_period_label, @earning_type,
  @base_salary_clp, @colacion_clp, @movilizacion_clp, @gratificacion_clp,
  @total_imponible_clp, @total_no_imponible_clp, @total_haberes_clp,
  @desc_afp_clp, @desc_health_clp, @desc_tax_clp, @desc_cesantia_clp, @desc_apv_clp, @desc_other_clp,
  @total_descuentos_clp, @liquido, 'clp',
  @uf_mes, @utm_mes, @tope_previsional_uf, @tope_cesantia_uf,
  @source_pdf, @parse_version, NULL, NULL
)
ON CONFLICT(source_pdf) DO UPDATE SET
  period_month = excluded.period_month,
  employer_name = excluded.employer_name,
  employer_rut = excluded.employer_rut,
  pay_period_label = excluded.pay_period_label,
  earning_type = CASE
    WHEN payroll_work_earnings.link_source = 'manual' THEN payroll_work_earnings.earning_type
    ELSE excluded.earning_type
  END,
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
  movement_id = CASE
    WHEN payroll_work_earnings.link_source = 'manual' THEN payroll_work_earnings.movement_id
    ELSE excluded.movement_id
  END,
  link_source = CASE
    WHEN payroll_work_earnings.link_source = 'manual' THEN payroll_work_earnings.link_source
    ELSE excluded.link_source
  END
`;

/** A payslip as the table's columns (the `liquido` column holds the net pay). */
function payslipRow(p: Payslip, parserVersion: string) {
  return {
    period_month: p.period_month,
    employer_name: p.employer.name,
    employer_rut: p.employer.rut,
    pay_period_label: p.pay_period_label,
    earning_type: p.kind,
    base_salary_clp: p.earnings.base_salary,
    colacion_clp: p.earnings.meal_allowance,
    movilizacion_clp: p.earnings.transport_allowance,
    gratificacion_clp: p.earnings.bonus,
    total_imponible_clp: p.earnings.taxable_total,
    total_no_imponible_clp: p.earnings.non_taxable_total,
    total_haberes_clp: p.earnings.total,
    desc_afp_clp: p.deductions.pension,
    desc_health_clp: p.deductions.health,
    desc_tax_clp: p.deductions.income_tax,
    desc_cesantia_clp: p.deductions.unemployment_insurance,
    desc_apv_clp: p.deductions.voluntary_pension,
    desc_other_clp: p.deductions.other,
    total_descuentos_clp: p.deductions.total,
    liquido: p.net_pay,
    uf_mes: p.indices.uf,
    utm_mes: p.indices.utm,
    tope_previsional_uf: p.indices.pension_cap_uf,
    tope_cesantia_uf: p.indices.unemployment_cap_uf,
    source_pdf: p.document,
    parse_version: parserVersion,
  };
}

/** Columns a re-import overwrites (compared in a dry run). */
const COMPARED = [
  "period_month",
  "employer_name",
  "employer_rut",
  "pay_period_label",
  "base_salary_clp",
  "colacion_clp",
  "movilizacion_clp",
  "gratificacion_clp",
  "total_imponible_clp",
  "total_no_imponible_clp",
  "total_haberes_clp",
  "desc_afp_clp",
  "desc_health_clp",
  "desc_tax_clp",
  "desc_cesantia_clp",
  "desc_apv_clp",
  "desc_other_clp",
  "total_descuentos_clp",
  "liquido",
  "uf_mes",
  "utm_mes",
  "tope_previsional_uf",
  "tope_cesantia_uf",
] as const;

type StoredLine = Pick<PayslipLine, "position" | "side" | "section" | "label" | "amount">;

function lineKey(l: StoredLine): string {
  return `${l.position}|${l.side}|${l.section ?? ""}|${l.label}|${l.amount}`;
}

export function applyEmploymentPayslips(payload: EmploymentPayslipsPayload): EmploymentPayslipsApplyDetails {
  const dryRun = !payload.apply;
  const selectStored = db.prepare(`SELECT * FROM payroll_work_earnings WHERE source_pdf = ?`);
  const upsert = db.prepare(UPSERT_SQL);
  const selectLines = db.prepare(
    `SELECT position, side, section, label, amount FROM payslip_lines WHERE payslip_id = ? ORDER BY position`
  );
  const deleteLines = db.prepare(`DELETE FROM payslip_lines WHERE payslip_id = ?`);
  const insertLine = db.prepare(
    `INSERT INTO payslip_lines (payslip_id, position, side, section, label, amount) VALUES (?, ?, ?, ?, ?, ?)`
  );
  const setLink = db.prepare(`UPDATE payroll_work_earnings SET movement_id = ?, link_source = 'auto' WHERE source_pdf = ?`);

  const changes: string[] = [];
  if (dryRun) {
    for (const p of payload.payslips) {
      const stored = selectStored.get(p.document) as Record<string, unknown> | undefined;
      if (!stored) {
        changes.push(`new ${p.document}`);
        continue;
      }
      const next = payslipRow(p, payload.parser_version);
      const diff = COMPARED.filter((f) => stored[f] !== (next[f] ?? null)).map(
        (f) => `${f} ${String(stored[f])} → ${String(next[f] ?? null)}`
      );
      if (diff.length > 0) changes.push(`change ${p.document}: ${diff.join("; ")}`);
      const storedLines = (selectLines.all(stored.id) as StoredLine[]).map(lineKey).join("\n");
      if (storedLines !== p.lines.map(lineKey).join("\n")) {
        changes.push(`lines ${p.document}: ${storedLines === "" ? "none stored" : "differ"} → ${p.lines.length} line(s)`);
      }
    }
  }

  const candidates = listPayrollLinkCandidates();
  const taken = new Set<number>(
    (
      db
        .prepare(`SELECT movement_id FROM payroll_work_earnings WHERE movement_id IS NOT NULL AND link_source = 'manual'`)
        .all() as { movement_id: number }[]
    ).map((r) => r.movement_id)
  );
  const details: EmploymentPayslipsApplyDetails = {
    applied: !dryRun,
    payslips: payload.payslips.length,
    linked: 0,
    links: [],
    unmatched: [],
    ambiguous: [],
    changes,
  };

  db.transaction(() => {
    for (const p of payload.payslips) {
      if (!dryRun) upsert.run(payslipRow(p, payload.parser_version));
      const stored = selectStored.get(p.document) as
        | { id: number; movement_id: number | null; link_source: string | null }
        | undefined;
      if (!dryRun) {
        if (!stored) throw new Error(`payslips: ${p.document} not stored after the upsert`);
        deleteLines.run(stored.id);
        for (const l of p.lines) insertLine.run(stored.id, l.position, l.side, l.section, l.label, l.amount);
      }
      if (stored?.link_source === "manual" && stored.movement_id != null) {
        taken.add(stored.movement_id);
        details.linked += 1;
        continue;
      }
      const link = findPayrollAutoLinkMovement(p.net_pay, p.period_month, p.employer.name, candidates, taken);
      if (link.kind === "linked") {
        if (!dryRun) setLink.run(link.movement_id, p.document);
        taken.add(link.movement_id);
        details.linked += 1;
        details.links.push({ document: p.document, movement_id: link.movement_id });
      } else if (link.kind === "ambiguous") {
        details.ambiguous.push({ document: p.document, movement_ids: link.movement_ids });
      } else {
        details.unmatched.push({ document: p.document, net_pay: p.net_pay, period_month: p.period_month });
      }
    }
  })();
  return details;
}

/** The newest stored payslip (latest period; a period's severance and salary count as one), and
 * whether every payslip of that period has a deposit paired — what the nightly schedule reads. */
export function latestPayslip(): { period: string; paired: boolean } | null {
  const row = db
    .prepare(
      `SELECT period_month AS period, MIN(movement_id IS NOT NULL) AS paired
         FROM payroll_work_earnings
        GROUP BY period_month
        ORDER BY period_month DESC
        LIMIT 1`
    )
    .get() as { period: string; paired: number } | undefined;
  return row ? { period: row.period, paired: row.paired === 1 } : null;
}
