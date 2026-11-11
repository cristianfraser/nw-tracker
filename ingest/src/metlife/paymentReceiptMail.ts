/**
 * MetLife Hipotecario's receipt for a cuota paid online («Pago de dividendo realizado», from
 * `noresponda@cliente.metlife.cl`): the total paid, the lender's transaction id, the payment day,
 * then a detail table naming the credit, the dividend paid and its due date.
 *
 * The text read here is `archiveMails`' rendering (tags stripped, whitespace collapsed); Gmail's
 * plain rendering adds `|` table borders. Both are read the same way: pipes and runs of whitespace
 * are one separator, and labels with accents are matched without them (an entity the renderer does
 * not know, «&deg;» or «&#243;», becomes a space).
 *
 * A mail with the receipt subject that does not decode throws; any other mail from the sender is null.
 */
import { parseChileanNumber, parseDdMmYyToIso, type MortgagePaymentReceiptPayload } from "nw-tracker-contracts";
import type { ArchivedMail } from "../email/mailFetcher.js";
import { normalizeMailSubject } from "../email/mime.js";

export const METLIFE_RECEIPT_SENDER = "noresponda@cliente.metlife.cl";
export const METLIFE_RECEIPT_SUBJECT = /pago de dividendo realizado/;

export function isMetlifeReceiptSubject(subject: string): boolean {
  return METLIFE_RECEIPT_SUBJECT.test(normalizeMailSubject(subject));
}

const DATE = String.raw`(\d{2}/\d{2}/\d{4})`;
const AMOUNT = /Monto total pagado \$ ?([\d.]+(?:,\d+)?)/i;
const TRANSACTION = /ID transacci\S*(?: n)? (\d+)/i;
const PAID_ON = new RegExp(String.raw`Fecha de pago ${DATE}`, "i");
/** The detail table: its header, then one row (credit, dividend, due date). */
const DETAIL = new RegExp(String.raw`Cr\S* ?dito N\S*(?: \S{0,2})? de dividendo Fecha de vencimiento ([A-Z0-9-]+) ([A-Z0-9-]+) ${DATE}`, "i");

function flatten(text: string): string {
  // Gmail's plain rendering: `|` borders, `|---|---|` header rules, `**bold**`.
  return text.replace(/\|/g, " ").replace(/:?-{3,}:?/g, " ").replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
}

function isoOrThrow(raw: string, what: string): string {
  const iso = parseDdMmYyToIso(raw);
  if (!iso) throw new Error(`MetLife receipt: unreadable ${what} «${raw}»`);
  return iso;
}

/** The receipt without the card (the feeder declares it); null for another mail from the sender. */
export function decodeMetlifePaymentReceipt(mail: Pick<ArchivedMail, "subject" | "text">): Omit<MortgagePaymentReceiptPayload, "card_last4"> | null {
  if (!isMetlifeReceiptSubject(mail.subject)) return null;
  const text = flatten(mail.text);
  const missing: string[] = [];
  const amount = AMOUNT.exec(text);
  if (!amount) missing.push("Monto total pagado");
  const tx = TRANSACTION.exec(text);
  if (!tx) missing.push("ID transacción");
  const paid = PAID_ON.exec(text);
  if (!paid) missing.push("Fecha de pago");
  const detail = DETAIL.exec(text);
  if (!detail) missing.push("the Crédito / N° de dividendo / Fecha de vencimiento row");
  if (missing.length > 0 || !amount || !tx || !paid || !detail) {
    throw new Error(`MetLife receipt «${mail.subject}» does not decode: no ${missing.join(", ")}`);
  }
  const amountClp = parseChileanNumber(amount[1]!);
  if (!Number.isInteger(amountClp) || amountClp <= 0) throw new Error(`MetLife receipt: amount «${amount[1]}» is not whole positive pesos`);
  return {
    lender: "metlife",
    transaction_id: tx[1]!,
    paid_on: isoOrThrow(paid[1]!, "Fecha de pago"),
    amount_clp: amountClp,
    credit_number: detail[1]!,
    dividend_number: detail[2]!,
    due_on: isoOrThrow(detail[3]!, "Fecha de vencimiento"),
  };
}
