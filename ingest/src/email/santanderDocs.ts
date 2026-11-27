/**
 * Fetch Santander's monthly PDF documents out of Gmail into `cfraser/inbox/`.
 *
 * The bank mails every monthly document as a PDF attachment from `mensajeria@santander.cl`: the
 * card facturación as two same-day mails («Tarjetas Crédito Nacional Personas» = pesos,
 * «Tarjetas Crédito Internacional Personas» = dollars) and the cartolas («Cuenta Corriente
 * Persona», «Cuentamática Persona»). Until October 2026 the titles were «Estado de Cuenta Tarjeta
 * de Crédito» and «Cartola Mensual de Cuentas.»; both generations are recognised. Mail needs no
 * bank session, no 2FA and no window server (the statement download endpoint never succeeds).
 *
 * Attachments are saved under the bank's own filenames and nothing is interpreted here: the
 * inbox organizer decrypts each PDF and classifies it from its text (card statement or cartola,
 * which account), because the current names (`TC_NAC-<n>_<m>.pdf`, `LCA_CTA_CTE_CRONO-<n>_<m>.pdf`,
 * `C_MATICA_ONDEM-<n>_<m>.pdf`, …) carry neither account nor date.
 *
 * Ledger key, one per attachment: an old self-describing name (`80_<seq>_<account>_<YYYYMMDD>.pdf`,
 * `1_<seq>_<account>_<date>_CC.pdf`) is its own key; any other name is keyed by its mail
 * (`<mail date>-<message id>`) plus the name, since nothing promises the bank's two numbers never
 * repeat. Never by month: the facturación's two same-day mails would share it and the second would
 * never be fetched. Due when the mail lands, retried daily until it does, fetched once per mail (a
 * resent mail is fetched again and the organizer files the copy under `inbox/duplicates/`).
 *
 * A bank name already in the inbox with other bytes is saved beside it as
 * `<mail date>_<message id hash>_<name>` (`disambiguatedInboxName`), never recorded unwritten.
 *
 * The subject gates no document: a mail from the sender that carries a PDF is fetched whatever its
 * subject (`pdfMailKind`). The known subjects keep their ledger kinds; any other is fetched under
 * `email-pdf` with the same keys, and the organizer files it by its text or holds it in
 * `inbox/held/` (a notice of the run, never a failure). Only the payment receipts, whose body is
 * the document, are taken by subject. A generic mail is bounded (`SANTANDER_PDF_MAIL_MAX_*`): over
 * a bound it is not downloaded, recorded, and reported once as a notice of the fetch.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureDir, resolveCfraserDir, resolveInboxDir } from "../paths.js";
import type { MailDocument, MailSource, WantedMail } from "./mailFetcher.js";
import { mailPeriodKey, normalizeMailSubject, safeAttachmentName } from "./mime.js";

export const SANTANDER_MAIL_SENDER = "mensajeria@santander.cl";

const CC_STATEMENT = "email-cc-statement";
const CARTOLA = "email-cartola";
const CC_PAYMENT_RECEIPT = "email-cc-payment-receipt";
/** A mail with a PDF under a subject no kind names (a renamed document mail, or not a document of ours). */
export const SANTANDER_PDF_MAIL_KIND = "email-pdf";
/**
 * Bounds of a mail taken under `SANTANDER_PDF_MAIL_KIND` only (a known subject has none): more PDFs
 * than this in one mail, or one larger than this (IMAP's stated part size, encoded octets, read from
 * the body structure — nothing is downloaded to measure it), is not fetched; it is recorded and
 * reported once as a notice of the fetch.
 */
export const SANTANDER_PDF_MAIL_MAX_ATTACHMENTS = 10;
export const SANTANDER_PDF_MAIL_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

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

/** Titles since October 2026, accent-free and lower-cased, trailing dots dropped. */
const CC_STATEMENT_TITLE = /^tarjetas? (?:de )?credito (?:nacional|internacional) personas?$/;
const CARTOLA_TITLE = /^(?:cuenta corriente|cuentamatica) personas?$/;

/** The document kind a Santander subject announces, or null. */
export function santanderMailKind(subject: string): string | null {
  const s = normalizeMailSubject(subject).replace(/[\s.]+$/, "");
  if (s.includes("estado de cuenta") && s.includes("tarjeta")) return CC_STATEMENT;
  if (s.includes("cartola mensual")) return CARTOLA;
  if (CC_STATEMENT_TITLE.test(s)) return CC_STATEMENT;
  if (CARTOLA_TITLE.test(s)) return CARTOLA;
  return isSantanderCcPaymentReceiptSubject(subject) ? CC_PAYMENT_RECEIPT : null;
}

