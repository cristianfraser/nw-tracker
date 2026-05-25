import { db } from "./db.js";
import { resolveCcStatementPdfPath } from "./importSyncDocumentFilePath.js";

export type CcStatementMissingPeriodRow = {
  account_id: number;
  account_name: string;
  source_pdf: string;
};

export function listCcStatementsMissingPeriodTo(): CcStatementMissingPeriodRow[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT s.account_id, a.name AS account_name, s.source_pdf
       FROM cc_statements s
       JOIN accounts a ON a.id = s.account_id
       WHERE s.source_pdf NOT LIKE 'import:web-paste%'
         AND TRIM(COALESCE(s.period_to, '')) = ''
       ORDER BY s.source_pdf`
    )
    .all() as CcStatementMissingPeriodRow[];
  return rows.filter((r) => resolveCcStatementPdfPath(r.source_pdf) != null);
}

/** Fail before document-coverage UI when imported PDFs lack billing-period metadata. */
export function assertCcStatementsHavePeriodTo(): void {
  const rows = listCcStatementsMissingPeriodTo();
  if (rows.length === 0) return;
  const sample = rows
    .slice(0, 8)
    .map((r) => `${r.account_name}: ${r.source_pdf}`)
    .join("; ");
  const more = rows.length > 8 ? ` (+${rows.length - 8} more)` : "";
  throw new Error(
    `CC statements missing period_to (${rows.length} PDFs). ` +
      `Re-run npm run parse:cc-pdfs and re-import affected accounts. ${sample}${more}`
  );
}
