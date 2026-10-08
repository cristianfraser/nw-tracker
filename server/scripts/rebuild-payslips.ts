/**
 * Payslips rebuilt from other evidence (`payroll_work_earnings.origin = 'rebuilt'`), their lines,
 * and the advances payslips net (`payslip_advances`). Report-first, idempotent:
 *
 *   npx tsx scripts/rebuild-payslips.ts --plan=<json> [--apply]          (from server/)
 *
 * The plan (personal data, kept under cfraser/) holds:
 *   - `basis`: document → what the payslip was rebuilt from (for the rebuilt rows already stored);
 *   - `usd_transfer_fee`: the dollars the USD contract's transfer took from each pay;
 *   - `new_payslips`: payslips with no document, each with its lines, the deposit that paid it and
 *     its basis — stored under their document key, replaced on a re-run;
 *   - `advances`: { document, movement_id } — the deposit that paid an advance a payslip nets.
 *
 * A rebuilt row already stored gets lines derived from its stored fields: CLP rows from their
 * breakdown (base, gratificación, colación, movilización / AFP, health, tax, cesantía, APV, other);
 * a USD row as the contract's fee (net + the transfer fee) less the transfer fee, in dollars, after
 * checking the stored peso breakdown uses one rate for both. Every payslip's lines must add up to
 * its stored totals and haberes − descuentos to its net pay, or nothing is written.
 */
import fs from "node:fs";
import { db } from "../src/db.js";
import { payslipLineKind } from "../src/payslipLineKinds.js";

type Side = "haber" | "descuento";
type Section = "imponible" | "no_imponible" | "legal" | "other" | null;
type Line = { side: Side; section: Section; label: string; amount: number };

type NewPayslip = {
  document: string;
  pension_fund: string | null;
  period_month: string;
  employer: { name: string; rut: string | null };
  pay_period_label: string;
  kind: "salary" | "severance";
  basis: string;
  deposit_movement_id: number;
  lines: Line[];
};

type Plan = {
  basis: Record<string, string>;
  /** document → the AFP the rebuilt payslip's contribution went to (null: none). */
  pension_fund: Record<string, string | null>;
  usd_transfer_fee: number;
  new_payslips: NewPayslip[];
  advances: { document: string; movement_id: number }[];
};

type StoredRow = {
  id: number;
  source_pdf: string;
  period_month: string;
  liquido: number;
  liquido_currency: "clp" | "usd";
  base_salary_clp: number | null;
  gratificacion_clp: number | null;
  colacion_clp: number | null;
  movilizacion_clp: number | null;
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
};

const apply = process.argv.includes("--apply");
const planPath = process.argv.find((a) => a.startsWith("--plan="))?.slice("--plan=".length);
if (!planPath) throw new Error("--plan=<json> is required");
const plan = JSON.parse(fs.readFileSync(planPath, "utf8")) as Plan;

const round2 = (n: number) => Math.round(n * 100) / 100;

function sum(lines: readonly Line[], side: Side): number {
  return round2(lines.filter((l) => l.side === side).reduce((s, l) => s + l.amount, 0));
}

function checkLines(doc: string, lines: readonly Line[], net: number, haberes: number | null, descuentos: number | null): void {
  const h = sum(lines, "haber");
  const d = sum(lines, "descuento");
  if (haberes != null && Math.abs(h - haberes) > 0.005) throw new Error(`${doc}: haberes lines ${h}, stored ${haberes}`);
  if (descuentos != null && Math.abs(d - descuentos) > 0.005) throw new Error(`${doc}: descuentos lines ${d}, stored ${descuentos}`);
  if (Math.abs(round2(h - d) - net) > 0.005) throw new Error(`${doc}: haberes − descuentos ${round2(h - d)}, net pay ${net}`);
}

function clpLines(r: StoredRow): Line[] {
  const hab: [string, Section, number | null][] = [
    ["Sueldo Base", "imponible", r.base_salary_clp],
    ["Gratificación", "imponible", r.gratificacion_clp],
    ["Colación", "no_imponible", r.colacion_clp],
    ["Movilización", "no_imponible", r.movilizacion_clp],
  ];
  const des: [string, number | null][] = [
    ["Fondo De Pensiones", r.desc_afp_clp],
    ["Fondo De Salud", r.desc_health_clp],
    ["Seguro De Cesantía", r.desc_cesantia_clp],
    ["Impuesto Único", r.desc_tax_clp],
    ["APV", r.desc_apv_clp],
  ];
  if (r.desc_other_clp) throw new Error(`${r.source_pdf}: an «other» deduction on a CLP rebuilt row has no label to give it`);
  return [
    ...hab.filter(([, , a]) => a).map(([label, section, a]) => ({ side: "haber" as const, section, label, amount: a! })),
    ...des.filter(([, a]) => a).map(([label, a]) => ({ side: "descuento" as const, section: "legal" as const, label, amount: a! })),
  ];
}

