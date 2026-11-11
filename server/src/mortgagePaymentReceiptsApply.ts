/**
 * `mortgage.payment_receipt` v1: a mortgage lender's receipt for one cuota paid online (MetLife
 * Hipotecario's «Pago de dividendo realizado» mail).
 *
 * The cuota is charged to a card that has no daily feed (BCI Lider), so the charge would only show
 * when the card's statement arrives about three weeks later. The receipt is stored once
 * (`mortgage_payment_receipts`, migration 307) and the charge is planted in the card's open
 * web-paste bucket the same day, under the merchant the card's statement prints for the lender
 * (`LENDER_CARD_MERCHANT`), so the card balance and the mortgage card-match check read the payment
 * at once. The statement settles the planted line when it prints the same charge
 * (`reconcileOpenWebPasteAfterPdfClose`: same merchant once BCI's « (T)» is stripped, same pesos,
 * the same day). A charge, not a payment: it is not registered in `cc_planted_payment_lines`.
 */
import type { MortgagePaymentReceiptApplyDetails, MortgagePaymentReceiptPayload } from "nw-tracker-contracts";
import { ddMmYyyyFromIso } from "nw-tracker-contracts";
import { importCcListingLines } from "./accountImports.js";
import { listingLineFromCardListingLine } from "./cardListingLines.js";
import { resolveMasterAccountIdForImportCardLast4 } from "./ccConsolidatedCards.js";
import { db } from "./db.js";
import { storeOnce } from "./ingestReceiver.js";

/** The merchant the paying card's statement prints for each lender's cuota charge. */
export const LENDER_CARD_MERCHANT: Readonly<Record<string, string>> = {
  metlife: "TOKU *METLIFE HIPOTECAR",
};

function lenderCardMerchant(lender: string): string {
  const merchant = LENDER_CARD_MERCHANT[lender];
  if (!merchant) throw new Error(`mortgage.payment_receipt: no card merchant is known for lender «${lender}»`);
  return merchant;
}

type StoredReceipt = {
  id: number;
  paid_on: string;
  amount_clp: number;
  credit_number: string;
  dividend_number: string;
  due_on: string;
  card_account_id: number;
};

function loadReceipt(lender: string, transactionId: string): StoredReceipt | undefined {
  return db
    .prepare(
      `SELECT id, paid_on, amount_clp, credit_number, dividend_number, due_on, card_account_id
       FROM mortgage_payment_receipts WHERE lender = ? AND transaction_id = ?`
    )
    .get(lender, transactionId) as StoredReceipt | undefined;
}

export function applyMortgagePaymentReceipt(
  payload: MortgagePaymentReceiptPayload,
  messageId: string
): MortgagePaymentReceiptApplyDetails {
  const merchant = lenderCardMerchant(payload.lender);
  const cardId = resolveMasterAccountIdForImportCardLast4(payload.card_last4);
  if (cardId == null) {
    throw new Error(`mortgage.payment_receipt: no card account for card ·${payload.card_last4}`);
  }

  return db.transaction((): MortgagePaymentReceiptApplyDetails => {
    const fields = (r: { paid_on: string; amount_clp: number; credit_number: string; dividend_number: string; due_on: string }, card: number) => ({
      paid_on: r.paid_on,
      amount_clp: r.amount_clp,
      credit_number: r.credit_number,
      dividend_number: r.dividend_number,
      due_on: r.due_on,
      card_account_id: card,
    });
    storeOnce([payload], {
      table: "mortgage_payment_receipts",
      key: (p) => `${p.lender}|${p.transaction_id}`,
      load: (p) => {
        const stored = loadReceipt(p.lender, p.transaction_id);
        return stored ? fields(stored, stored.card_account_id) : undefined;
      },
      row: (p) => fields(p, cardId),
      insert: (p) => {
        db.prepare(
          `INSERT INTO mortgage_payment_receipts
             (lender, transaction_id, paid_on, amount_clp, credit_number, dividend_number, due_on, card_account_id, message_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          p.lender,
          p.transaction_id,
          p.paid_on,
          p.amount_clp,
          p.credit_number,
          p.dividend_number,
          p.due_on,
          cardId,
          messageId
        );
      },
    });
    const receipt = loadReceipt(payload.lender, payload.transaction_id)!;

    const line = listingLineFromCardListingLine({
      date: payload.paid_on,
      merchant,
      currency: "clp",
      // Debt-positive: a charge.
      amount: payload.amount_clp,
      raw_text: `${ddMmYyyyFromIso(payload.paid_on)} ${merchant} (cargo del recibo de ${payload.lender}, dividendo ${payload.dividend_number})`,
      holder: "titular",
    });
    const planted = importCcListingLines(cardId, { lines: [line], errors: [] }, "cc_lender_receipt");
    const cardLine = planted.inserted > 0 ? "planted" : "on_file";
    return {
      receipt_id: receipt.id,
      card_account_id: cardId,
      card_line: cardLine,
      detail:
        cardLine === "planted"
          ? `dividend ${payload.dividend_number} (${payload.amount_clp} CLP, ${payload.paid_on}) planted on card ${cardId}`
          : `dividend ${payload.dividend_number} (${payload.amount_clp} CLP, ${payload.paid_on}) is already on card ${cardId}`,
    };
  })();
}
