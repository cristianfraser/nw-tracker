/**
 * Card purchases the bank annulled before billing them (migration 332, `cc_annulled_purchases`).
 *
 * A bank that voids an unbilled purchase drops it from its «por facturar» listing instead of posting
 * a refund credit (MercadoLibre 8x.xxx on ·7817, 2026-11-05: listed, then gone, the bank's cupo
 * exactly that much below the app). Deleting the bucket line, as the feed mirror and the statement
 * reconcile did, also deleted the purchase from history. Instead the purchase is kept as two events:
 *  - the purchase, on its own day, under the expense key its line carried (`purchase_key`), so the
 *    flow's category, note, big group and receipt still reach it;
 *  - its annulment, a refund of the same amount on `annulled_on`, in the same category.
 *
 * The owed walk adds the amount on the purchase day and removes it on the annulment day; billing
 * frames (facturado, cupo en cuotas, the cuota schedule, «Próximos pagos», the cupo check) never see
 * either, because the bank never billed them.
 *
 * This module owns the table: writers snapshot a bucket line into a row and return the line plan
 * that deletes it; readers list the rows. The row must be written before its line is deleted (the
 * flow-retire trigger keeps the line's flow alive by its key once the line is gone).
 */
import { db } from "./db.js";
import { normalizeTransactionDateIso } from "./ccInstallmentPayBy.js";
import { resolveCcExpensePurchaseKey } from "./ccExpenseCategories.js";
import { withAnnulledPurchaseKey } from "./ccAnnulledPurchasesRead.js";
import type { CardLinePlan } from "./cards/lineWriteSession.js";
import { putFlowCategory } from "./flows/flowCategories.js";

export type CcAnnulmentBasis = "feed_drop" | "cupo_gap" | "statement_close" | "manual";

export type CcAnnulledPurchase = {
  id: number;
  account_id: number;
  currency: string;
  /** Debt-positive, in `currency`. */
  amount: number;
  merchant: string;
  purchase_date: string;
  annulled_on: string;
  basis: CcAnnulmentBasis;
  /** The line's parser row id, stored; {@link purchase_key} is rebuilt from it (never stored). */
  parser_row_id: string | null;
  /** The expense key the deleted bucket line carried (`cards/oneShotLineKey.ts`). */
  purchase_key: string;
  flow_id: number | null;
  dedupe_key: string | null;
  origin_card_last4: string | null;
  evidence: string | null;
  /**
   * 1 once a real credit line of the bank refunds the purchase (migration 333): `annulled_on` is that
   * credit's day and the annulment leg / synthetic refund are NOT counted (the credit line is the
   * refund); the purchase leg stays.
   */
  bank_credit: 0 | 1;
};

type StoredRow = Omit<CcAnnulledPurchase, "purchase_key">;

const COLUMNS = `id, account_id, currency, amount, merchant, purchase_date, annulled_on, basis, parser_row_id,
  flow_id, dedupe_key, origin_card_last4, evidence, bank_credit`;

/** Every annulled purchase of a card, oldest purchase first. */
export function listAnnulledPurchases(accountId: number): CcAnnulledPurchase[] {
  return (db
    .prepare(`SELECT ${COLUMNS} FROM cc_annulled_purchases WHERE account_id = ? ORDER BY purchase_date, id`)
    .all(accountId) as StoredRow[]).map(withAnnulledPurchaseKey);
}

/** Every annulled purchase, by card then purchase day. */
export function listAllAnnulledPurchases(): CcAnnulledPurchase[] {
  return (db
    .prepare(`SELECT ${COLUMNS} FROM cc_annulled_purchases ORDER BY account_id, purchase_date, id`)
    .all() as StoredRow[]).map(withAnnulledPurchaseKey);
}

export function annulledPurchaseById(id: number): CcAnnulledPurchase | null {
  const row = db.prepare(`SELECT ${COLUMNS} FROM cc_annulled_purchases WHERE id = ?`).get(id) as StoredRow | undefined;
  return row ? withAnnulledPurchaseKey(row) : null;
}

/**
 * The owed walk's events of a card's annulled purchases (debt-positive): the amount on the purchase
 * day, minus it on the annulment day. A purchase annulled the day it was made nets to nothing.
 */
export function annulledPurchaseOwedEvents(
  accountId: number
): { date: string; currency: string; amount: number; annulled_purchase_id: number; leg: "purchase" | "annulment" }[] {
  return listAnnulledPurchases(accountId).flatMap((a) => [
    { date: a.purchase_date, currency: a.currency, amount: a.amount, annulled_purchase_id: a.id, leg: "purchase" as const },
    // A bank credit line is the refund; inventing one more would count it twice.
    ...(a.bank_credit
      ? []
      : [{ date: a.annulled_on, currency: a.currency, amount: -a.amount, annulled_purchase_id: a.id, leg: "annulment" as const }]),
  ]);
}

type BucketLineSnapshot = {
  id: number;
  account_id: number;
  source_kind: string;
  transaction_date: string | null;
  posting_date: string | null;
  merchant: string | null;
  amount: number | null;
  currency: string;
  installment_flag: number;
  dedupe_key: string | null;
  parser_row_id: string | null;
  origin_card_last4: string | null;
  flow_id: number | null;
};

const selLine = db.prepare<[number]>(
  `SELECT l.id, s.account_id, s.source_kind, l.transaction_date, l.posting_date, l.merchant, l.amount, l.currency,
          l.installment_flag, l.dedupe_key, l.parser_row_id, l.origin_card_last4, l.flow_id
   FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id
   WHERE l.id = ?`
);