function usdLines(r: StoredRow, fee: number): Line[] {
  const gross = round2(r.liquido + fee);
  // The stored breakdown is in pesos at the wire's rate: the fee and the gross must use one rate.
  const rateGross = (r.total_haberes_clp ?? NaN) / gross;
  const rateFee = (r.desc_other_clp ?? NaN) / fee;
  if (!(Math.abs(rateGross - rateFee) < 0.01)) {
    throw new Error(`${r.source_pdf}: the stored pesos give ${rateGross} per dollar for the fee contract and ${rateFee} for the transfer fee`);
  }
  return [
    { side: "haber", section: null, label: "Honorarios (contrato en USD)", amount: gross },
    { side: "descuento", section: null, label: "Comisión de transferencia", amount: fee },
  ];
}

const rebuilt = db
  .prepare(`SELECT * FROM payroll_work_earnings WHERE origin = 'rebuilt' ORDER BY period_month, source_pdf`)
  .all() as StoredRow[];
const derived: { row: StoredRow; lines: Line[] }[] = [];
const newDocs = new Set(plan.new_payslips.map((p) => p.document));
for (const r of rebuilt) {
  if (newDocs.has(r.source_pdf)) continue;
  if (!plan.basis[r.source_pdf]) throw new Error(`${r.source_pdf}: no basis in the plan`);
  const lines = r.liquido_currency === "usd" ? usdLines(r, plan.usd_transfer_fee) : clpLines(r);
  if (r.liquido_currency === "usd") checkLines(r.source_pdf, lines, r.liquido, null, null);
  else checkLines(r.source_pdf, lines, r.liquido, r.total_haberes_clp, r.total_descuentos_clp);
  derived.push({ row: r, lines });
}
for (const p of plan.new_payslips) {
  checkLines(p.document, p.lines, sum(p.lines, "haber") - sum(p.lines, "descuento"), null, null);
  const dep = db.prepare(`SELECT amount, account_id FROM movements WHERE id = ?`).get(p.deposit_movement_id) as
    | { amount: number; account_id: number | null }
    | undefined;
  const net = round2(sum(p.lines, "haber") - sum(p.lines, "descuento"));
  if (!dep || dep.amount !== net) throw new Error(`${p.document}: deposit ${p.deposit_movement_id} is ${dep?.amount}, lines give ${net}`);
}
const advanceRows = plan.advances.map((a) => {
  const ps = db.prepare(`SELECT id FROM payroll_work_earnings WHERE source_pdf = ?`).get(a.document) as { id: number } | undefined;
  if (!ps) throw new Error(`advance: no payslip ${a.document}`);
  const line = db
    .prepare(`SELECT amount FROM payslip_lines WHERE payslip_id = ? AND kind = 'advance'`)
    .get(ps.id) as { amount: number } | undefined;
  const mv = db.prepare(`SELECT amount FROM movements WHERE id = ?`).get(a.movement_id) as { amount: number } | undefined;
  if (!line || !mv || line.amount !== mv.amount) {
    throw new Error(`advance ${a.document}: payslip advance line ${line?.amount}, movement ${a.movement_id} ${mv?.amount}`);
  }
  return { payslip_id: ps.id, movement_id: a.movement_id };
});

for (const d of derived) console.log(`lines   ${d.row.source_pdf}: ${d.lines.length} (${d.row.liquido_currency})`);
for (const p of plan.new_payslips) console.log(`new     ${p.document}: ${p.lines.length} lines, deposit ${p.deposit_movement_id}`);
for (const a of plan.advances) console.log(`advance ${a.document} ← movement ${a.movement_id}`);

if (!apply) {
  console.log("report only — pass --apply to write");
  process.exit(0);
}

