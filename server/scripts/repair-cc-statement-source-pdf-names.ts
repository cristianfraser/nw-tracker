/**
 * Align `cc_statements.source_pdf` (and related refs) with on-disk PDFs under
 * `credit-card-statements/<last4>/clp|usd/`.
 *
 *   npx tsx server/scripts/repair-cc-statement-source-pdf-names.ts
 *   npx tsx server/scripts/repair-cc-statement-source-pdf-names.ts --dry-run
 */
import { db } from "../src/db.js";
import { cardLast4ForCreditCardAccount } from "../src/ccManualBillingMonth.js";
import {
  assertCcStatementSourcePdfBasename,
  archivedCreditCardStatementPdfFileName,
  requireCcStatementPdfPath,
} from "../src/importSyncDocumentFilePath.js";
import { isCcStatementPdfSource } from "../src/importSyncDocumentMonth.js";
import { loadRootDotenv } from "../src/rootDotenv.js";

type StmtRow = {
  id: number;
  account_id: number;
  card_group: string;
  source_pdf: string;
  statement_date: string;
  period_to: string | null;
  card_last4: string | null;
  currency: string;
  layout: string;
};

function main(): void {
  loadRootDotenv();
  const dryRun = process.argv.includes("--dry-run");
  const rows = db
    .prepare(
      `SELECT id, account_id, card_group, source_pdf, statement_date, period_to,
              card_last4, currency, layout
       FROM cc_statements
       WHERE trim(source_pdf) != ''
         AND source_pdf NOT LIKE 'import:web-paste%'`
    )
    .all() as StmtRow[];

  const updStmt = db.prepare(`UPDATE cc_statements SET source_pdf = ? WHERE id = ?`);
  const updPurch = db.prepare(
    `UPDATE cc_installment_purchases SET source_pdf_sample = ?
     WHERE account_id = ? AND source_pdf_sample = ?`
  );
  const updPay = db.prepare(
    `UPDATE cc_installment_payments SET source_pdf = ?
     WHERE source_pdf = ? AND purchase_id IN (
       SELECT id FROM cc_installment_purchases WHERE account_id = ?
     )`
  );
  const updCardLast4 = db.prepare(`UPDATE cc_statements SET card_last4 = ? WHERE id = ?`);

  let renamed = 0;
  let cardLast4Set = 0;
  const errors: string[] = [];

  const apply = db.transaction(() => {
    for (const row of rows) {
      if (!isCcStatementPdfSource(row.source_pdf)) continue;

      let last4 = String(row.card_last4 ?? "").trim();
      if (!/^\d{4}$/.test(last4)) {
        const fromAcct = cardLast4ForCreditCardAccount(row.account_id);
        if (!fromAcct) {
          errors.push(
            `statement id=${row.id} account=${row.account_id}: missing card_last4 and no master last4 on account`
          );
          continue;
        }
        last4 = fromAcct;
        updCardLast4.run(last4, row.id);
        cardLast4Set += 1;
        row.card_last4 = last4;
      }

      const canonical =
        archivedCreditCardStatementPdfFileName({
          period_to: row.period_to ?? undefined,
          card_last4: last4,
          currency: row.currency,
          parser_layout: row.layout,
        }) ?? null;
      if (!canonical) {
        errors.push(
          `statement id=${row.id}: cannot build canonical basename (period_to=${row.period_to ?? ""})`
        );
        continue;
      }

      const probe = { ...row, card_last4: last4, source_pdf: canonical };
      try {
        requireCcStatementPdfPath(canonical, probe);
      } catch (e) {
        errors.push(
          `statement id=${row.id} account=${row.account_id}: ${e instanceof Error ? e.message : e}`
        );
        continue;
      }

      const oldPdf = row.source_pdf.trim();
      if (oldPdf === canonical) {
        try {
          assertCcStatementSourcePdfBasename(oldPdf, probe);
        } catch (e) {
          errors.push(
            `statement id=${row.id}: ${e instanceof Error ? e.message : e}`
          );
        }
        continue;
      }

      updStmt.run(canonical, row.id);
      updPurch.run(canonical, row.account_id, oldPdf);
      updPay.run(canonical, oldPdf, row.account_id);
      console.log(`  ${oldPdf} -> ${canonical}`);
      renamed += 1;
    }
  });

  if (dryRun) {
    db.exec("SAVEPOINT repair_cc_source_pdf_dry");
    try {
      apply();
    } finally {
      db.exec("ROLLBACK TO repair_cc_source_pdf_dry");
      db.exec("RELEASE repair_cc_source_pdf_dry");
    }
  } else {
    apply();
  }

  console.log(
    `\nrepair-cc-statement-source-pdf-names: renamed=${renamed} card_last4_set=${cardLast4Set} errors=${errors.length}${dryRun ? " (dry-run)" : ""}`
  );
  if (errors.length > 0) {
    console.error("\nErrors (fix PDFs on disk or statement metadata, then re-run):");
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
}

main();