/** `80_<seq>_<account>_<YYYYMMDD>.pdf`, `1_<seq>_<account>_<date>_CC.pdf`: names that identify their document. */
const SELF_DESCRIBING_ATTACHMENT = /^\d+_\d+_\d+_\d{8}(?:_[a-z]{2})?\.pdf$/i;

/** The document-ledger key of one saved attachment (see the header). */
export function santanderAttachmentLedgerKey(mailKey: string, savedName: string): string {
  return SELF_DESCRIBING_ATTACHMENT.test(savedName) ? savedName : `${mailKey}/${savedName}`;
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

/**
 * The inbox name for an attachment whose bank name is taken by different bytes:
 * `<mail date>_<message id hash>_<bank name>`. Underscores, not a space after the date, so the
 * organizer never mistakes it for an organized name; it classifies the file by its text.
 */
export function disambiguatedInboxName(mail: Pick<WantedMail, "date" | "messageId">, name: string): string {
  const slug = createHash("sha1").update(mail.messageId).digest("hex").slice(0, 8);
  return `${mail.date.toISOString().slice(0, 10)}_${slug}_${name}`;
}

/** Each PDF attachment into the inbox under the bank's own filename (bounded under the generic kind). */
export function attachmentDocuments(mail: WantedMail): MailDocument[] {
  const period = mailPeriodKey(mail.date);
  if (mail.pdfs.length === 0) return [{ key: mail.mailKey, skip: "no pdf attachment" }];
  const bounded = mail.kind === SANTANDER_PDF_MAIL_KIND;
  if (bounded && mail.pdfs.length > SANTANDER_PDF_MAIL_MAX_ATTACHMENTS) {
    return [
      {
        key: mail.mailKey,
        refuse: `${mail.pdfs.length} PDF attachments, more than the ${SANTANDER_PDF_MAIL_MAX_ATTACHMENTS} a mail under an unknown subject may carry`,
      },
    ];
  }
  return mail.pdfs.map((a, index): MailDocument => {
    const name = safeAttachmentName(a.filename, `santander-${mail.kind}-${period}-${index + 1}.pdf`);
    const key = santanderAttachmentLedgerKey(mail.mailKey, name);
    if (bounded && a.size != null && a.size > SANTANDER_PDF_MAIL_MAX_ATTACHMENT_BYTES) {
      const mb = (n: number) => Math.round(n / (1024 * 1024));
      return { key, refuse: `${name} is ${mb(a.size)} MB, over the ${mb(SANTANDER_PDF_MAIL_MAX_ATTACHMENT_BYTES)} MB bound of a mail under an unknown subject` };
    }
    return {
      key,
      file: name,
      async write(read) {
        const inbox = ensureDir(resolveInboxDir());
        const bytes = (await read.part(a.part)).bytes;
        // A file still sitting in the inbox has not been imported yet. The same bytes are this
        // document (overwriting would only race the importer); other bytes under the same name are
        // another document the bank named alike, saved beside it — never recorded unwritten.
        for (const candidate of [name, disambiguatedInboxName(mail, name)]) {
          const target = path.join(inbox, candidate);
          if (!fs.existsSync(target)) {
            fs.writeFileSync(target, bytes);
            return { written: true };
          }
          if (fs.readFileSync(target).equals(bytes)) return { already: `${candidate} already in inbox` };
        }
        return { error: `${name}: two different documents already sit in the inbox under this name and ${disambiguatedInboxName(mail, name)}` };
      },
    };
  });
}

export const SANTANDER_DOCS_SOURCE: MailSource = {
  label: "Santander documents",
  ledger: "santander",
  query: { from: SANTANDER_MAIL_SENDER },
  kindOf: santanderMailKind,
  // Newest first: when the bank resends a document, the later mail is fetched first and the
  // earlier copy lands beside it (same bytes → skipped; else the organizer files it as a duplicate).
  newestFirst: true,
  // The bank renamed its monthly mails in October 2026 without warning: every PDF it mails is fetched.
  pdfMailKind: SANTANDER_PDF_MAIL_KIND,
  documents: (mail) => (mail.kind === CC_PAYMENT_RECEIPT ? [receiptDocument(mail)] : attachmentDocuments(mail)),
};
