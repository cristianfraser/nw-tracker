/**
 * Stage Santander's transactional mails for a date range: what the bank mails for each card payment,
 * transfer, scheduled transfer, bill payment and dollar purchase, plus the monthly «Paga tu estado
 * de cuenta nacional» notice that states the card's monto facturado.
 *
 * A record of last resort: a month whose cartola or card statement is lost (the bank no longer
 * serves it, and the mail of the day carried only a «see Mis Documentos» notice) can be rebuilt
 * from these, one movement per mail. Nothing is decoded here: each mail is staged as its sending
 * time on the Chile clock (the bank day ends at 14:00 — the posting day is derived from it), its
 * subject and its text, and the script that rebuilds the gap reads them.
 *
 * Read-only on the mailbox (All Mail, so archived mail counts too).
 */
import { archiveMails } from "./mailFetcher.js";

/** The subjects that state a movement; marketing and notices are left out. */
const TRANSACTIONAL_SUBJECT =
  /^(Comprobante|Aviso de transferencia|Aviso de Transferencias?|Transferencia|Compra de divisas|Pago Deuda Nacional)/i;

/**
 * The card's monthly facturado notice, sent under several marketing subjects («Paga tu deuda
 * nacional en cuotas», «¡Paga tu Tarjeta de Crédito en cuotas!»…): a subject that may carry it is
 * downloaded, and kept only when its text states the facturado.
 */
const FACTURADO_SUBJECT = /paga (tu|la)\b.*(cuotas|deuda|estado de cuenta)/i;
const FACTURADO_TEXT = /monto total facturado/i;

export async function archiveSantanderMails(opts: {
  fromYmd: string;
  toYmd: string;
  /** File name under `cfraser/santander-mail-archive/` (default `<from>_<to>.json`). */
  fileName?: string;
}): Promise<{ file: string; count: number }> {
  return archiveMails({
    from: "santander.cl",
    label: "Santander transactional mails",
    fromYmd: opts.fromYmd,
    toYmd: opts.toYmd,
    wantSubject: (subject) => TRANSACTIONAL_SUBJECT.test(subject) || FACTURADO_SUBJECT.test(subject),
    keep: (mail) => TRANSACTIONAL_SUBJECT.test(mail.subject) || FACTURADO_TEXT.test(mail.text),
    dir: "santander-mail-archive",
    fileName: opts.fileName,
  });
}
