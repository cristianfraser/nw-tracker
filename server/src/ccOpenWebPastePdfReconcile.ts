import { billingMonthForCcStatement } from "./ccBillingMonth.js";
import { recomputeCcBillingMonthBalances } from "./ccBillingBalances.js";
import { deleteStatementLinesByIds } from "./ccCrossImportDedupe.js";
import { parseDdMmYyToIso } from "./ccInstallmentPayBy.js";
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
import {
  listCcStatementLinesForStatement,
  listCcStatementsForAccount,
  type CcStatementLineRow,
} from "./ccStatementsDb.js";

function fieldToIso(raw: string | null | undefined): string | null {
  const t = String(raw ?? "").trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  return parseDdMmYyToIso(t);
}

function linePurchaseIso(line: CcStatementLineRow): string | null {
  return fieldToIso(line.transaction_date) ?? fieldToIso(line.posting_date);
}

/** Inclusive [from, to] ISO period covered by the PDF close(s) for a billing month. */
function closedPeriodIsoRange(
  pdfStatements: ReturnType<typeof listCcStatementsForAccount>
): { from: string; to: string } | null {
  let from: string | null = null;
  let to: string | null = null;
  for (const st of pdfStatements) {
    const f = fieldToIso(st.period_from);
    const t = fieldToIso(st.period_to);
    if (f && (from == null || f < from)) from = f;
    if (t && (to == null || t > to)) to = t;
  }
  return from && to ? { from, to } : null;
}

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

/**
 * Supersede the `open|{M}` web-paste bucket once a PDF closes billing month M.
 *
 * The web-paste open bucket is a placeholder for the in-progress cycle; the PDF is
 * authoritative once it arrives. Web-paste amounts are pre-auth snapshots that don't
 * line up one-to-one with settled PDF lines (e.g. several grocery pre-auths collapse to
 * one settled charge), so we don't try to match line-by-line. Instead, every web-paste
 * line whose purchase date falls inside the closed PDF's billing period is removed —
 * it's already represented on the PDF. Lines dated after period_to belong to the next
 * cycle (moved forward by repairMisplacedOpenWebPasteBuckets) and are left untouched.
 *
 * Falls back to exact line matching when the PDF lacks a parseable billing period.
 */
export function reconcileOpenWebPasteAfterPdfClose(
  accountId: number,
  billingMonth: string,
  opts?: { dryRun?: boolean; skipRecompute?: boolean }
): CcOpenWebPastePdfReconcileResult {
  const pdfStatements = listCcStatementsForAccount(accountId).filter(
    (st) => st.billing_month === billingMonth && isPdfStatementSource(st.source_pdf)
  );
  if (pdfStatements.length === 0) {
    return {
      billing_month: billingMonth,
      deleted_count: 0,
      deleted_line_ids: [],
      skipped: true,
      skip_reason: "no_pdf_lines_for_billing_month",
    };
  }

  const closedPeriod = closedPeriodIsoRange(pdfStatements);
  const pdfRows = pdfReconcileRowsForBillingMonth(accountId, billingMonth);

  const toDelete: number[] = [];
  for (const st of openWebPasteStatementsForBucketMonth(accountId, billingMonth)) {
    for (const line of listCcStatementLinesForStatement(st.id)) {
      const purchaseIso = linePurchaseIso(line);
      const inClosedPeriod =
        closedPeriod != null &&
        purchaseIso != null &&
        purchaseIso >= closedPeriod.from &&
        purchaseIso <= closedPeriod.to;
      if (inClosedPeriod) {
        toDelete.push(line.id);
        continue;
      }
      // Fallback for statements without a parseable period: exact line match.
      if (closedPeriod == null) {
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
  }

  if (!opts?.dryRun && toDelete.length > 0) {
    deleteStatementLinesByIds(toDelete);
    if (!opts?.skipRecompute) {
      recomputeCcBillingMonthBalances(accountId);
    }
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
  opts?: { dryRun?: boolean; skipRecompute?: boolean }
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
