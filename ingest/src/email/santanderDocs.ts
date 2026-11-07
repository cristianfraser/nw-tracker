/**
 * Fetch Santander's monthly PDF documents out of Gmail into `cfraser/inbox/`.
 *
 * The bank mails both documents every month — «Estado de Cuenta Tarjeta de Crédito» (the credit
 * card facturación) and «Cartola Mensual de Cuentas.» (the cuenta corriente cartola) — and both
 * arrive as PDF attachments. Taking them from mail rather than the web session is strictly better:
 * the statement download endpoint has never once succeeded (Codigo 16 on every attempt), the
 * cartola download costs an extra authenticated navigation on a bank that is sensitive to traffic,
 * and mail needs no session, no 2FA and no window server.
 *
 * Attachments are saved under the bank's OWN filenames, which is the whole point — the inbox
 * organizer already recognises Santander's email attachment naming (`1_<seq>_<account>_<date>_CC.pdf`
 * for a cuenta corriente cartola, `_LC` for línea de crédito) and classifies credit-card statements
 * by peeking at the PDF text. So this step's entire contract is "put the file in the inbox"; every
 * downstream stage is unchanged.
 *
 * Once a month, not once a night: each attachment is gated in the document ledger under its own
 * bank-given FILENAME (`80_16448_<account>_20260723.pdf`), which carries the bank's sequence number
 * and the document date and is therefore a stable per-document identity. Keying on the month
 * instead would be wrong in a way that loses data silently: the credit-card facturación arrives as
 * TWO same-day mails — the CLP statement and the USD one — so the first would mark the month done
 * and its sibling would never be downloaded. Because each month brings fresh sequence numbers, the
 * filename key gives the intended once-a-month rhythm for free: due when the mail lands, retried
 * daily until it does, never fetched twice.
 */
import fs from "node:fs";
import path from "node:path";
import { ensureDir, resolveCfraserDir, resolveInboxDir } from "../paths.js";
import type { MailDocument, MailSource, WantedMail } from "./mailFetcher.js";
import { mailPeriodKey, normalizeMailSubject, safeAttachmentName } from "./mime.js";

export const SANTANDER_MAIL_SENDER = "mensajeria@santander.cl";

const CC_STATEMENT = "email-cc-statement";
const CARTOLA = "email-cartola";
const CC_PAYMENT_RECEIPT = "email-cc-payment-receipt";

/**
 * Credit-card payment receipt mails («Pago Deuda Nacional TCR», «Comprobante Pago (abono) de la
 * deuda facturada en dolares»). No attachment — the body text IS the document: it carries the
 * REAL payment date, which the checking ledger needs because the bank's movement feed dates
 * post-14:00 payments at the next workday. The body is staged verbatim for the receipt decoder
 * (`santander/paymentReceipts.ts`); nothing is interpreted here.
 */
export function isSantanderCcPaymentReceiptSubject(subject: string): boolean {
  const s = normalizeMailSubject(subject);
  if (s.includes("pago deuda") && s.includes("tcr")) return true;
  return s.includes("comprobante pago") && s.includes("deuda facturada");
}

/** The document kind a Santander subject announces, or null. */
export function santanderMailKind(subject: string): string | null {
  const s = normalizeMailSubject(subject);
  if (s.includes("estado de cuenta") && s.includes("tarjeta")) return CC_STATEMENT;
  if (s.includes("cartola mensual")) return CARTOLA;
  return isSantanderCcPaymentReceiptSubject(subject) ? CC_PAYMENT_RECEIPT : null;
}

export function receiptsStagingDir(): string {
  return path.join(resolveCfraserDir(), "santander-payment-receipts");
}

/** A receipt: its body text staged as JSON, keyed by message id (each payment is its own mail). */
function receiptDocument(mail: WantedMail): MailDocument {
  const key = `receipt-${mail.messageId.replace(/[^A-Za-z0-9@._-]/g, "_").slice(0, 120)}.json`;
  if (!mail.bodyPart) return { key, skip: "no text body part" };
  return {
    key,
    file: key,
    async write(read) {
      const staged = { message_id: mail.messageId, subject: mail.subject, date: mail.date.toISOString(), text: await read.bodyText(4000) };
      fs.writeFileSync(path.join(ensureDir(receiptsStagingDir()), key), JSON.stringify(staged, null, 2));
      return { written: true };
    },
  };
}

/** Each PDF attachment into the inbox under the bank's own filename, which is also its ledger key. */
function attachmentDocuments(mail: WantedMail): MailDocument[] {
  const period = mailPeriodKey(mail.date);
  if (mail.pdfs.length === 0) return [{ key: mail.mailKey, skip: "no pdf attachment" }];
  return mail.pdfs.map((a, index) => {
    const name = safeAttachmentName(a.filename, `santander-${mail.kind}-${period}-${index + 1}.pdf`);
    return {
      key: name,
      file: name,
      async write(read) {
        const target = path.join(ensureDir(resolveInboxDir()), name);
        // A file still sitting in the inbox has not been imported yet — same bytes, and
        // overwriting it would only race the importer that may already be reading it.
        if (fs.existsSync(target)) return { already: `${name} already in inbox` };
        fs.writeFileSync(target, (await read.part(a.part)).bytes);
        return { written: true };
      },
    };
  });
}

export const SANTANDER_DOCS_SOURCE: MailSource = {
  label: "Santander documents",
  ledger: "santander",
  query: { from: SANTANDER_MAIL_SENDER },
  kindOf: santanderMailKind,
  // When the bank sends the same document twice in a day the later copy is kept; the ledger skips its twin.
  newestFirst: true,
  documents: (mail) => (mail.kind === CC_PAYMENT_RECEIPT ? [receiptDocument(mail)] : attachmentDocuments(mail)),
};
