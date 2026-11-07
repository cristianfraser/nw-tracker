/**
 * Fetch the BCI Lider «Estado de Cuenta» (the card facturación) out of Gmail into `cfraser/inbox/`.
 *
 * The bank mails the monthly statement from estadodecuenta@correo.tarjetaliderbci.cl (subject
 * «Estado de Cuenta Tarjeta Lider Bci Visa») a day or two after the ~26th close. The statement is
 * a PDF attachment encrypted with the RUT's last 4 digits — the inbox pipeline's qpdf-decrypt step
 * (`LIDER_CC_STATEMENT_PDF_PASSWORD`) handles that — and some months the mail also carries an
 * «Inserto Seguros.pdf» insurance insert that must NEVER reach the inbox: the organizer fails the
 * whole pipeline on a PDF with no statement text. The statement is the attachment whose filename
 * is a bare number, and that filter is a hard expectation — any other attachment shape is an
 * ERROR (non-zero exit), never a guess, so a template change surfaces as a failed step instead of
 * a silently missing facturación.
 *
 * UNLIKE santanderDocs, the ledger key is the mail date + message id, NOT the attachment
 * filename: BCI reuses the SAME filename every month (`155028273.pdf` in Jun, Jul and Aug 2026 —
 * a client number, not a document number), so a filename key would mark the first month as
 * fetched and silently skip every one after it. Each month is its own mail, which makes the
 * message id a stable per-document identity (the boleta rule). The saved inbox name is
 * date-prefixed for the same reason; the organizer renames it canonically from the PDF's own
 * statement date either way, so downstream is unchanged.
 *
 * No `--all` backfill on purpose: the historical closes are already imported from manually saved
 * copies under other filenames, and a second copy of a close makes the incremental import
 * ping-pong the statement row between source names (see PARSERS.md, 2026-08-10).
 */
import { resolveInboxDir } from "../paths.js";
import { singlePdfDocument, type MailSource } from "./mailFetcher.js";
import { normalizeMailSubject } from "./mime.js";

export const LIDER_STATEMENT_SENDER = "estadodecuenta@correo.tarjetaliderbci.cl";

export function isLiderStatementSubject(subject: string): boolean {
  const s = normalizeMailSubject(subject);
  return s.includes("estado de cuenta") && s.includes("lider");
}

/** The statement is the bare-number attachment; anything with a name («Inserto Seguros.pdf») is an insert. */
export function isLiderStatementAttachmentName(filename: string): boolean {
  return /^\d+\.pdf$/i.test(String(filename ?? "").trim());
}

export const LIDER_STATEMENT_SOURCE: MailSource = {
  label: "Lider statement",
  ledger: "lider",
  query: { from: LIDER_STATEMENT_SENDER },
  kindOf: (subject) => (isLiderStatementSubject(subject) ? "email-cc-statement" : null),
  documents: (mail) => [
    singlePdfDocument(mail, {
      dir: resolveInboxDir,
      accept: isLiderStatementAttachmentName,
      fallbackName: "lider-estado-de-cuenta.pdf",
      shape: "bare-number statement pdf",
    }),
  ],
};
