import { execFileSync } from "node:child_process";
import { db } from "./db.js";
import { parseAfpCertificadoBody } from "./afpUnoCertMovimientosParse.js";
import { applyAfpUnoCertificadoCuotasToMovements } from "./afpUnoCertMovementSync.js";
import {
  importCcStatementPdfsForAccount,
  type CcPdfUploadFile,
} from "./ccStatementPdfUpload.js";
import {
  ccWebPasteToCsvRecords,
  newWebPasteBatchId,
  parseCcWebPasteText,
  santanderCardMetaForAccount,
} from "./ccWebPasteParse.js";
import { mergeCcAccountFromParsedRows } from "./ccInstallmentLedgerMerge.js";
import {
  checkingAccountId,
  importCheckingCartola,
  isCheckingCartolaMonthImported,
} from "./checkingCartolaImport.js";
import {
  parseCheckingCartolaBuffer,
  periodMonthFromCartolaFileName,
} from "./checkingCartolaParse.js";
import { importCheckingPartialMovements } from "./checkingPartialMovementsImport.js";
import {
  isUltimosMovimientosWorkbook,
  parseUltimosMovimientosBuffer,
  parseUltimosMovimientosRows,
} from "./checkingUltimosMovimientosParse.js";
import { createImportBatch } from "./importBatches.js";
import type { DocumentImportType } from "./accountDocumentRegistry.js";
import XLSX from "xlsx";

function assertCreditCardAccount(accountId: number): void {
  const row = db
    .prepare(
      `SELECT c.slug AS category_slug FROM accounts a JOIN categories c ON c.id = a.category_id WHERE a.id = ?`
    )
    .get(accountId) as { category_slug: string } | undefined;
  if (row?.category_slug !== "credit_card") {
    throw new Error("Account is not a credit card");
  }
}

export function importCcWebPaste(accountId: number, text: string) {
  assertCreditCardAccount(accountId);
  const meta = santanderCardMetaForAccount(accountId);
  if (!meta) throw new Error("Not a Santander card master account");

  const parsed = parseCcWebPasteText(text);
  if (parsed.lines.length === 0) {
    return {
      batch_id: null,
      inserted: 0,
      skipped_duplicate: 0,
      parse_errors: parsed.errors,
    };
  }

  const batchId = newWebPasteBatchId();
  const records = ccWebPasteToCsvRecords(
    accountId,
    meta.cardGroup,
    meta.cardLast4,
    batchId,
    parsed.lines
  );
  const merged = mergeCcAccountFromParsedRows(accountId, records, { replaceLedger: false });

  const batch_id = createImportBatch("cc_web_paste", `web-paste|${batchId}`, {
    account_id: accountId,
    lines_parsed: parsed.lines.length,
    ...merged.statements,
    ledger: merged.ledger,
    parse_errors: parsed.errors,
  });

  return {
    batch_id,
    inserted: merged.statements.linesInserted,
    skipped_duplicate: merged.statements.linesSkippedDuplicate,
    skipped_installment_overlap: merged.statements.linesSkippedInstallmentOverlap,
    overlap_removed: merged.overlap_removed ?? 0,
    parse_errors: parsed.errors,
  };
}

export function importCcStatementPdfUpload(
  accountId: number,
  files: CcPdfUploadFile[]
) {
  assertCreditCardAccount(accountId);
  const result = importCcStatementPdfsForAccount(accountId, files);
  const batch_id = createImportBatch(
    "cc_statement_pdf",
    result.files.join(", "),
    result
  );
  return { batch_id, ...result };
}

export function importCheckingRecentXlsx(
  accountId: number,
  buffer: Buffer,
  filename: string
) {
  const checkingId = checkingAccountId();
  if (accountId !== checkingId) {
    const row = db
      .prepare(
        `SELECT c.slug FROM accounts a JOIN categories c ON c.id = a.category_id WHERE a.id = ?`
      )
      .get(accountId) as { slug: string } | undefined;
    if (row?.slug !== "cuenta_corriente") {
      throw new Error("Account is not cuenta corriente");
    }
  }
  const effectiveId = checkingId;

  const wb = XLSX.read(buffer, { type: "buffer" });
  const sheet = wb.Sheets[wb.SheetNames[0]!]!;
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" }) as unknown[][];

  let parsed;
  if (isUltimosMovimientosWorkbook(rows)) {
    parsed = parseUltimosMovimientosRows(rows, filename);
  } else {
    const cartola = parseCheckingCartolaBuffer(buffer, filename);
    if (cartola.movements.length > 0 && cartola.period_month) {
      const { movementsInserted, movementsSkipped } = importCheckingCartola(
        effectiveId,
        cartola
      );
      const batch_id = createImportBatch("checking_cartola_xlsx", filename, {
        format: "cartola",
        movements_inserted: movementsInserted,
        movements_skipped: movementsSkipped,
        period_month: cartola.period_month,
      });
      return {
        batch_id,
        format: "cartola" as const,
        inserted: movementsInserted,
        skipped_duplicate: movementsSkipped,
        errors: cartola.skipped.map((s) => s.reason),
      };
    }
    parsed = parseUltimosMovimientosRows(rows, filename);
  }

  const { inserted, skipped_duplicate } = importCheckingPartialMovements(
    effectiveId,
    parsed.movements
  );
  const batch_id = createImportBatch("checking_recent_xlsx", filename, {
    format: "ultimos_movimientos",
    inserted,
    skipped_duplicate,
    errors: parsed.errors,
  });
  return {
    batch_id,
    format: "ultimos_movimientos" as const,
    inserted,
    skipped_duplicate,
    parse_errors: parsed.errors,
  };
}