const selLineOverride = db.prepare<[number]>(`SELECT category_id FROM cc_expense_line_categories WHERE statement_line_id = ?`);

const insAnnulled = db.prepare(
  `INSERT INTO cc_annulled_purchases
     (account_id, currency, amount, merchant, purchase_date, annulled_on, basis, parser_row_id, flow_id, dedupe_key,
      origin_card_last4, evidence)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

/**
 * Record open-bucket lines of a card as annulled purchases and return the line plan that deletes
 * them (the caller applies it inside its card-line write, which re-syncs the card). Only one-shot
 * charges of a listing bucket qualify: a line of a closed statement, a cuota line, a credit or a
 * payment throws — what the bank billed is never «annulled». `annulledOn` before a line's purchase
 * day throws.
 */
export function annulOpenBucketLines(
  accountId: number,
  lineIds: readonly number[],
  opts: { annulledOn: string; basis: CcAnnulmentBasis; evidence: string | null }
): { plan: CardLinePlan; annulled: CcAnnulledPurchase[] } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.annulledOn)) throw new Error(`annulOpenBucketLines: annulledOn «${opts.annulledOn}» is not an ISO day`);
  const annulled: CcAnnulledPurchase[] = [];
  for (const lineId of lineIds) {
    let line = selLine.get(lineId) as BucketLineSnapshot | undefined;
    if (!line) throw new Error(`annulOpenBucketLines: line ${lineId} does not exist`);
    if (line.account_id !== accountId) throw new Error(`annulOpenBucketLines: line ${lineId} is on account ${line.account_id}, not ${accountId}`);
    if (line.source_kind !== "listing_open" && line.source_kind !== "listing_other") {
      throw new Error(`annulOpenBucketLines: line ${lineId} is on a ${line.source_kind} statement, not a listing bucket`);
    }
    if (line.installment_flag) throw new Error(`annulOpenBucketLines: line ${lineId} is a cuota line`);
    if (line.amount == null || !(line.amount > 0)) {
      throw new Error(`annulOpenBucketLines: line ${lineId} is not a charge (amount ${line.amount})`);
    }
    const purchaseDate =
      normalizeTransactionDateIso(line.transaction_date ?? "") ?? normalizeTransactionDateIso(line.posting_date ?? "");
    if (!purchaseDate) throw new Error(`annulOpenBucketLines: line ${lineId} has no readable date`);
    if (opts.annulledOn < purchaseDate) {
      throw new Error(`annulOpenBucketLines: line ${lineId} bought ${purchaseDate} cannot be annulled on ${opts.annulledOn}`);
    }
    const purchaseKey = resolveCcExpensePurchaseKey(lineId);
    // A per-line category override is keyed by the line id and goes with the line; the purchase
    // keeps its category as the «Único» row of its key (an existing row is left alone). Written
    // before the snapshot, so the flow it creates is the one the annulment records.
    const override = selLineOverride.get(lineId) as { category_id: number } | undefined;
    if (override) {
      putFlowCategory(accountId, purchaseKey, override.category_id, "keep");
      line = selLine.get(lineId) as BucketLineSnapshot;
    }
    const merchant = String(line.merchant ?? "").trim();
    if (!merchant) throw new Error(`annulOpenBucketLines: line ${lineId} has no merchant`);
    // The key is rebuilt from the stored facts on every read; it must be the one the line carried.
    const rebuilt = withAnnulledPurchaseKey({
      account_id: accountId,
      parser_row_id: line.parser_row_id,
      merchant,
      purchase_date: purchaseDate,
    }).purchase_key;
    if (rebuilt !== purchaseKey) {
      throw new Error(`annulOpenBucketLines: line ${lineId}'s key «${purchaseKey}» cannot be rebuilt (got «${rebuilt}»)`);
    }
    const res = insAnnulled.run(
      accountId,
      line.currency,
      line.amount,
      merchant,
      purchaseDate,
      opts.annulledOn,
      opts.basis,
      line.parser_row_id,
      line.flow_id,
      line.dedupe_key,
      line.origin_card_last4,
      opts.evidence
    );
    annulled.push(annulledPurchaseById(Number(res.lastInsertRowid))!);
  }
  return { plan: { deleteLineIds: [...lineIds], carry: [] }, annulled };
}

/** Remove an annulment (the bank billed or re-listed the purchase after all). */
export function deleteAnnulledPurchase(id: number): void {
  const res = db.prepare(`DELETE FROM cc_annulled_purchases WHERE id = ?`).run(id);
  if (res.changes !== 1) throw new Error(`deleteAnnulledPurchase: no annulled purchase ${id}`);
}

/**
 * The bank refunded an annulled purchase with a real credit line dated `creditIso` (a nota de
 * crédito on a later statement): the purchase stays, the synthetic annulment leg is dropped and
 * `annulled_on` follows the credit's day.
 */
export function markAnnulledPurchaseBankCredited(id: number, creditIso: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(creditIso)) throw new Error(`markAnnulledPurchaseBankCredited: «${creditIso}» is not an ISO day`);
  const row = annulledPurchaseById(id);
  if (!row) throw new Error(`markAnnulledPurchaseBankCredited: no annulled purchase ${id}`);
  if (creditIso < row.purchase_date) {
    throw new Error(`markAnnulledPurchaseBankCredited: credit ${creditIso} precedes the purchase ${row.purchase_date}`);
  }
  db.prepare(`UPDATE cc_annulled_purchases SET bank_credit = 1, annulled_on = ? WHERE id = ?`).run(creditIso, id);
}
