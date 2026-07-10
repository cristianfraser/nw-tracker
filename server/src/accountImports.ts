import { accountBucketKindSlug } from "./accountBucket.js";
import { db } from "./db.js";
import { importCcStatementPdfsForAccount, type CcPdfUploadFile } from "./ccStatementPdfUpload.js";
import {
  ccWebPasteToCsvRecords,
  newWebPasteBatchId,
  parseCcWebPasteText,
  creditCardMasterMetaForAccount,
} from "./ccWebPasteParse.js";
import { mergeCcAccountFromParsedRows } from "./ccInstallmentLedgerMerge.js";
import {
  checkingAccountId,
  importCheckingCartola,
  isCheckingCartolaMonthImported,
} from "./checkingCartolaImport.js";
import { parseCheckingCartolaBuffer, periodMonthFromCartolaFileName } from "./checkingCartolaParse.js";
import { importCheckingPartialMovements } from "./checkingPartialMovementsImport.js";
import { parseCuentaVistaWebPasteText } from "./cuentaVistaWebPasteParse.js";
import { isUltimosMovimientosWorkbook, parseUltimosMovimientosRows } from "./checkingUltimosMovimientosParse.js";
import { createImportBatch } from "./importBatches.js";
import type { DocumentImportType } from "./accountDocumentRegistry.js";
import XLSX from "xlsx";

function assertCreditCardAccount(accountId: number): void {
  const row = db
    .prepare(
      `SELECT g.slug AS bucket_slug FROM accounts a JOIN asset_groups g ON g.id = a.asset_group_id WHERE a.id = ?`
    )
    .get(accountId) as { bucket_slug: string } | undefined;
  if (!row || accountBucketKindSlug(row.bucket_slug) !== "credit_card") {
    throw new Error("Account is not a credit card");
  }
}

export function importCcWebPaste(accountId: number, text: string) {
  assertCreditCardAccount(accountId);
  const meta = creditCardMasterMetaForAccount(accountId);
  if (!meta) throw new Error("Not a credit card master account");

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
    lines_parsed: parsed.lines.length,
    inserted: merged.statements.linesInserted,
    skipped_duplicate: merged.statements.linesSkippedDuplicate,
    skipped_fuzzy_duplicate: merged.statements.linesSkippedFuzzyDuplicate,
    skipped_installment_overlap: merged.statements.linesSkippedInstallmentOverlap,
    overlap_removed: merged.overlap_removed ?? 0,
    parse_errors: parsed.errors,
  };
}

function assertCuentaVistaAccount(accountId: number): void {
  const row = db
    .prepare(
      `SELECT g.slug AS bucket_slug FROM accounts a JOIN asset_groups g ON g.id = a.asset_group_id WHERE a.id = ?`
    )
    .get(accountId) as { bucket_slug: string } | undefined;
  if (!row || accountBucketKindSlug(row.bucket_slug) !== "cuenta_vista") {
    throw new Error("Account is not cuenta vista");
  }
}

export function importCuentaVistaWebPaste(accountId: number, text: string) {
  assertCuentaVistaAccount(accountId);
  const parsed = parseCuentaVistaWebPasteText(text);
  if (parsed.movements.length === 0) {
    return {
      batch_id: null,
      lines_parsed: 0,
      inserted: 0,
      skipped_duplicate: 0,
      parse_errors: parsed.errors,
    };
  }

  const result = importCheckingPartialMovements(accountId, parsed.movements);
  const batch_id = createImportBatch(
    "cuenta_vista_web_paste",
    `web-paste|${newWebPasteBatchId()}`,
    {
      account_id: accountId,
      lines_parsed: parsed.movements.length,
      ...result,
      parse_errors: parsed.errors,
    }
  );

  return {
    batch_id,
    lines_parsed: parsed.movements.length,
    ...result,
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
        `SELECT g.slug AS bucket_slug FROM accounts a JOIN asset_groups g ON g.id = a.asset_group_id WHERE a.id = ?`
      )
      .get(accountId) as { bucket_slug: string } | undefined;
    if (!row || accountBucketKindSlug(row.bucket_slug) !== "cuenta_corriente") {
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
      const { movementsInserted, movementsSkipped, inserted_flows, skipped_flows } =
        importCheckingCartola(effectiveId, cartola);
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
        inserted_flows,
        skipped_flows,
        errors: cartola.skipped.map((s) => s.reason),
      };
    }
    parsed = parseUltimosMovimientosRows(rows, filename);
  }

  const { inserted, skipped_duplicate, inserted_flows, skipped_flows } =
    importCheckingPartialMovements(effectiveId, parsed.movements);
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
    inserted_flows,
    skipped_flows,
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
    const { movementsInserted, movementsSkipped, inserted_flows, skipped_flows } =
      importCheckingCartola(effectiveId, cartola);
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
      inserted_flows,
      skipped_flows,
      already_imported_month: true,
    };
  }

  const { movementsInserted, movementsSkipped, inserted_flows, skipped_flows } =
    importCheckingCartola(effectiveId, cartola);
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
    inserted_flows,
    skipped_flows,
    already_imported_month: false,
  };
}

/**
 * Per-account document uploads. The AFP UNO cert upload was retired 2026-07 (the cuota
 * ledger is certificate-rebuilt and maintained manually); the spec registry is empty, so
 * the client renders no upload buttons and any request lands here as unknown.
 */
export function importAccountDocument(
  _accountId: number,
  type: DocumentImportType,
  _buffer: Buffer,
  _filename: string,
  _mimetype: string
): never {
  throw new Error(`Unknown document import type: ${type}`);
}

export { periodMonthFromCartolaFileName };
