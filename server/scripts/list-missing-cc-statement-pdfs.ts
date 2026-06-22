/**
 * List cc_statements rows whose source_pdf has no matching PDF on disk.
 *
 *   npx tsx server/scripts/list-missing-cc-statement-pdfs.ts
 *   npx tsx server/scripts/list-missing-cc-statement-pdfs.ts --prune
 *   npx tsx server/scripts/list-missing-cc-statement-pdfs.ts --prune --dry-run
 */
import { recomputeCcBillingMonthBalances } from "../src/ccBillingBalances.js";
import { db } from "../src/db.js";
import { requireCcStatementPdfPath } from "../src/importSyncDocumentFilePath.js";
import { loadRootDotenv } from "../src/rootDotenv.js";

type MissingRow = {
  id: number;
  account_id: number;
  account_name: string;
  source_pdf: string;
  period_to: string | null;
  currency: string;
  card_last4: string | null;
};

function listMissingCcStatementRows(): MissingRow[] {
  const rows = db
    .prepare(
      `SELECT s.id, s.account_id, a.name AS account_name, s.source_pdf, s.period_to,
              s.currency, s.card_last4
       FROM cc_statements s
       JOIN accounts a ON a.id = s.account_id
       WHERE trim(s.source_pdf) != ''
         AND s.source_pdf NOT LIKE 'import:web-paste%'
       ORDER BY s.period_to, s.source_pdf`
    )
    .all() as MissingRow[];

  const missing: MissingRow[] = [];
  for (const row of rows) {
    try {
      requireCcStatementPdfPath(row.source_pdf, row);
    } catch {
      missing.push(row);
    }
  }
  return missing;
}

function pruneMissingCcStatements(missing: MissingRow[], dryRun: boolean): void {
  const delLines = db.prepare(`DELETE FROM cc_statement_lines WHERE statement_id = ?`);
  const delStmt = db.prepare(`DELETE FROM cc_statements WHERE id = ?`);
  const touchedAccounts = new Set<number>();

  const apply = db.transaction(() => {
    for (const row of missing) {
      const lineCount = (
        db
          .prepare(`SELECT COUNT(*) AS n FROM cc_statement_lines WHERE statement_id = ?`)
          .get(row.id) as { n: number }
      ).n;
      console.log(
        `  prune id=${row.id} account=${row.account_id} lines=${lineCount} ${row.source_pdf}`
      );
      if (dryRun) continue;
      delLines.run(row.id);
      delStmt.run(row.id);
      touchedAccounts.add(row.account_id);
    }
  });

  apply();

  if (dryRun) {
    console.log(`\n(dry-run: would delete ${missing.length} statement(s))`);
    return;
  }

  for (const accountId of touchedAccounts) {
    recomputeCcBillingMonthBalances(accountId);
  }
  console.log(`\nPruned ${missing.length} statement(s); billing recomputed for ${touchedAccounts.size} account(s).`);
}

function main(): void {
  loadRootDotenv();
  const prune = process.argv.includes("--prune");
  const dryRun = process.argv.includes("--dry-run");
  const missing = listMissingCcStatementRows();

  if (missing.length === 0) {
    console.log("All cc_statements PDFs resolve on disk.");
    return;
  }

  console.log(`Missing PDFs (${missing.length} statement(s)):\n`);
  for (const row of missing) {
    console.log(
      `  id=${row.id}  ${row.account_name}  ${row.period_to ?? "?"}  ${row.currency}  ${row.source_pdf}`
    );
  }

  if (prune) {
    console.log("\nPruning orphan statement rows (no on-disk PDF):\n");
    pruneMissingCcStatements(missing, dryRun);
    return;
  }

  console.log(
    "\nDrop the PDFs in cfraser/inbox/ and run npm run import:cfraser-inbox, " +
      "or run with --prune to remove orphan statement rows (use --dry-run first)."
  );
}

main();
