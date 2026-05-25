/**
 * Backfill blank `cc_statements.statement_date` from `source_pdf` prefix (YYYY-MM-DD)
 * and remove international footer noise lines (e.g. ABONO … EMISOR CLIENTE).
 *
 *   npx tsx server/scripts/repair-cc-statement-metadata.ts [--dry-run]
 */
import { db } from "../src/db.js";

function main(): void {
  const dryRun = process.argv.includes("--dry-run");

  const blankStmtRows = db
    .prepare(
      `SELECT id, source_pdf, statement_date FROM cc_statements
       WHERE statement_date IS NULL OR TRIM(statement_date) = ''`
    )
    .all() as { id: number; source_pdf: string; statement_date: string | null }[];

  let datesPatched = 0;
  const updDate = db.prepare(
    `UPDATE cc_statements SET statement_date = ? WHERE id = ?`
  );

  for (const row of blankStmtRows) {
    const m = /^(\d{4})-(\d{2})-(\d{2})\s/.exec(String(row.source_pdf ?? "").trim());
    if (!m) continue;
    const ddMmYyyy = `${m[3]}/${m[2]}/${m[1]}`;
    if (!dryRun) updDate.run(ddMmYyyy, row.id);
    datesPatched += 1;
    console.log(`statement_date: id=${row.id} ${row.source_pdf} -> ${ddMmYyyy}`);
  }

  const noisyLines = db
    .prepare(
      `SELECT l.id, l.merchant, s.source_pdf
       FROM cc_statement_lines l
       JOIN cc_statements s ON s.id = l.statement_id
       WHERE UPPER(l.merchant) LIKE '%EMISOR CLIENTE%'
          OR UPPER(l.merchant) LIKE 'DESCRIPCI%N OPERACI%'
          OR UPPER(l.merchant) LIKE '%MONTO MONEDA ORIGEN%'`
    )
    .all() as { id: number; merchant: string; source_pdf: string }[];

  let linesDeleted = 0;
  const delLine = db.prepare(`DELETE FROM cc_statement_lines WHERE id = ?`);
  for (const row of noisyLines) {
    if (!dryRun) delLine.run(row.id);
    linesDeleted += 1;
    console.log(`delete line: id=${row.id} ${row.source_pdf} merchant=${row.merchant}`);
  }

  console.log(
    dryRun
      ? `[dry-run] would patch ${datesPatched} statement(s), delete ${linesDeleted} line(s)`
      : `Patched ${datesPatched} statement date(s), deleted ${linesDeleted} noisy line(s).`
  );
}

main();