export function importCheckingCartolaXlsx(
  accountId: number,
  buffer: Buffer,
  filename: string,
  opts?: { replaceMonth?: string }
) {
  const effectiveId = checkingAccountId();
  if (accountId !== effectiveId) {
    throw new Error("Use the cuenta corriente account for cartola import");
  }

  const cartola = parseCheckingCartolaBuffer(buffer, filename);
  if (!cartola.period_month) {
    throw new Error("Could not determine cartola period month from file name");
  }

  if (opts?.replaceMonth === cartola.period_month) {
    db.prepare(
      `DELETE FROM movements WHERE account_id = ? AND note LIKE ?`
    ).run(effectiveId, `import:cartola|${cartola.period_month}|%`);
    db.prepare(
      `DELETE FROM checking_cartola_imports WHERE account_id = ? AND period_month = ?`
    ).run(effectiveId, cartola.period_month);
  } else if (isCheckingCartolaMonthImported(effectiveId, cartola.period_month)) {
    const { movementsInserted, movementsSkipped } = importCheckingCartola(
      effectiveId,
      cartola
    );
    const batch_id = createImportBatch("checking_cartola_xlsx", filename, {
      period_month: cartola.period_month,
      movements_inserted: movementsInserted,
      movements_skipped: movementsSkipped,
      merged: true,
    });
    return {
      batch_id,
      period_month: cartola.period_month,
      inserted: movementsInserted,
      skipped_duplicate: movementsSkipped,
      already_imported_month: true,
    };
  }

  const { movementsInserted, movementsSkipped } = importCheckingCartola(effectiveId, cartola);
  const batch_id = createImportBatch("checking_cartola_xlsx", filename, {
    period_month: cartola.period_month,
    movements_inserted: movementsInserted,
    movements_skipped: movementsSkipped,
  });
  return {
    batch_id,
    period_month: cartola.period_month,
    inserted: movementsInserted,
    skipped_duplicate: movementsSkipped,
    already_imported_month: false,
  };
}

function readCertBodyFromUpload(
  buffer: Buffer,
  filename: string,
  mimetype: string
): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".csv") || lower.endsWith(".txt") || mimetype.includes("text")) {
    return buffer.toString("utf8");
  }
  if (lower.endsWith(".pdf") || mimetype === "application/pdf") {
    try {
      return execFileSync("pdftotext", ["-layout", "-", "-"], {
        input: buffer,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      });
    } catch {
      throw new Error(
        "Could not run pdftotext on PDF. Install Poppler or upload CSV/TXT export."
      );
    }
  }
  throw new Error("Unsupported file type (use PDF, CSV, or TXT)");
}

export function importAccountDocument(
  accountId: number,
  type: DocumentImportType,
  buffer: Buffer,
  filename: string,
  mimetype: string
) {
  if (type === "afp_uno_cert") {
    const slug = db
      .prepare(
        `SELECT c.slug FROM accounts a JOIN categories c ON c.id = a.category_id WHERE a.id = ?`
      )
      .get(accountId) as { slug: string } | undefined;
    if (slug?.slug !== "afp") throw new Error("Account is not AFP");

    const body = readCertBodyFromUpload(buffer, filename, mimetype);
    const parsed = parseAfpCertificadoBody(body, filename);
    const result = applyAfpUnoCertificadoCuotasToMovements({
      accountId,
      certText: body,
      certSourceFileName: filename,
      dryRun: false,
      seedFundUnitDaily: true,
    });
    const batch_id = createImportBatch("afp_uno_cert", filename, {
      rows_parsed: parsed.rows.length,
      ...result,
    });
    return { batch_id, type, ...result, rows_parsed: parsed.rows.length };
  }

  throw new Error(`Unknown document import type: ${type}`);
}

export { periodMonthFromCartolaFileName };
