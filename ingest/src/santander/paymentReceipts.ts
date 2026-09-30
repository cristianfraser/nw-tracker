import fs from "node:fs";
import path from "node:path";
import type { CardPaymentReceiptPayload } from "nw-tracker-contracts";
import { receiptsStagingDir } from "../email/santanderDocs.js";

/**
 * Santander's credit-card payment receipt mails → `card.payment_receipt`. `fetch:santander-docs`
 * stages each mail's body text as JSON (`receipt-<message id>.json`): «Pago Deuda Nacional TCR»
 * (the peso debt: `Monto del pago`) and «Comprobante Pago (abono) de la deuda facturada en
 * dolares» (the dollar debt: `Equivalente en pesos`, the exact checking debit, plus the dollars).
 * Both print the real payment day as «con fecha dd/mm/yyyy» (or dd-mm-yyyy) and the card as
 * «**** 1234».
 */

export type StagedPaymentReceipt = {
  message_id: string;
  subject: string;
  /** ISO datetime of the mail. */
  date: string;
  /** Flattened body text staged by the fetcher. */
  text: string;
};

export function listStagedReceiptFiles(dir = receiptsStagingDir()): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => /^receipt-.*\.json$/i.test(n))
    .sort()
    .map((n) => path.join(dir, n));
}

/** "923.815" → 923815 (Chilean integer pesos; receipts carry no decimals on CLP). */
function parseReceiptPesos(raw: string): number {
  const n = Number(String(raw).replace(/\./g, ""));
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Unparseable pesos amount "${raw}"`);
  return n;
}

/**
 * Throws on a receipt that classifies but does not parse — a template change must surface as a
 * failed step, not as a silently undated payment.
 */
export function santanderPaymentReceiptPayload(staged: StagedPaymentReceipt): CardPaymentReceiptPayload {
  const text = staged.text.replace(/\s+/g, " ");
  const date = /con fecha (\d{2})[/-](\d{2})[/-](\d{4})/i.exec(text);
  if (!date) throw new Error(`Receipt without a payment date: "${staged.subject}" (${staged.message_id})`);
  const paid_on = `${date[3]}-${date[2]!.padStart(2, "0")}-${date[1]!.padStart(2, "0")}`;
  const card = /\*[* ]*(\d{4})\b/.exec(text);
  const card_last4 = card ? card[1]! : null;

  const clp = /Monto del pago:\s*\$?\s*([\d.]+)/i.exec(text);
  if (clp) {
    return { issuer: "santander", paid_on, debt_currency: "clp", amount_clp: parseReceiptPesos(clp[1]!), amount_usd: null, card_last4 };
  }
  const pesos = /Equivalente en pesos\s*\$\s*([\d.]+)/i.exec(text);
  const usd = /Monto pagado \(abono\)\s*USD\s*([\d.,]+)/i.exec(text);
  if (pesos) {
    const amount_usd = usd ? Number(usd[1]!.replace(/\./g, "").replace(",", ".")) : null;
    return { issuer: "santander", paid_on, debt_currency: "usd", amount_clp: parseReceiptPesos(pesos[1]!), amount_usd, card_last4 };
  }
  throw new Error(`Receipt without a recognisable amount: "${staged.subject}" (${staged.message_id})`);
}
