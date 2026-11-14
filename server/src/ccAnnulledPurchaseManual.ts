/**
 * The user's side of annulled card purchases (`ccAnnulledPurchases.ts`): marking an open-bucket
 * purchase as annulled by the bank, and undoing a manual mark. Both are card-line writes through the
 * funnel, so the owed walk, billing balances and valuations re-sync from the dates they touch.
 */
import { chileCalendarTodayYmd } from "./chileDate.js";
import { InputError } from "./inputError.js";
import { db } from "./db.js";
import { isListingSourceKind } from "./ccStatementSourceKind.js";
import { normalizeTransactionDateIso } from "./ccInstallmentPayBy.js";
import { resolveCcExpensePurchaseKey } from "./ccExpenseCategories.js";
import { applyLinePlan, cardLineWrite, insertLines } from "./cards/lineWrites.js";
import { webPasteLineDedupeKey, type CcListingLine } from "./ccWebPasteParse.js";
import { creditCardMasterMetaForAccount } from "./ccWebPasteParse.js";
import { ccCardRegistry } from "./ccCardRegistry.js";
import {
  annulOpenBucketLines,
  annulledPurchaseById,
  deleteAnnulledPurchase,
  listAnnulledPurchases,
  type CcAnnulledPurchase,
} from "./ccAnnulledPurchases.js";

/** A request the current state forbids (the bank's evidence decided the annulment): 409. */
export class AnnulmentConflictError extends Error {}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Marks an open-bucket one-shot charge as annulled by the bank on `annulledOn` (basis `manual`). */
export function markAnnulledPurchaseManually(accountId: number, lineId: number, annulledOn: string): CcAnnulledPurchase {
  if (!ISO_DAY.test(annulledOn)) throw new InputError("annulled_on must be an ISO day (YYYY-MM-DD)");
  if (annulledOn > chileCalendarTodayYmd()) throw new InputError("annulled_on cannot be after today");
  const line = db
    .prepare(
      `SELECT l.id, l.transaction_date, l.posting_date, l.amount, l.installment_flag, s.account_id, s.source_kind
       FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id WHERE l.id = ?`
    )
    .get(lineId) as
    | { id: number; transaction_date: string | null; posting_date: string | null; amount: number | null; installment_flag: number; account_id: number; source_kind: string }
    | undefined;
  if (!line) throw new InputError("statement line not found");
  if (line.account_id !== accountId) throw new InputError("statement line not on this account");
  if (!isListingSourceKind(line.source_kind)) throw new InputError("only lines of an open listing bucket can be annulled");
  if (line.installment_flag) throw new InputError("a cuota line cannot be annulled");
  if (line.amount == null || !(line.amount > 0)) throw new InputError("only a charge can be annulled");
  const purchaseDate =
    normalizeTransactionDateIso(line.transaction_date ?? "") ?? normalizeTransactionDateIso(line.posting_date ?? "");
  if (!purchaseDate) throw new InputError("the line has no readable purchase date");
  if (annulledOn < purchaseDate) throw new InputError(`annulled_on cannot be before the purchase day ${purchaseDate}`);
  const key = resolveCcExpensePurchaseKey(lineId);
  if (listAnnulledPurchases(accountId).some((a) => a.purchase_key === key)) {
    throw new InputError("this purchase is already annulled");
  }

  return cardLineWrite(accountId, `annulling statement line ${lineId}`, () => {
    const { plan, annulled } = annulOpenBucketLines(accountId, [lineId], { annulledOn, basis: "manual", evidence: null });
    applyLinePlan(accountId, `annulling statement line ${lineId}`, plan);
    return annulled[0]!;
  });
}

/**
 * Undoes a manual annulment: the row goes and the purchase is listed again in the open bucket,
 * through the same path a paste takes, so its expense key (and with it category, note, big group
 * and receipt) is the one the row stored. A `#dupN` twin is re-listed with its N siblings, which the
 * merge dedupes against the lines on file.
 */
export function undoManualAnnulledPurchase(accountId: number, annulId: number): void {
  const row = annulledPurchaseById(annulId);
  if (!row || row.account_id !== accountId) throw new InputError("annulled purchase not found on this account");
  if (row.basis !== "manual") {
    throw new AnnulmentConflictError(`the annulment was decided by the bank's evidence (${row.basis}) and cannot be undone by hand`);
  }
  if (row.currency !== "clp" && row.currency !== "usd") throw new InputError(`cannot re-list a ${row.currency} purchase`); // convention-ok: the bank's web table is in pesos or dollars only
  const currency = row.currency;
  const { cardGroup } = creditCardMasterMetaForAccount(accountId);
  const line: CcListingLine = {
    transaction_date: row.purchase_date,
    merchant: row.merchant,
    currency,
    amount: row.amount,
    raw_line: row.merchant,
    ...(row.origin_card_last4 && ccCardRegistry().additional_card_last4s.includes(row.origin_card_last4) ? { holder: "additional" as const } : {}),
  };
  const base = webPasteLineDedupeKey(cardGroup, line);
  const dup = row.dedupe_key && row.dedupe_key.startsWith(`${base}#dup`) ? Number(row.dedupe_key.slice(base.length + 4)) : 0;
  if (row.dedupe_key && row.dedupe_key !== base && !(dup > 0)) {
    throw new Error(`annulled purchase ${annulId}: stored dedupe key «${row.dedupe_key}» does not derive from its line`);
  }

  cardLineWrite(accountId, `undoing annulled purchase ${annulId}`, () => {
    deleteAnnulledPurchase(annulId);
    insertLines(accountId, { lines: Array.from({ length: dup + 1 }, () => ({ ...line })), errors: [] });
    const wanted = row.dedupe_key ?? base;
    const back = db
      .prepare(
        `SELECT l.id FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id
         WHERE s.account_id = ? AND l.dedupe_key = ? AND s.source_kind IN ('listing_open', 'listing_other')`
      )
      .all(accountId, wanted) as { id: number }[];
    if (back.length !== 1) throw new Error(`annulled purchase ${annulId}: ${back.length} bucket lines under «${wanted}» after re-listing`);
    const key = resolveCcExpensePurchaseKey(back[0]!.id);
    if (key !== row.purchase_key) {
      throw new Error(`annulled purchase ${annulId}: the re-listed line's expense key «${key}» differs from the stored «${row.purchase_key}»`);
    }
  });
}
