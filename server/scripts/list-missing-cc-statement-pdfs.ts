/**
 * List cc_statements rows whose source_pdf has no matching PDF on disk.
 *
 *   npx tsx server/scripts/list-missing-cc-statement-pdfs.ts
 *   npx tsx server/scripts/list-missing-cc-statement-pdfs.ts --prune
 *   npx tsx server/scripts/list-missing-cc-statement-pdfs.ts --prune --dry-run
 *   npx tsx server/scripts/list-missing-cc-statement-pdfs.ts --prune --allow-assignment-loss
 *
 * --prune refuses a statement whose lines carry user-filed assignments (category, note, big group,
 * pieces, links) unless --allow-assignment-loss says they may go with it.
 */
import { pruneStatements, reportStatementPrune } from "../src/ccStatementPrune.js";
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
         AND s.source_kind NOT IN ('listing_open', 'listing_other')
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

function pruneMissingCcStatements(missing: MissingRow[], dryRun: boolean, allowAssignmentLoss: boolean): void {
  const report = reportStatementPrune(missing.map((m) => m.id));
  for (const r of report) {
    const row = missing.find((m) => m.id === r.statementId)!;
    console.log(
      `  prune id=${row.id} account=${row.account_id} lines=${r.lines} with-assignments=${r.lines_with_assignments} ${row.source_pdf}`
    );
  }
  const held = report.filter((r) => r.lines_with_assignments > 0);
  if (dryRun) {
    console.log(`\n(dry-run: would delete ${missing.length} statement(s); ${held.length} carry user-filed assignments)`);
    if (held.length > 0) console.log("Pruning those needs --allow-assignment-loss.");
    return;
  }
  pruneStatements(missing.map((m) => m.id), { allowAssignmentLoss });
  console.log(`\nPruned ${missing.length} statement(s) through the card-line write funnel.`);
}

function main(): void {
  loadRootDotenv();
  const prune = process.argv.includes("--prune");
  const dryRun = process.argv.includes("--dry-run");
  const allowAssignmentLoss = process.argv.includes("--allow-assignment-loss");
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
    pruneMissingCcStatements(missing, dryRun, allowAssignmentLoss);
    return;
  }

  console.log(
    "\nDrop the PDFs in cfraser/inbox/ and run npm run import:cfraser-inbox, " +
      "or run with --prune to remove orphan statement rows (use --dry-run first)."
  );
}

main();
