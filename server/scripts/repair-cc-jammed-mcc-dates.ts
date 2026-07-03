/**
 * Fix CC lines whose transaction_date year was parsed as 2511/2611 (pypdf MCC merge).
 *
 * 1. Delete only those bad lines (good lines on the same statement stay).
 * 2. Merge-import corrected rows from cc-statements-parsed-all.csv (no statement wipe).
 *
 *   npx tsx server/scripts/repair-cc-jammed-mcc-dates.ts [--dry-run] [--account-id=NN]
 */
import path from "node:path";

import { readCommaCsvRecords } from "../src/ccParsedCommaCsv.js";
import { recomputeCcBillingMonthBalances } from "../src/ccBillingBalances.js";
import { mergeCcAccountFromParsedRows } from "../src/ccInstallmentLedgerMerge.js";
import { resolveCfraserCsvDir } from "../src/cfraserPaths.js";
import { db } from "../src/db.js";
import { loadRootDotenv } from "../src/rootDotenv.js";


const BAD_YEAR_RE = /\/(2511|2611)$/;

function arg(name: string): string | undefined {
  const p = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(p));
  return hit ? hit.slice(p.length) : undefined;
}

type AffectedStmt = {
  account_id: number;
  source_pdf: string;
  bad_lines: number;
};

function listAffected(accountId?: number): AffectedStmt[] {
  const rows = db
    .prepare(
      `SELECT s.account_id, s.source_pdf, COUNT(*) AS bad_lines
       FROM cc_statement_lines l
       JOIN cc_statements s ON s.id = l.statement_id
       WHERE (l.transaction_date GLOB '*2511' OR l.transaction_date GLOB '*2611')
         ${accountId != null ? "AND s.account_id = ?" : ""}
       GROUP BY s.account_id, s.source_pdf
       ORDER BY s.account_id, s.source_pdf`
    )
    .all(...(accountId != null ? [accountId] : [])) as AffectedStmt[];
  return rows;
}

function deleteBadLines(accountId?: number): number {
  const r = db
    .prepare(
      `DELETE FROM cc_statement_lines
       WHERE id IN (
         SELECT l.id FROM cc_statement_lines l
         JOIN cc_statements s ON s.id = l.statement_id
         WHERE (l.transaction_date GLOB '*2511' OR l.transaction_date GLOB '*2611')
           ${accountId != null ? "AND s.account_id = ?" : ""}
       )`
    )
    .run(...(accountId != null ? [accountId] : []));
  return Number(r.changes);
}

function main(): void {
  loadRootDotenv();
  const dryRun = process.argv.includes("--dry-run");
  const accountIdArg = Number(arg("account-id"));
  const accountFilter =
    Number.isFinite(accountIdArg) && accountIdArg > 0 ? accountIdArg : undefined;

  const affected = listAffected(accountFilter);
  if (affected.length === 0) {
    console.log("No jammed MCC date lines (2511/2611) in DB.");
    return;
  }

  const sourcePdfs = new Set(affected.map((a) => a.source_pdf));
  const badTotal = affected.reduce((n, a) => n + a.bad_lines, 0);
  console.log(
    `# repair-cc-jammed-mcc-dates: ${badTotal} bad line(s) across ${sourcePdfs.size} statement PDF(s)`
  );
  for (const row of affected) {
    console.log(`  account ${row.account_id}\t${row.bad_lines} lines\t${row.source_pdf}`);
  }

  const csvPath = arg("csv") ?? path.join(resolveCfraserCsvDir(), "cc-statements-parsed-all.csv");
  const allRecords = readCommaCsvRecords(csvPath);
  const repairRecords = allRecords.filter((row) => {
    const pdf = String(row.source_pdf ?? "").trim();
    if (!sourcePdfs.has(pdf)) return false;
    const tx = String(row.transaction_date ?? "").trim();
    const post = String(row.posting_date ?? "").trim();
    if (BAD_YEAR_RE.test(tx) || BAD_YEAR_RE.test(post)) {
      console.warn(`# WARN CSV still has jammed date for ${pdf}: ${tx || post}`);
    }
    return true;
  });

  if (repairRecords.length === 0) {
    console.error(`No CSV rows for affected PDFs in ${csvPath}. Run parse:cc-pdfs --force-reparse first.`);
    process.exit(1);
  }

  const accountIds = [...new Set(affected.map((a) => a.account_id))];
  if (dryRun) {
    console.log(
      `[dry-run] Would delete ${badTotal} line(s), merge-import ${repairRecords.length} CSV row(s) for accounts: ${accountIds.join(", ")}`
    );
    return;
  }

  const deleted = deleteBadLines(accountFilter);
  console.log(`Deleted ${deleted} jammed line(s).`);

  for (const accountId of accountIds) {
    const pdfsForAccount = new Set(
      affected.filter((a) => a.account_id === accountId).map((a) => a.source_pdf)
    );
    const records = repairRecords.filter((row) =>
      pdfsForAccount.has(String(row.source_pdf ?? "").trim())
    );
    const merged = mergeCcAccountFromParsedRows(accountId, records, {
      replaceStatementKeys: new Set(),
    });
    recomputeCcBillingMonthBalances(accountId);
    console.log(
      `Account ${accountId}: +${merged.statements.linesInserted} lines inserted, ` +
        `${merged.statements.linesSkippedDuplicate} skipped duplicate, ` +
        `ledger purchases ${merged.ledger.purchaseUpserts}, payments ${merged.ledger.paymentUpserts}.`
    );
  }

  const remaining = listAffected(accountFilter);
  if (remaining.length > 0) {
    console.error("# FAIL: jammed dates still in DB after repair.");
    process.exit(1);
  }
  console.log("Done.");
}

main();
