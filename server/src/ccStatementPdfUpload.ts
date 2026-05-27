import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readCommaCsvRecords } from "./ccParsedCommaCsv.js";
import { resolveCfraserPdfsDir } from "./cfraserPaths.js";
import { db } from "./db.js";
import {
  archivedCreditCardStatementPdfFileName,
  canonicalCcStatementPdfName,
} from "./importSyncDocumentFilePath.js";
import {
  mergeCcAccountFromParsedRows,
  replaceStatementKeysFromRecords,
} from "./ccInstallmentLedgerMerge.js";
import type { CcStatementCsvRecord } from "./ccStatementsImport.js";
import { resolveMasterAccountIdForImportCardLast4 } from "./ccConsolidatedCards.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const PARSE_SCRIPT = path.join(REPO_ROOT, "server", "scripts", "parse-cc-statement-pdfs.py");

export type CcPdfUploadFile = {
  originalname: string;
  buffer: Buffer;
};

export type CcStatementPdfImportResult = {
  account_id: number;
  /** Original upload filenames. */
  files: string[];
  /** Basenames written under `cfraser/credit-card-statements/` (may differ after rename). */
  saved_pdfs: string[];
  csv_rows: number;
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

function cardLast4FromFilename(name: string): string | null {
  const m = /(\d{4})\.pdf$/i.exec(name);
  return m?.[1] ?? null;
}

function runParsePdfsInDir(pdfDir: string, outCsv: string): string[] {
  const env = {
    ...process.env,
    CFRASER_PDFS_DIR: pdfDir,
    CC_PARSE_OUTPUT_CSV: outCsv,
  };
  const r = spawnSync("python3", [PARSE_SCRIPT], {
    cwd: REPO_ROOT,
    env,
    encoding: "utf8",
    timeout: 120_000,
  });
  const failures: string[] = [];
  if (r.status !== 0) {
    failures.push(r.stderr?.trim() || r.stdout?.trim() || `parse exit ${r.status}`);
  }
  return failures;
}

function uniqueArchivePath(destDir: string, fileName: string): string {
  const base = path.basename(fileName);
  if (!base.toLowerCase().endsWith(".pdf")) {
    return path.join(destDir, base);
  }
  const stem = base.slice(0, -4);
  let dest = path.join(destDir, `${stem}.pdf`);
  if (!fs.existsSync(dest)) return dest;
  let n = 2;
  for (;;) {
    const cand = path.join(destDir, `${stem} (${n}).pdf`);
    if (!fs.existsSync(cand)) return cand;
    n += 1;
  }
}

/**
 * Copy parsed uploads into `resolveCfraserPdfsDir()` and align `source_pdf` / ledger sample fields
 * with on-disk basenames when the name changes.
 */
function persistUploadedCcStatementPdfs(opts: {
  tmpDir: string;
  accountId: number;
  bySourcePdf: Map<string, CcStatementCsvRecord[]>;
}): string[] {
  const destDir = resolveCfraserPdfsDir();
  fs.mkdirSync(destDir, { recursive: true });
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

  for (const [oldName, rows] of opts.bySourcePdf) {
    const tmpSrc = path.join(opts.tmpDir, oldName);
    if (!fs.existsSync(tmpSrc)) continue;

    const first = rows[0]!;
    const last4 = String(first.card_last4 ?? "").trim();
    let archiveBase =
      archivedCreditCardStatementPdfFileName(first) ??
      canonicalCcStatementPdfName(first.period_to, last4) ??
      oldName;
    if (!archiveBase.toLowerCase().endsWith(".pdf")) {
      archiveBase = `${archiveBase}.pdf`;
    }

    const destPath = uniqueArchivePath(destDir, archiveBase);
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

export function importCcStatementPdfsForAccount(
  accountId: number,
  files: CcPdfUploadFile[]
): CcStatementPdfImportResult {
  if (!files.length) {
    throw new Error("At least one PDF file is required");
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nw-cc-pdf-"));
  const outCsv = path.join(tmp, "parsed.csv");
  const uploadedNames: string[] = [];

  try {
    for (const f of files) {
      const name = f.originalname.endsWith(".pdf") ? f.originalname : `${f.originalname}.pdf`;
      fs.writeFileSync(path.join(tmp, name), f.buffer);
      uploadedNames.push(name);
    }

    const parseFailures = runParsePdfsInDir(tmp, outCsv);
    if (!fs.existsSync(outCsv)) {
      throw new Error(parseFailures[0] ?? "PDF parse produced no output");
    }

    const allRecords = readCommaCsvRecords(outCsv);
    const allowedNames = new Set(uploadedNames);
    const records: CcStatementCsvRecord[] = [];
    const bySourcePdf = new Map<string, CcStatementCsvRecord[]>();

    for (const row of allRecords) {
      const src = String(row.source_pdf ?? "").trim();
      if (!allowedNames.has(src)) continue;
      const l4 = cardLast4FromFilename(src) ?? String(row.card_last4 ?? "").trim();
      const target = resolveMasterAccountIdForImportCardLast4(l4);
      if (target !== accountId) continue;
      records.push(row);
      const list = bySourcePdf.get(src) ?? [];
      list.push(row);
      bySourcePdf.set(src, list);
    }

    if (records.length === 0) {
      throw new Error("No parsed rows matched this card account");
    }

    const replaceKeys = replaceStatementKeysFromRecords(records);
    const merged = mergeCcAccountFromParsedRows(accountId, records, {
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
      csv_rows: records.length,
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
