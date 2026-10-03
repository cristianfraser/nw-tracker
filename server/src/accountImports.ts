import { accountBucketKindSlug } from "./accountBucket.js";
import { db } from "./db.js";
import { importCcStatementPdfsForAccount, type CcPdfUploadFile } from "./ccStatementPdfUpload.js";
import {
  ccWebPasteToCsvRecords,
  newWebPasteBatchId,
  creditCardMasterMetaForAccount,
  webPasteLinesFromPastedListing,
  type CcWebPasteParseResult,
  type CcWebPasteRecordsOpts,
} from "./ccWebPasteParse.js";
import type { GroceryBranchLearningResult } from "./groceryBranchLearning.js";
import { mergeCcAccountFromParsedRows } from "./ccInstallmentLedgerMerge.js";
import { applyWebPasteInstallmentFirstDueNudges } from "./ccWebPasteInstallmentNudge.js";
import { removeTruncatedMerchantDuplicateLines } from "./ccTruncatedMerchantDedupe.js";
import { upsertCreditCardValuationsFromLedger } from "./ccCreditCardValuations.js";
import { recomputeCcBillingMonthBalances } from "./ccBillingBalances.js";
import {
  checkingAccountId,
  importCheckingCartola,
  isCheckingCartolaMonthImported,
} from "./checkingCartolaImport.js";
import { bankAccountStatementsKind, CARD_PASTED_LISTING, cardPastedListingSchema } from "nw-tracker-contracts";
import { parsedCartolaFromStatement } from "./bankAccountStatementsApply.js";
import type { ParsedCheckingCartola } from "./checkingCartolaParse.js";
import { requestFeederParse } from "./ingestFeeder.js";
import { importCheckingPartialMovements } from "./checkingPartialMovementsImport.js";
import { parseCuentaVistaWebPasteText } from "./cuentaVistaWebPasteParse.js";
import { createImportBatch, type ImportBatchKind } from "./importBatches.js";
import type {
  CcImportFlowItem,
  SkippedCcImportFlowItem,
} from "./ccStatementsImport.js";
import type { DocumentImportType } from "./accountDocumentRegistry.js";

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

/**
 * Import already-parsed web-paste lines.
 *
 * Shared by the manual paste and the Santander fetcher: both produce `CcWebPasteLine[]`, and every
 * behaviour that matters downstream — dedupe keys, installment overlap, first-due nudges, the batch
 * log — lives here so the two entry points cannot drift apart.
 *
 * @param batchKind `import_batches` kind, so a fetched import is distinguishable from a pasted one.
 */
export function importCcWebPasteLines(
  accountId: number,
  parsed: CcWebPasteParseResult,
  batchKind: ImportBatchKind = "cc_web_paste",
  opts?: CcWebPasteRecordsOpts
) {
  assertCreditCardAccount(accountId);
  const meta = creditCardMasterMetaForAccount(accountId);

  if (parsed.lines.length === 0) {
    return {
      batch_id: null,
      lines_parsed: 0,
      inserted: 0,
      skipped_duplicate: 0,
      skipped_duplicate_in_paste: 0,
      skipped_cuota_billing: 0,
      skipped_saldo_inicial: 0,
      inserted_flows: [] as CcImportFlowItem[],
      skipped_flows: [] as SkippedCcImportFlowItem[],
      grocery_branch_learning: { learned: [], ambiguous: [] } as GroceryBranchLearningResult,
      parse_errors: parsed.errors,
    };
  }

  const batchId = newWebPasteBatchId();
  const { records, skipped_in_paste, skipped_cuota_billing, skipped_saldo_inicial } = ccWebPasteToCsvRecords(
    accountId,
    meta.cardGroup,
    meta.cardLast4,
    batchId,
    parsed.lines,
    opts
  );
  const merged = mergeCcAccountFromParsedRows(accountId, records, { replaceLedger: false });

  // A pasted line that re-lists a manual plan's upcoming cuota is import-skipped as an overlap,
  // but it is evidence of the plan's real first-cuota month. Pin it (write-once) so the open
  // facturación and the projected months bill the cuota in the right cycle.
  const firstDueNudges = applyWebPasteInstallmentFirstDueNudges(accountId, parsed.lines);

  // The scraper feed and a manual web paste describe the same transaction with different merchant
  // widths, so the one-shot key cannot collapse them; this runs after every write (either source)
  // and drops the truncated re-listing once its fuller twin exists.
  const truncatedDedupe = removeTruncatedMerchantDuplicateLines(accountId);
  if (truncatedDedupe.removed_count > 0) {
    upsertCreditCardValuationsFromLedger(accountId, {
      affectedEvidenceFromYmd: truncatedDedupe.removed_from_date,
    });
    recomputeCcBillingMonthBalances(accountId);
  }

  // Per-line arrays stay out of the batch log — counters only.
  const { inserted_flows, skipped_flows, ...statementCounters } = merged.statements;
  const batch_id = createImportBatch(batchKind, `web-paste|${batchId}`, {
    account_id: accountId,
    lines_parsed: parsed.lines.length,
    ...statementCounters,
    skipped_duplicate_in_paste: skipped_in_paste.length,
    skipped_cuota_billing: skipped_cuota_billing.length,
    skipped_saldo_inicial: skipped_saldo_inicial.length,
    ledger: merged.ledger,
    installment_first_due_nudges: firstDueNudges,
    truncated_merchant_dedupe: truncatedDedupe.removed_pairs,
    grocery_branch_learning: merged.grocery_branch_learning,
    parse_errors: parsed.errors,
  });

  return {
    batch_id,
    lines_parsed: parsed.lines.length,
    inserted: merged.statements.linesInserted,
    skipped_duplicate: merged.statements.linesSkippedDuplicate,
    skipped_fuzzy_duplicate: merged.statements.linesSkippedFuzzyDuplicate,
    skipped_installment_overlap: merged.statements.linesSkippedInstallmentOverlap,
    skipped_duplicate_in_paste: skipped_in_paste.length,
    skipped_cuota_billing: skipped_cuota_billing.length,
    skipped_saldo_inicial: skipped_saldo_inicial.length,
    overlap_removed: merged.overlap_removed ?? 0,
    installment_first_due_nudges: firstDueNudges,
    truncated_merchant_dedupe: truncatedDedupe.removed_pairs,
    grocery_branch_learning: merged.grocery_branch_learning,
    inserted_flows,
    skipped_flows: [
      ...skipped_flows,
      ...skipped_in_paste.map((f) => ({ ...f, reason: "duplicate_in_paste" as const })),
      ...skipped_cuota_billing.map((f) => ({ ...f, reason: "cuota_billing" as const })),
      ...skipped_saldo_inicial.map((f) => ({ ...f, reason: "saldo_inicial" as const })),
    ],
    parse_errors: parsed.errors,
  };
}

