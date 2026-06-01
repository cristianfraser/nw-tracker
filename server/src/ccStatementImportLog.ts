import { insertAppMessage } from "./appMessages.js";
import type { CcStatementCsvRecord } from "./ccStatementsImport.js";

export type CcStatementPdfImportLog = {
  source_pdf: string;
  csv_rows: number;
  currency: string;
  card_last4: string | null;
};

export type CcStatementImportAccountLog = {
  account_id: number;
  account_label: string;
  csv_rows: number;
  statements_merged: number;
  lines_inserted: number;
  lines_skipped_duplicate: number;
  lines_skipped_installment_overlap: number;
  purchase_upserts: number;
  payment_upserts: number;
  pdfs: CcStatementPdfImportLog[];
  warnings: string[];
};

export type CcStatementImportRunLog = {
  dry_run: boolean;
  accounts: CcStatementImportAccountLog[];
};

function groupCsvRowsByPdf(records: readonly CcStatementCsvRecord[]): CcStatementPdfImportLog[] {
  const byPdf = new Map<string, CcStatementPdfImportLog>();
  for (const row of records) {
    const sourcePdf = String(row.source_pdf ?? "").trim();
    if (!sourcePdf || sourcePdf.startsWith("import:web-paste")) continue;
    const cur = byPdf.get(sourcePdf);
    if (cur) {
      cur.csv_rows += 1;
      continue;
    }
    const currency =
      String(row.currency ?? "").toLowerCase() === "usd" ||
      String(row.parser_layout ?? "").trim() === "international_usd"
        ? "usd"
        : "clp";
    byPdf.set(sourcePdf, {
      source_pdf: sourcePdf,
      csv_rows: 1,
      currency,
      card_last4: String(row.card_last4 ?? "").trim() || null,
    });
  }
  return [...byPdf.values()].sort((a, b) => a.source_pdf.localeCompare(b.source_pdf));
}

export function buildCcStatementImportAccountLog(
  accountId: number,
  accountLabel: string,
  records: readonly CcStatementCsvRecord[],
  stats: {
    statements_merged: number;
    lines_inserted: number;
    lines_skipped_duplicate: number;
    lines_skipped_installment_overlap: number;
    purchase_upserts: number;
    payment_upserts: number;
  }
): CcStatementImportAccountLog {
  const pdfs = groupCsvRowsByPdf(records);
  const warnings: string[] = [];
  if (records.length === 0) {
    warnings.push("no CSV rows for this account in the import batch");
  } else if (stats.lines_inserted === 0 && stats.lines_skipped_duplicate === 0) {
    warnings.push("CSV rows present but no statement lines inserted — check parse/organize");
  } else if (stats.lines_inserted === 0 && stats.lines_skipped_duplicate > 0) {
    warnings.push("all lines skipped as duplicates — statement may already be imported");
  }
  for (const pdf of pdfs) {
    if (pdf.csv_rows === 0) {
      warnings.push(`${pdf.source_pdf}: 0 parsed rows`);
    }
  }
  return {
    account_id: accountId,
    account_label: accountLabel,
    csv_rows: records.length,
    pdfs,
    warnings,
    ...stats,
  };
}

export function formatCcStatementImportLogBody(log: CcStatementImportRunLog): string {
  const lines: string[] = [];
  lines.push(log.dry_run ? "Credit card CSV import [dry-run]." : "Credit card CSV import.");
  const totalLines = log.accounts.reduce((n, a) => n + a.lines_inserted, 0);
  const totalCsv = log.accounts.reduce((n, a) => n + a.csv_rows, 0);
  lines.push(
    `Accounts ${log.accounts.length}, ${totalCsv} CSV row(s), ${totalLines} line(s) inserted.`
  );
  for (const acc of log.accounts) {
    lines.push(
      `\nAccount ${acc.account_id} (${acc.account_label}): ${acc.csv_rows} CSV row(s), ` +
        `${acc.statements_merged} statement(s), ${acc.lines_inserted} line(s) inserted, ` +
        `${acc.lines_skipped_duplicate} duplicate skip(s), ` +
        `${acc.purchase_upserts} purchase(s), ${acc.payment_upserts} payment(s).`
    );
    for (const pdf of acc.pdfs) {
      lines.push(
        `  ${pdf.source_pdf} (${pdf.currency}${pdf.card_last4 ? ` ·${pdf.card_last4}` : ""}): ${pdf.csv_rows} CSV row(s)`
      );
    }
    for (const w of acc.warnings) {
      lines.push(`  WARN: ${w}`);
    }
  }
  return lines.join("\n");
}

export function insertCcStatementImportRunLog(log: CcStatementImportRunLog): void {
  if (log.dry_run) return;
  insertAppMessage("log", "Credit card import", formatCcStatementImportLogBody(log));
}

export function logCcStatementImportRun(log: CcStatementImportRunLog): void {
  const prefix = log.dry_run ? "[dry-run] " : "";
  console.log(formatCcStatementImportLogBody(log).replace(/^Credit card/, `${prefix}Credit card`));
  insertCcStatementImportRunLog(log);
}
