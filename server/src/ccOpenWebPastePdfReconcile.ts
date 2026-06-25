import { billingMonthForCcStatement } from "./ccBillingMonth.js";
import { recomputeCcBillingMonthBalances } from "./ccBillingBalances.js";
import { deleteStatementLinesByIds } from "./ccCrossImportDedupe.js";
import { isPdfStatementSource } from "./ccManualBillingMonth.js";
import {
  openWebPasteSourcePdf,
  parseOpenWebPasteBillingMonth,
} from "./ccOpenWebPasteRepair.js";
import {
  dbLineToReconcileRow,
  reconcileWebPastePdfRowsMatch,
  type CcReconcileRow,
} from "./ccStatementImportReconcile.js";
import type { CcStatementCsvRecord } from "./ccStatementsImport.js";
import { listCcStatementLinesForStatement, listCcStatementsForAccount } from "./ccStatementsDb.js";

export type CcOpenWebPastePdfReconcileResult = {
  billing_month: string;
  deleted_count: number;
  deleted_line_ids: number[];
  skipped: boolean;
  skip_reason: string | null;
};

function pdfReconcileRowsForBillingMonth(
  accountId: number,
  billingMonth: string
): CcReconcileRow[] {
  const rows: CcReconcileRow[] = [];
  for (const st of listCcStatementsForAccount(accountId)) {
    if (st.billing_month !== billingMonth) continue;
    if (!isPdfStatementSource(st.source_pdf)) continue;
    for (const line of listCcStatementLinesForStatement(st.id)) {
      rows.push(
        dbLineToReconcileRow(line, {
          currency: st.currency,
          layout: st.layout,
          source_pdf: st.source_pdf,
        })
      );
    }
  }
  return rows;
}

function openWebPasteStatementsForBucketMonth(
  accountId: number,
  billingMonth: string
): ReturnType<typeof listCcStatementsForAccount> {
  const target = openWebPasteSourcePdf(billingMonth);
  return listCcStatementsForAccount(accountId).filter((st) => st.source_pdf === target);
}

/** Delete web-paste one-shots on `open|{M}` that match PDF lines for closed month M. */
export function reconcileOpenWebPasteAfterPdfClose(
  accountId: number,
  billingMonth: string,
  opts?: { dryRun?: boolean }
): CcOpenWebPastePdfReconcileResult {
  const pdfRows = pdfReconcileRowsForBillingMonth(accountId, billingMonth);
  if (pdfRows.length === 0) {
    return {
      billing_month: billingMonth,
      deleted_count: 0,
      deleted_line_ids: [],
      skipped: true,
      skip_reason: "no_pdf_lines_for_billing_month",
    };
  }

  const toDelete: number[] = [];
  for (const st of openWebPasteStatementsForBucketMonth(accountId, billingMonth)) {
    for (const line of listCcStatementLinesForStatement(st.id)) {
      const webRow = dbLineToReconcileRow(line, {
        currency: st.currency,
        layout: st.layout,
        source_pdf: st.source_pdf,
      });
      if (pdfRows.some((pdfRow) => reconcileWebPastePdfRowsMatch(pdfRow, webRow))) {
        toDelete.push(line.id);
      }
    }
  }

  if (!opts?.dryRun && toDelete.length > 0) {
    deleteStatementLinesByIds(toDelete);
    recomputeCcBillingMonthBalances(accountId);
  }

  return {
    billing_month: billingMonth,
    deleted_count: toDelete.length,
    deleted_line_ids: toDelete,
    skipped: false,
    skip_reason: null,
  };
}

export function pdfClosedBillingMonthsFromImportRecords(
  records: readonly CcStatementCsvRecord[]
): string[] {
  const months = new Set<string>();
  for (const row of records) {
    const sourcePdf = String(row.source_pdf ?? "").trim();
    if (sourcePdf.startsWith("import:web-paste")) continue;
    const bm = billingMonthForCcStatement({
      statement_date: row.statement_date,
      period_to: row.period_to,
    });
    if (bm) months.add(bm);
  }
  return [...months].sort();
}

export function reconcileOpenWebPasteAfterPdfImports(
  accountId: number,
  records: readonly CcStatementCsvRecord[],
  opts?: { dryRun?: boolean }
): CcOpenWebPastePdfReconcileResult[] {
  const months = pdfClosedBillingMonthsFromImportRecords(records);
  return months.map((bm) => reconcileOpenWebPasteAfterPdfClose(accountId, bm, opts));
}

/** Stale `open|{bm}` web-paste statements whose bucket month is before the current open month. */
export function listStaleOpenWebPasteStatementDates(
  accountId: number,
  openBillingMonth: string
): string[] {
  const dates: string[] = [];
  for (const st of listCcStatementsForAccount(accountId)) {
    const bucketBm = parseOpenWebPasteBillingMonth(st.source_pdf);
    if (!bucketBm) continue;
    if (bucketBm.localeCompare(openBillingMonth) >= 0) continue;
    dates.push(st.statement_date);
  }
  return dates;
}
