import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cardStatementKind, type CardCanonicalStatement } from "nw-tracker-contracts";
import { requestFeederParse } from "./ingestFeeder.js";
import { resolveCcStatementSlotDir } from "./cfraserPaths.js";
import { db } from "./db.js";
import {
  archivedCreditCardStatementPdfFileName,
  canonicalCcStatementPdfName,
} from "./importSyncDocumentFilePath.js";
import { mergeCardStatements, statementKeysOf } from "./ccInstallmentLedgerMerge.js";
import type { CcImportFlowItem, SkippedCcImportFlowItem } from "./ccStatementsImport.js";
import { cardAccountForStatement, cardLast4OfStatement } from "./cards/documentAccount.js";

export type CcPdfUploadFile = {
  originalname: string;
  buffer: Buffer;
};

export type CcStatementPdfImportResult = {
  account_id: number;
  /** Original upload filenames. */
  files: string[];
  /** Basenames written under `cfraser/credit-card-statements/<card>/clp|usd/` (may differ after rename). */
  saved_pdfs: string[];
  csv_rows: number;
  /** Flat counters + per-line arrays — the shape the import panel reads (parity with checking). */
  lines_parsed: number;
  inserted: number;
  skipped_duplicate: number;
  skipped_fuzzy_duplicate: number;
  skipped_installment_overlap: number;
  overlap_removed: number;
  statement_count: number;
  inserted_flows: CcImportFlowItem[];
  skipped_flows: SkippedCcImportFlowItem[];
  parse_errors: string[];
  statements: {
    statementCount: number;
    linesInserted: number;
    linesSkippedDuplicate: number;
  };
  ledger: {
    purchaseUpserts: number;
    paymentUpserts: number;
  };
  parse_failures: string[];
};

/**
 * Each uploaded PDF goes to the ingest service's card statement parser
 * (`POST /parse/card_statement.pdf`), which answers with its canonical statements (`card.statement`,
 * format `canonical`). A file it cannot read is a parse failure; the service not answering throws.
 */
async function parseUploadedPdfs(files: readonly { name: string; buffer: Buffer }[]): Promise<{
  statements: CardCanonicalStatement[];
  failures: string[];
}> {
  const statements: CardCanonicalStatement[] = [];
  const failures: string[] = [];
  for (const file of files) {
    const answer = await requestFeederParse("card_statement.pdf", file.buffer, file.name);
    if (answer.status === "unavailable") throw new Error(`The PDF could not be read: ${answer.message}`);
    if (answer.status !== "parsed") {
      failures.push(`${file.name}: ${answer.message}`);
      continue;
    }
    if (answer.result.kind !== cardStatementKind.kind || answer.result.schema_version !== cardStatementKind.schema_version) {
      throw new Error(`ingest answered ${answer.result.kind} v${answer.result.schema_version}, not ${cardStatementKind.kind}`);
    }
    const payload = cardStatementKind.payload.parse(answer.result.payload);
    if (payload.format !== "canonical") throw new Error("ingest answered an issuer statement for a statement PDF");
    statements.push(...payload.statements);
  }
  return { statements, failures };
}

function archivePath(destDir: string, fileName: string): string {
  const base = path.basename(fileName).replace(/\s*\(\d+\)(?=\.pdf$)/i, "");
  return path.join(destDir, base);
}

/**
 * Copy parsed uploads into `resolveCfraserPdfsDir()` and align `source_pdf` / ledger sample fields
 * with on-disk basenames when the name changes.
 */
function persistUploadedCcStatementPdfs(opts: {
  tmpDir: string;
  accountId: number;
  bySourcePdf: Map<string, CardCanonicalStatement[]>;
}): string[] {
  const saved: string[] = [];

  const updStmt = db.prepare(
    `UPDATE cc_statements SET source_pdf = ? WHERE account_id = ? AND source_pdf = ?`
  );
  const updPurch = db.prepare(
    `UPDATE cc_installment_purchases SET source_pdf_sample = ? WHERE account_id = ? AND source_pdf_sample = ?`
  );
  const updPay = db.prepare(
    `UPDATE cc_installment_payments SET source_pdf = ?
     WHERE source_pdf = ? AND purchase_id IN (SELECT id FROM cc_installment_purchases WHERE account_id = ?)`
  );

  for (const [oldName, statements] of opts.bySourcePdf) {
    const tmpSrc = path.join(opts.tmpDir, oldName);
    if (!fs.existsSync(tmpSrc)) continue;

    const first = statements[0]!;
    const last4 = first.card_last4 ?? "";
    const usd = first.currency === "usd";
    const destDir = resolveCcStatementSlotDir(last4, usd);
    fs.mkdirSync(destDir, { recursive: true });
    let archiveBase =
      archivedCreditCardStatementPdfFileName({ period_to: first.period_to ?? "", card_last4: last4, currency: first.currency }) ??
      canonicalCcStatementPdfName(first.period_to ?? undefined, last4, { usd }) ??
      oldName;
    if (!archiveBase.toLowerCase().endsWith(".pdf")) {
      archiveBase = `${archiveBase}.pdf`;
    }

    const destPath = archivePath(destDir, archiveBase);
    fs.copyFileSync(tmpSrc, destPath);
    const newBase = path.basename(destPath);
    saved.push(newBase);

    if (newBase !== oldName) {
      const tx = db.transaction(() => {
        updStmt.run(newBase, opts.accountId, oldName);
        updPurch.run(newBase, opts.accountId, oldName);
        updPay.run(newBase, oldName, opts.accountId);
      });
      tx();
    }
  }

  return saved;
}

