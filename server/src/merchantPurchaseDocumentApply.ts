/**
 * `merchant.purchase_document`: stores a merchant's receipt or subscription notices (migration
 * 204) and runs the expense-note matcher, which writes the app onto the card charges they
 * explain (`merchantExpenseNotes.ts`). One source (a mail) is stored once: a resend with the same
 * payload is a duplicate, one with a different payload a conflict — nothing is overwritten.
 */
import type { MerchantPurchaseDocumentApplyDetails, MerchantPurchaseDocumentPayload } from "nw-tracker-contracts";
import { db } from "./db.js";
import { matchMerchantExpenseNotes } from "./merchantExpenseNotes.js";

export type MerchantPurchaseDocumentOutcome =
  | { status: "applied" | "duplicate"; details: MerchantPurchaseDocumentApplyDetails }
  | { status: "conflict"; message: string };

function storeDocuments(payload: MerchantPurchaseDocumentPayload, sourceRef: string, payloadJson: string): void {
  const source = db
    .prepare(
      `INSERT INTO merchant_document_sources (merchant, source_ref, payload_json, received_at)
       VALUES (?, ?, ?, ?)`
    )
    .run(payload.merchant, sourceRef, payloadJson, new Date().toISOString());
  const sourceId = Number(source.lastInsertRowid);
  const insertReceipt = db.prepare(
    `INSERT INTO merchant_receipts (source_id, merchant, issued_on, order_id, card_last4, total_amount, currency)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const insertItem = db.prepare(
    `INSERT INTO merchant_receipt_items (receipt_id, position, app, product, amount, renews, period, icon_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertNotice = db.prepare(
    `INSERT INTO merchant_subscription_notices
       (source_id, merchant, notice, mailed_on, app, plan, price, currency, period,
        purchased_on, next_charge_on, expires_on, card_last4)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const d of payload.documents) {
    if (d.type === "receipt") {
      const receipt = insertReceipt.run(sourceId, payload.merchant, d.issued_on, d.order_id, d.card_last4, d.total.amount, d.total.currency);
      d.items.forEach((i, position) =>
        insertItem.run(Number(receipt.lastInsertRowid), position, i.app, i.product, i.amount, i.renews ? 1 : 0, i.period, i.icon_url)
      );
    } else {
      insertNotice.run(
        sourceId,
        payload.merchant,
        d.notice,
        d.mailed_on,
        d.app,
        d.plan,
        d.price.amount,
        d.price.currency,
        d.period,
        d.purchased_on,
        d.next_charge_on,
        d.expires_on,
        d.card_last4
      );
    }
  }
}

export function applyMerchantPurchaseDocument(
  payload: MerchantPurchaseDocumentPayload,
  sourceRef: string,
  opts?: { today?: string }
): MerchantPurchaseDocumentOutcome {
  const payloadJson = JSON.stringify(payload);
  return db.transaction((): MerchantPurchaseDocumentOutcome => {
    const stored = db
      .prepare(`SELECT payload_json FROM merchant_document_sources WHERE source_ref = ?`)
      .get(sourceRef) as { payload_json: string } | undefined;
    if (stored && stored.payload_json !== payloadJson) {
      return { status: "conflict", message: `${sourceRef} is already stored with different contents` };
    }
    if (!stored) storeDocuments(payload, sourceRef, payloadJson);
    const matched = matchMerchantExpenseNotes({ apply: true, merchant: payload.merchant, today: opts?.today });
    const receiptCharges = matched.receipt_charges.get(sourceRef) ?? [];
    const receipts = payload.documents.filter((d) => d.type === "receipt").length;
    return {
      status: stored ? "duplicate" : "applied",
      details: {
        notes_written: matched.notes_written.map((n) => ({ account_id: n.account_id, date: n.date, note: n.note, basis: n.basis })),
        receipt_lines: Array.from({ length: receipts }, (_, i) => receiptCharges[i] ?? null),
        unresolved: matched.unresolved.map((u) => ({ issued_on: u.issued_on, products: u.products })),
      },
    };
  })();
}
