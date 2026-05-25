/**
 * Backfill blank `cc_statements` dates from `source_pdf` prefix (YYYY-MM-DD) and remove
 * international footer noise lines (e.g. ABONO … EMISOR CLIENTE).
 *
 *   npm run repair:cc-metadata -w nw-tracker-server [-- --dry-run]
 */
import { db } from "../src/db.js";

function dateFromSourcePdfPrefix(sourcePdf: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})\s/.exec(String(sourcePdf ?? "").trim());
  if (!m) return null;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

function main(): void {
  const dryRun = process.argv.includes("--dry-run");

  const blankStmtRows = db
    .prepare(
      `SELECT id, source_pdf, statement_date, period_to, period_from FROM cc_statements
       WHERE statement_date IS NULL OR TRIM(statement_date) = ''
          OR period_to IS NULL OR TRIM(period_to) = ''
          OR period_from IS NULL OR TRIM(period_from) = ''`
    )
    .all() as {
    id: number;
    source_pdf: string;
    statement_date: string | null;
    period_to: string | null;
    period_from: string | null;
  }[];

  let datesPatched = 0;
  const updStmt = db.prepare(
    `UPDATE cc_statements
     SET statement_date = COALESCE(NULLIF(TRIM(statement_date), ''), ?),
         period_to = COALESCE(NULLIF(TRIM(period_to), ''), ?),
         period_from = COALESCE(NULLIF(TRIM(period_from), ''), ?)
     WHERE id = ?`
  );

  for (const row of blankStmtRows) {
    const ddMmYyyy = dateFromSourcePdfPrefix(row.source_pdf);
    if (!ddMmYyyy) continue;
    const patchStmt = !row.statement_date?.trim();
    const patchTo = !row.period_to?.trim();
    const patchFrom = !row.period_from?.trim();
    if (!patchStmt && !patchTo && !patchFrom) continue;
    if (!dryRun) {
      updStmt.run(
        patchStmt ? ddMmYyyy : row.statement_date,
        patchTo ? ddMmYyyy : row.period_to,
        patchFrom ? ddMmYyyy : row.period_from,
        row.id
      );
    }
    datesPatched += 1;
    console.log(
      `id=${row.id} ${row.source_pdf} -> statement_date=${patchStmt ? ddMmYyyy : row.statement_date} period_to=${patchTo ? ddMmYyyy : row.period_to}`
    );
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