export async function importCcStatementPdfsForAccount(
  accountId: number,
  files: CcPdfUploadFile[]
): Promise<CcStatementPdfImportResult> {
  if (!files.length) {
    throw new Error("At least one PDF file is required");
  }

  // The uploads are kept here under their own names: `persistUploadedCcStatementPdfs` files
  // each one in its card's statement folder once its lines are imported.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nw-cc-pdf-"));
  const uploadedNames: string[] = [];

  try {
    for (const f of files) {
      const name = f.originalname.endsWith(".pdf") ? f.originalname : `${f.originalname}.pdf`;
      fs.writeFileSync(path.join(tmp, name), f.buffer);
      uploadedNames.push(name);
    }

    const parsed = await parseUploadedPdfs(files.map((f, i) => ({ name: uploadedNames[i]!, buffer: f.buffer })));
    const parseFailures = parsed.failures;
    if (parsed.statements.length === 0) {
      throw new Error(parseFailures[0] ?? "PDF parse produced no output");
    }

    const statements: CardCanonicalStatement[] = [];
    const bySourcePdf = new Map<string, CardCanonicalStatement[]>();
    // Track what the uploaded PDFs actually resolved to, for a diagnosable error.
    const seenLast4: Set<string> = new Set();
    const seenAccountIds: Set<number> = new Set();

    for (const statement of parsed.statements) {
      const src = statement.document;
      // The parser renames PDFs to canonical names (e.g. `155028273.pdf` →
      // `2026-06-26 estado de cuenta tarjeta <last4>.pdf`) so source_pdf never
      // matches the original upload filename. The tmp dir is isolated to the
      // uploaded files, so all rows here come from them — no allowedNames guard needed.
      // Match parity with the CLI/inbox import: prefer the parser's card_last4,
      // fall back to the filename only when it is absent.
      const l4 = cardLast4OfStatement(statement);
      const target = cardAccountForStatement(statement);
      if (l4) seenLast4.add(l4);
      if (target != null) seenAccountIds.add(target);
      if (target !== accountId) continue;
      statements.push(statement);
      const list = bySourcePdf.get(src) ?? [];
      list.push(statement);
      bySourcePdf.set(src, list);
    }

    const lineCount = statements.reduce((n, st) => n + st.lines.length, 0);
    if (lineCount === 0) {
      const last4s = [...seenLast4].sort().join(", ") || "none";
      const accIds = [...seenAccountIds].sort((a, b) => a - b).join(", ") || "none";
      throw new Error(
        `No parsed rows matched this card account (account_id=${accountId}). ` +
          `Parsed card last4: [${last4s}]; resolved to account ids: [${accIds}].`
      );
    }

    const replaceKeys = statementKeysOf(statements);
    const merged = mergeCardStatements(accountId, statements, {
      replaceStatementKeys: replaceKeys,
      replaceLedger: false,
    });

    const savedPdfs = persistUploadedCcStatementPdfs({
      tmpDir: tmp,
      accountId,
      bySourcePdf,
    });

    return {
      account_id: accountId,
      files: uploadedNames,
      saved_pdfs: savedPdfs,
      csv_rows: lineCount,
      lines_parsed: lineCount,
      inserted: merged.statements.linesInserted,
      skipped_duplicate: merged.statements.linesSkippedDuplicate,
      skipped_fuzzy_duplicate: merged.statements.linesSkippedFuzzyDuplicate,
      skipped_installment_overlap: merged.statements.linesSkippedInstallmentOverlap,
      overlap_removed: merged.overlap_removed,
      statement_count: merged.statements.statementCount,
      inserted_flows: merged.statements.inserted_flows,
      skipped_flows: merged.statements.skipped_flows,
      parse_errors: parseFailures,
      statements: {
        statementCount: merged.statements.statementCount,
        linesInserted: merged.statements.linesInserted,
        linesSkippedDuplicate: merged.statements.linesSkippedDuplicate,
      },
      ledger: {
        purchaseUpserts: merged.ledger.purchaseUpserts,
        paymentUpserts: merged.ledger.paymentUpserts,
      },
      parse_failures: parseFailures,
    };
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