/**
 * Manual paste from the account page: the ingest service reads the pasted text
 * (`POST /parse/card.web_paste` → `card.pasted_listing`), then the lines import into this card.
 * The account is checked first, so a paste on the wrong account never reaches the service.
 */
export async function importCcWebPaste(accountId: number, text: string) {
  creditCardMasterMetaForAccount(accountId);
  const answer = await requestFeederParse("card.web_paste", Buffer.from(text, "utf8"), "paste.txt");
  if (answer.status === "unavailable") throw new Error(`The paste could not be read: ${answer.message}`);
  if (answer.status !== "parsed") throw new Error(answer.message);
  if (answer.result.kind !== CARD_PASTED_LISTING.kind || answer.result.schema_version !== CARD_PASTED_LISTING.schema_version) {
    throw new Error(`ingest answered ${answer.result.kind} v${answer.result.schema_version}, not ${CARD_PASTED_LISTING.kind}`);
  }
  return importCcWebPasteLines(accountId, webPasteLinesFromPastedListing(cardPastedListingSchema.parse(answer.result.payload)));
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

export async function importCcStatementPdfUpload(
  accountId: number,
  files: CcPdfUploadFile[]
) {
  assertCreditCardAccount(accountId);
  const result = await importCcStatementPdfsForAccount(accountId, files);
  // Per-line arrays stay out of the batch log — counters only.
  const { inserted_flows: _if, skipped_flows: _sf, ...batchMeta } = result;
  const batch_id = createImportBatch(
    "cc_statement_pdf",
    result.files.join(", "),
    batchMeta
  );
  return { batch_id, ...result };
}

/** Throws unless the account is the cuenta corriente (uploads into it land on the checking ledger). */
export function assertCheckingUploadAccount(accountId: number): number {
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
  return checkingId;
}

/**
 * A monthly cartola uploaded as xlsx on the checking account's «recent movements» box (the
 * ingest service said it is not an «últimos movimientos» workbook). Throws when it is no cartola
 * either.
 */
export async function importCheckingCartolaFromRecentXlsxUpload(accountId: number, buffer: Buffer, filename: string) {
  const effectiveId = assertCheckingUploadAccount(accountId);
  let cartola: ParsedCheckingCartola;
  try {
    cartola = await parseCartolaXlsxUpload(buffer, filename);
  } catch (err) {
    throw new Error(`${filename}: neither an «últimos movimientos» workbook nor a cartola (${err instanceof Error ? err.message : String(err)})`);
  }
  if (cartola.movements.length === 0 || !cartola.period_month) {
    throw new Error(`${filename}: neither an «últimos movimientos» workbook nor a cartola`);
  }
  const { movementsInserted, movementsSkipped, inserted_flows, skipped_flows } = importCheckingCartola(effectiveId, cartola);
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

/**
 * A monthly cartola xlsx uploaded in the app: the ingest service reads it
 * (`POST /parse/santander.checking_cartola_xlsx`) and answers with the statement; a file it
 * cannot read throws with its reason.
 */
async function parseCartolaXlsxUpload(buffer: Buffer, filename: string): Promise<ParsedCheckingCartola> {
  const answer = await requestFeederParse("santander.checking_cartola_xlsx", buffer, filename);
  if (answer.status === "unavailable") throw new Error(`The file could not be read: ${answer.message}`);
  if (answer.status !== "parsed") throw new Error(answer.message);
  if (answer.result.kind !== bankAccountStatementsKind.kind || answer.result.schema_version !== bankAccountStatementsKind.schema_version) {
    throw new Error(`ingest answered ${answer.result.kind} v${answer.result.schema_version}, not ${bankAccountStatementsKind.kind}`);
  }
  const [statement] = bankAccountStatementsKind.payload.parse(answer.result.payload).statements;
  if (!statement) throw new Error(`${filename}: no cartola in the file`);
  return parsedCartolaFromStatement(statement);
}

export async function importCheckingCartolaXlsx(
  accountId: number,
  buffer: Buffer,
  filename: string,
  opts?: { replaceMonth?: string }
) {
  const effectiveId = checkingAccountId();
  if (accountId !== effectiveId) {
    throw new Error("Use the cuenta corriente account for cartola import");
  }

  const cartola = await parseCartolaXlsxUpload(buffer, filename);
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

