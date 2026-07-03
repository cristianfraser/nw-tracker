import fs from "node:fs";
import path from "node:path";

import { db } from "../src/db.js";
import { findPayrollAutoLinkMovement, listPayrollLinkCandidates } from "../src/payrollWorkEarningsLinking.js";
import { resolveCfraserCsvDir } from "../src/cfraserPaths.js";

const CFRASER_DIR = resolveCfraserCsvDir();
const PARSE_INDEX = path.join(CFRASER_DIR, "payroll-parsing-output", "all.json");

type ParsedPayrollRow = {
  source_pdf: string;
  period_month: string;
  employer_name: string;
  employer_rut: string | null;
  pay_period_label: string | null;
  earning_type: "salary" | "severance";
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
  uf_mes: number | null;
  utm_mes: number | null;
  tope_previsional_uf: number | null;
  tope_cesantia_uf: number | null;
  format?: string;
};

function argFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

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

function loadParsedRows(): { parser_version: string; rows: ParsedPayrollRow[] } {
  if (!fs.existsSync(PARSE_INDEX)) {
    throw new Error(`missing ${PARSE_INDEX} — run npm run parse:payroll-liquidaciones first`);
  }
  const raw = JSON.parse(fs.readFileSync(PARSE_INDEX, "utf8")) as {
    parser_version?: string;
    rows?: ParsedPayrollRow[];
    failures?: string[];
  };
  if (raw.failures?.length) {
    throw new Error(
      `parse index has ${raw.failures.length} failure(s) — re-run parse:payroll-liquidaciones`
    );
  }
  if (!raw.rows?.length) {
    throw new Error(`no parsed payroll rows in ${PARSE_INDEX}`);
  }
  return { parser_version: raw.parser_version ?? "unknown", rows: raw.rows };
}

function upsertRow(row: ParsedPayrollRow, parserVersion: string): number {
  const r = db
    .prepare(UPSERT_SQL)
    .run(
      row.period_month,
      row.employer_name,
      row.employer_rut,
      row.pay_period_label,
      row.earning_type ?? "salary",
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
      parserVersion,
      null,
      null
    );
  const id = Number(r.lastInsertRowid);
  if (id > 0) return id;
  const existing = db
    .prepare(`SELECT id FROM payroll_work_earnings WHERE source_pdf = ?`)
    .get(row.source_pdf) as { id: number };
  return existing.id;
}

function main(): void {
  const dryRun = argFlag("dry-run");
  const strict = !argFlag("no-strict");
  const { parser_version, rows } = loadParsedRows();
  const candidates = listPayrollLinkCandidates();

  const takenMovementIds = new Set<number>();
  for (const row of db
    .prepare(
      `SELECT movement_id FROM payroll_work_earnings WHERE movement_id IS NOT NULL AND link_source = 'manual'`
    )
    .all() as { movement_id: number }[]) {
    takenMovementIds.add(row.movement_id);
  }

  let linked = 0;
  let unmatched: string[] = [];
  let ambiguous: string[] = [];

  for (const row of rows) {
    const id = dryRun ? 0 : upsertRow(row, parser_version);
    const existing = db
      .prepare(
        `SELECT id, movement_id, link_source FROM payroll_work_earnings WHERE source_pdf = ?`
      )
      .get(row.source_pdf) as
      | { id: number; movement_id: number | null; link_source: string | null }
      | undefined;

    const rowId = dryRun ? 0 : (existing?.id ?? id);
    if (existing?.link_source === "manual" && existing.movement_id != null) {
      takenMovementIds.add(existing.movement_id);
      linked += 1;
      continue;
    }

    const link = findPayrollAutoLinkMovement(
      row.liquido_clp,
      row.period_month,
      row.employer_name,
      candidates,
      takenMovementIds
    );

    if (link.kind === "linked") {
      if (!dryRun) {
        db.prepare(
          `UPDATE payroll_work_earnings
           SET movement_id = ?, link_source = 'auto'
           WHERE id = ?`
        ).run(link.movement_id, rowId);
      }
      takenMovementIds.add(link.movement_id);
      linked += 1;
      console.log(
        `  linked ${row.source_pdf} liquido=${row.liquido_clp} → movement ${link.movement_id}`
      );
    } else if (link.kind === "ambiguous") {
      ambiguous.push(`${row.source_pdf}: candidates ${link.movement_ids.join(", ")}`);
      console.error(`  AMBIGUOUS ${row.source_pdf}: movement ids ${link.movement_ids.join(", ")}`);
    } else {
      unmatched.push(row.source_pdf);
      console.warn(`  unmatched ${row.source_pdf} liquido=${row.liquido_clp} period=${row.period_month}`);
    }
  }

  console.log(
    `\n=== payroll import ===\nrows=${rows.length} linked=${linked} unmatched=${unmatched.length} ambiguous=${ambiguous.length}${dryRun ? " (dry-run)" : ""}`
  );
  if (unmatched.length) {
    console.log("\nUnmatched:");
    for (const u of unmatched) console.log(`  ${u}`);
  }
  if (ambiguous.length) {
    console.log("\nAmbiguous:");
    for (const a of ambiguous) console.log(`  ${a}`);
  }

  if (strict && !dryRun && (unmatched.length > 0 || ambiguous.length > 0)) {
    process.exit(1);
  }
}

main();
