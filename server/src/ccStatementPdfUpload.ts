import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readCommaCsvRecords } from "./ccParsedCommaCsv.js";
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
  files: string[];
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

    for (const row of allRecords) {
      const src = String(row.source_pdf ?? "").trim();
      if (!allowedNames.has(src)) continue;
      const l4 = cardLast4FromFilename(src) ?? String(row.card_last4 ?? "").trim();
      const target = resolveMasterAccountIdForImportCardLast4(l4);
      if (target !== accountId) continue;
      records.push(row);
    }

    if (records.length === 0) {
      throw new Error("No parsed rows matched this card account");
    }

    const replaceKeys = replaceStatementKeysFromRecords(records);
    const merged = mergeCcAccountFromParsedRows(accountId, records, {
      replaceStatementKeys: replaceKeys,
      replaceLedger: false,
    });

    return {
      account_id: accountId,
      files: uploadedNames,
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