const kindOf = (l: Line) => payslipLineKind(l.side, l.label);
const writeLines = (payslipId: number, lines: readonly Line[]) => {
  db.prepare(`DELETE FROM payslip_lines WHERE payslip_id = ?`).run(payslipId);
  const ins = db.prepare(
    `INSERT INTO payslip_lines (payslip_id, position, side, section, label, amount, kind) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  lines.forEach((l, i) => ins.run(payslipId, i, l.side, l.section, l.label, l.amount, kindOf(l)));
};

db.transaction(() => {
  for (const d of derived) {
    writeLines(d.row.id, d.lines);
    if (!(d.row.source_pdf in plan.pension_fund)) throw new Error(`${d.row.source_pdf}: no pension_fund in the plan`);
    db.prepare(`UPDATE payroll_work_earnings SET rebuilt_basis = ?, pension_fund = ? WHERE id = ?`).run(
      plan.basis[d.row.source_pdf],
      plan.pension_fund[d.row.source_pdf],
      d.row.id
    );
  }
  for (const p of plan.new_payslips) {
    const by = (kind: string) => {
      const ls = p.lines.filter((l) => kindOf(l) === kind);
      return ls.length ? ls.reduce((s, l) => s + l.amount, 0) : null;
    };
    const section = (s: Section) => {
      const ls = p.lines.filter((l) => l.side === "haber" && l.section === s);
      return ls.length ? ls.reduce((a, l) => a + l.amount, 0) : null;
    };
    const fields = {
      period_month: p.period_month,
      employer_name: p.employer.name,
      employer_rut: p.employer.rut,
      pay_period_label: p.pay_period_label,
      earning_type: p.kind,
      base_salary_clp: by("base_salary"),
      gratificacion_clp: by("gratification"),
      total_imponible_clp: section("imponible"),
      total_no_imponible_clp: section("no_imponible"),
      total_haberes_clp: sum(p.lines, "haber"),
      desc_afp_clp: by("pension"),
      desc_health_clp: (by("health") ?? 0) + (by("health_additional") ?? 0) || null,
      desc_tax_clp: by("income_tax"),
      desc_cesantia_clp: by("unemployment"),
      total_descuentos_clp: sum(p.lines, "descuento"),
      liquido: round2(sum(p.lines, "haber") - sum(p.lines, "descuento")),
      source_pdf: p.document,
      movement_id: p.deposit_movement_id,
      rebuilt_basis: p.basis,
      pension_fund: p.pension_fund,
    };
    db.prepare(
      `INSERT INTO payroll_work_earnings (
         period_month, employer_name, employer_rut, pay_period_label, earning_type, base_salary_clp, gratificacion_clp,
         total_imponible_clp, total_no_imponible_clp, total_haberes_clp, desc_afp_clp, desc_health_clp, desc_tax_clp,
         desc_cesantia_clp, total_descuentos_clp, liquido, liquido_currency, source_pdf, parse_version, movement_id,
         link_source, origin, rebuilt_basis, pension_fund
       ) VALUES (
         @period_month, @employer_name, @employer_rut, @pay_period_label, @earning_type, @base_salary_clp, @gratificacion_clp,
         @total_imponible_clp, @total_no_imponible_clp, @total_haberes_clp, @desc_afp_clp, @desc_health_clp, @desc_tax_clp,
         @desc_cesantia_clp, @total_descuentos_clp, @liquido, 'clp', @source_pdf, 'rebuilt', @movement_id,
         'manual', 'rebuilt', @rebuilt_basis, @pension_fund
       )
       ON CONFLICT(source_pdf) DO UPDATE SET
         period_month = excluded.period_month, employer_name = excluded.employer_name, employer_rut = excluded.employer_rut,
         pay_period_label = excluded.pay_period_label, earning_type = excluded.earning_type,
         base_salary_clp = excluded.base_salary_clp, gratificacion_clp = excluded.gratificacion_clp,
         total_imponible_clp = excluded.total_imponible_clp, total_no_imponible_clp = excluded.total_no_imponible_clp,
         total_haberes_clp = excluded.total_haberes_clp, desc_afp_clp = excluded.desc_afp_clp,
         desc_health_clp = excluded.desc_health_clp, desc_tax_clp = excluded.desc_tax_clp,
         desc_cesantia_clp = excluded.desc_cesantia_clp, total_descuentos_clp = excluded.total_descuentos_clp,
         liquido = excluded.liquido, movement_id = excluded.movement_id, link_source = 'manual',
         origin = 'rebuilt', rebuilt_basis = excluded.rebuilt_basis, pension_fund = excluded.pension_fund,
         imported_at = datetime('now')`
    ).run(fields);
    const id = (db.prepare(`SELECT id FROM payroll_work_earnings WHERE source_pdf = ?`).get(p.document) as { id: number }).id;
    writeLines(id, p.lines);
  }
  const insAdv = db.prepare(`INSERT OR IGNORE INTO payslip_advances (payslip_id, movement_id) VALUES (?, ?)`);
  for (const a of advanceRows) insAdv.run(a.payslip_id, a.movement_id);
})();
console.log(`written: ${derived.length} derived, ${plan.new_payslips.length} new, ${advanceRows.length} advance link(s)`);
