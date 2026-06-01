/**
 * Align `checking_cartola_imports.period_month` with the cartola period (Hasta month from
 * the xlsx when present, else Spanish month in the file name).
 *
 *   npm run repair:checking-cartola-period-month -w nw-tracker-server [--dry-run]
 */
import fs from "node:fs";
import path from "node:path";
import { parseCheckingCartolaFile } from "../src/checkingCartolaParse.js";
import { matrixMonthForCartolaPeriodMonth } from "../src/importSyncDocumentMonth.js";
import {
  resolveCfraserCheckingCartolaPdfsDir,
  resolveCfraserCheckingCartolasDir,
} from "../src/cfraserPaths.js";
import { rewriteCartolaMovementNotesPeriodMonth } from "../src/checkingCartolaImport.js";
import { db } from "../src/db.js";

function resolveCartolaPath(sourceFile: string): string | null {
  const base = sourceFile.split(/[/\\]/).pop() ?? sourceFile;
  for (const dir of [resolveCfraserCheckingCartolasDir(), resolveCfraserCheckingCartolaPdfsDir()]) {
    const full = path.join(dir, base);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

function inferPeriodMonth(row: {
  period_month: string;
  source_file: string;
}): string | null {
  const filePath = resolveCartolaPath(row.source_file);
  if (filePath && /\.xlsx$/i.test(filePath)) {
    try {
      const parsed = parseCheckingCartolaFile(filePath);
      return matrixMonthForCartolaPeriodMonth(parsed.period_month);
    } catch {
      /* fall through */
    }
  }
  return matrixMonthForCartolaPeriodMonth(row.period_month);
}

function main(): void {
  const dryRun = process.argv.includes("--dry-run");
  const rows = db
    .prepare(
      `SELECT account_id, period_month, source_file FROM checking_cartola_imports`
    )
    .all() as { account_id: number; period_month: string; source_file: string }[];

  const upd = db.prepare(
    `UPDATE checking_cartola_imports
     SET period_month = ?
     WHERE account_id = ? AND period_month = ?`
  );

  let patched = 0;
  for (const row of rows) {
    const docMonth = inferPeriodMonth(row);
    if (!docMonth || docMonth === row.period_month) continue;
    console.log(
      `account ${row.account_id}: ${row.period_month} -> ${docMonth} (${row.source_file})`
    );
    if (!dryRun) {
      rewriteCartolaMovementNotesPeriodMonth(row.account_id, row.period_month, docMonth);
      upd.run(docMonth, row.account_id, row.period_month);
    }
    patched += 1;
  }

  console.log(
    dryRun
      ? `[dry-run] would patch ${patched} cartola import row(s)`
      : `Patched ${patched} cartola import row(s).`
  );
}

main();
