/**
 * Remove one-shot statement lines that should be wide_master_precio_summary installments
 * (CUOTA FIJA / CUOTA VARIABLE with NN/MM cuota index). Re-run after fixing the PDF parser.
 *
 *   npx tsx server/scripts/repair-cc-misparsed-cuota-fija-lines.ts
 *   npx tsx server/scripts/repair-cc-misparsed-cuota-fija-lines.ts --account-id=35
 */
import { db } from "../src/db.js";
import { recomputeCcBillingMonthBalances } from "../src/ccBillingBalances.js";
import { mergeCcAccountFromParsedRows } from "../src/ccInstallmentLedgerMerge.js";
import { readCommaCsvRecords } from "../src/ccParsedCommaCsv.js";
import { resolveCfraserCsvDir } from "../src/cfraserPaths.js";
import { resolveImportAccountIds, cardLast4FromParsedRow } from "../src/ccParsedImportAccounts.js";
import { resolveMasterAccountIdForImportCardLast4 } from "../src/ccConsolidatedCards.js";
import path from "node:path";

function arg(name: string): string | undefined {
  const p = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(p));
  if (!hit) return undefined;
  return hit.slice(p.length);
}

const CUOTA_FIJA_RE =
  /CUOTA\s+FIJA\s+\d,\d{2}\s*%.*\d{1,2}\/\d{1,2}\s+\$\s*[\d.]+/i;
const TCOM_CUOTAS_TASA_RE =
  /TCOM\s+\d+\s+\d{2}\s+CUOTAS,\s+TASA\s+\d,\d{2}\s*%.*\$\s*[\d.]+\s+\$\s*[\d.]+\s+\$\s*[\d.]+/i;

function main() {
  const accountIdArg = Number(arg("account-id"));
  const accountFilter =
    Number.isFinite(accountIdArg) && accountIdArg > 0 ? accountIdArg : null;

  const sql = accountFilter
    ? `SELECT l.id, l.raw_line, s.account_id
       FROM cc_statement_lines l
       JOIN cc_statements s ON s.id = l.statement_id
       WHERE s.account_id = ?
         AND l.installment_flag = 0
         AND l.raw_line IS NOT NULL
         AND (l.raw_line LIKE '%CUOTA FIJA%' OR l.raw_line LIKE '%CUOTA VARIABLE%' OR l.raw_line LIKE '%CUOTAS, TASA%')`
    : `SELECT l.id, l.raw_line, s.account_id
       FROM cc_statement_lines l
       JOIN cc_statements s ON s.id = l.statement_id
       WHERE l.installment_flag = 0
         AND l.raw_line IS NOT NULL
         AND (l.raw_line LIKE '%CUOTA FIJA%' OR l.raw_line LIKE '%CUOTA VARIABLE%' OR l.raw_line LIKE '%CUOTAS, TASA%')`;
  const rows = (
    accountFilter
      ? db.prepare(sql).all(accountFilter)
      : db.prepare(sql).all()
  ) as { id: number; raw_line: string; account_id: number }[];

  const toDelete = rows.filter(
    (r) => CUOTA_FIJA_RE.test(r.raw_line) || TCOM_CUOTAS_TASA_RE.test(r.raw_line)
  );
  const del = db.prepare(`DELETE FROM cc_statement_lines WHERE id = ?`);
  const touched = new Set<number>();

  for (const row of toDelete) {
    del.run(row.id);
    touched.add(row.account_id);
    console.log(`deleted line ${row.id} account ${row.account_id}`);
  }

  console.log(`removed ${toDelete.length} misclassified line(s)`);

  const csvPath = path.join(resolveCfraserCsvDir(), "cc-statements-parsed-all.csv");
  const records = readCommaCsvRecords(csvPath);
  const { accountIds } = resolveImportAccountIds({ records });

  for (const accountId of accountIds) {
    if (accountFilter != null && accountId !== accountFilter) continue;
    if (!touched.has(accountId) && accountFilter == null) {
      const hasFixRows = records.some((row) => {
        const l4 = cardLast4FromParsedRow(row);
        const acc = resolveMasterAccountIdForImportCardLast4(l4);
        if (acc !== accountId) return false;
        return (
          String(row.installment_flag ?? "").toLowerCase() === "true" &&
          String(row.tipo_cuota ?? "").toUpperCase().includes("CUOTA FIJA")
        );
      });
      if (!hasFixRows) continue;
    }
    const accountRecords = records.filter((row) => {
      const l4 = cardLast4FromParsedRow(row);
      return resolveMasterAccountIdForImportCardLast4(l4) === accountId;
    });
    const merged = mergeCcAccountFromParsedRows(accountId, accountRecords, {
      replaceLedger: false,
    });
    recomputeCcBillingMonthBalances(accountId);
    console.log(
      `account ${accountId}: +${merged.statements.linesInserted} lines, ledger purchases ${merged.ledger.purchaseUpserts}`
    );
  }
}

main();
