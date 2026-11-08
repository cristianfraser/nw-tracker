import { accountBucketKindSlug } from "./accountBucket.js";
import { db } from "./db.js";
import { importCcStatementPdfsForAccount, type CcPdfUploadFile } from "./ccStatementPdfUpload.js";
import {
  newWebPasteBatchId,
  creditCardMasterMetaForAccount,
  webPasteLinesFromPastedListing,
} from "./ccWebPasteParse.js";
import { insertLines } from "./cards/lineWrites.js";
import { checkingAccountId } from "./checkingCartolaImport.js";
import {
  bankAccountStatementsKind,
  CARD_PASTED_LISTING,
  cardPastedListingSchema,
  type BankAccountStatementsPayload,
} from "nw-tracker-contracts";
import { applyBankAccountStatements } from "./bankAccountStatementsApply.js";
import { requestFeederParse } from "./ingestFeeder.js";
import {
  importCheckingPartialMovements,
  type ImportFlowItem,
  type SkippedImportFlowItem,
} from "./checkingPartialMovementsImport.js";
import { parseCuentaVistaWebPasteText } from "./cuentaVistaWebPasteParse.js";
import { createImportBatch } from "./importBatches.js";
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
 * A card's listing lines into its open buckets: the card-line funnel's listing import
 * (`cards/lineWrites.ts` `insertLines`). Kept under this name for the callers outside the card
 * writers (store receipts, payment receipts).
 */
export const importCcWebPasteLines = insertLines;

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
  return insertLines(accountId, webPasteLinesFromPastedListing(cardPastedListingSchema.parse(answer.result.payload)));
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
 * either. Applied like every cartola (`applyBankAccountStatements`).
 */
export async function importCheckingCartolaFromRecentXlsxUpload(accountId: number, buffer: Buffer, filename: string) {
  assertCheckingUploadAccount(accountId);
  let payload: BankAccountStatementsPayload;
  try {
    payload = await parseCartolaXlsxUpload(buffer, filename);
  } catch (err) {
    throw new Error(`${filename}: neither an «últimos movimientos» workbook nor a cartola (${err instanceof Error ? err.message : String(err)})`);
  }
  const statement = payload.statements[0];
  if (!statement || statement.movements.length === 0 || !statement.period_month) {
    throw new Error(`${filename}: neither an «últimos movimientos» workbook nor a cartola`);
  }
  const applied = applyCartolaUpload(payload, filename);
  return {
    batch_id: applied.batch_id,
    format: "cartola" as const,
    inserted: applied.inserted,
    skipped_duplicate: applied.skipped_duplicate,
    inserted_flows: applied.inserted_flows,
    skipped_flows: applied.skipped_flows,
    errors: statement.skipped_rows.map((s) => s.reason),
  };
}

/**
 * A monthly cartola xlsx uploaded in the app: the ingest service reads it
 * (`POST /parse/santander.checking_cartola_xlsx`) and answers with the statement; a file it
 * cannot read throws with its reason.
 */
async function parseCartolaXlsxUpload(buffer: Buffer, filename: string): Promise<BankAccountStatementsPayload> {
  const answer = await requestFeederParse("santander.checking_cartola_xlsx", buffer, filename);
  if (answer.status === "unavailable") throw new Error(`The file could not be read: ${answer.message}`);
  if (answer.status !== "parsed") throw new Error(answer.message);
  if (answer.result.kind !== bankAccountStatementsKind.kind || answer.result.schema_version !== bankAccountStatementsKind.schema_version) {
    throw new Error(`ingest answered ${answer.result.kind} v${answer.result.schema_version}, not ${bankAccountStatementsKind.kind}`);
  }
  const payload = bankAccountStatementsKind.payload.parse(answer.result.payload);
  if (payload.statements.length === 0) throw new Error(`${filename}: no cartola in the file`);
  if (payload.account.product !== "checking") throw new Error(`${filename}: not a cuenta corriente cartola`);
  return payload;
}

/** An uploaded cartola through the one cartola path, logged as an upload batch. */
function applyCartolaUpload(payload: BankAccountStatementsPayload, filename: string) {
  const flows = { inserted: [] as ImportFlowItem[], skipped: [] as SkippedImportFlowItem[] };
  const details = applyBankAccountStatements(payload, flows);
  const failed = details.files.find((f) => f.status === "parse_error");
  if (failed) throw new Error(`${filename}: ${failed.error ?? "the cartola could not be imported"}`);
  const periodMonth = payload.statements[0]!.period_month;
  const alreadyImported = details.files.every((f) => f.status !== "imported");
  const inserted = details.files.reduce((n, f) => n + f.movements_imported, 0);
  const batch_id = createImportBatch("checking_cartola_xlsx", filename, {
    period_month: periodMonth,
    movements_inserted: inserted,
    movements_skipped: flows.skipped.length,
    statuses: details.files.map((f) => f.status),
  });
  return {
    batch_id,
    period_month: periodMonth,
    inserted,
    skipped_duplicate: flows.skipped.length,
    inserted_flows: flows.inserted,
    skipped_flows: flows.skipped,
    already_imported_month: alreadyImported,
  };
}

/**
 * The cartola upload of the cuenta corriente: the same path as the ingest kind (one period
 * imported once; a stored month replaced only by count, or by `replaceMonth` = that period).
 */
export async function importCheckingCartolaXlsx(
  accountId: number,
  buffer: Buffer,
  filename: string,
  opts?: { replaceMonth?: string }
) {
  if (accountId !== checkingAccountId()) {
    throw new Error("Use the cuenta corriente account for cartola import");
  }
  const payload = await parseCartolaXlsxUpload(buffer, filename);
  const periodMonth = payload.statements[0]!.period_month;
  if (!periodMonth) {
    throw new Error("Could not determine cartola period month from file name");
  }
  return applyCartolaUpload({ ...payload, force_reimport: opts?.replaceMonth === periodMonth }, filename);
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

