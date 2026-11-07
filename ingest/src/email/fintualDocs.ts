/**
 * Fetch Fintual's «Acciones» documents (the US brokerage account, custodied at Alpaca) out of
 * Gmail into `cfraser/fintual-acciones/`.
 *
 * Two documents matter, both PDF attachments from hola@fintual.com:
 *  - «Cartola mensual de Acciones» — Alpaca's monthly statement, mailed ~the 10th of the next
 *    month. Its Income section is the one automatic source of the gross dividend, the per-share
 *    rate, the record date and the US withholding («Div. Adj(NRA Withheld) … at 15% for tax
 *    country CHL»), which the dividend notification mails never carry (the «Recibiste un
 *    dividendo de LIN por US $10,75» figure is what was credited).
 *  - «Certificado de transacciones y eventos de capital en Acciones» — requested by hand in the
 *    app; prints every dividend as bruto / impuestos / neto since the account opened. The
 *    full-history backfill and the cross-check for the cartolas.
 * Trade confirmations and the holdings certificate are deliberately not fetched: the ledger
 * already has every trade from the notification mails and the certificado CSV.
 *
 * The ledger key is the mail date + message id (`mailDocumentLedgerKey`), NOT the attachment
 * filename: Fintual names the cartola after the month only (`cartola_mensual_agosto.pdf`), so a
 * filename key would skip every August after the first, and the certificado is always
 * `certificado.pdf`. The saved copy is date-prefixed for the same reason. Files stay where they
 * land — the importer (`import:fintual-acciones`) reads these folders directly and is
 * idempotent, so there is no inbox hand-off to archive.
 */
import path from "node:path";
import { resolveCfraserDir } from "../paths.js";
import { singlePdfDocument, type MailSource } from "./mailFetcher.js";
import { normalizeMailSubject } from "./mime.js";

export const FINTUAL_MAIL_SENDER = "hola@fintual.com";

type FintualAccionesDoc = { kind: string; subdir: string; fallbackName: string; matchesSubject: (normalizedSubject: string) => boolean };

const FINTUAL_ACCIONES_DOCS: readonly FintualAccionesDoc[] = [
  {
    kind: "email-acciones-cartola",
    subdir: "cartolas",
    fallbackName: "cartola_mensual.pdf",
    matchesSubject: (s) => s.includes("cartola mensual de acciones"),
  },
  {
    kind: "email-acciones-certificado",
    subdir: "certificados",
    fallbackName: "certificado.pdf",
    matchesSubject: (s) => s.includes("certificado de transacciones y eventos de capital"),
  },
];

const docOfKind = (kind: string) => FINTUAL_ACCIONES_DOCS.find((d) => d.kind === kind)!;

export function resolveFintualAccionesDir(): string {
  return path.join(resolveCfraserDir(), "fintual-acciones");
}

export const FINTUAL_ACCIONES_SOURCE: MailSource = {
  label: "Fintual Acciones documents",
  ledger: "fintual",
  // `subject` narrows server-side to the Acciones mails; the notification mails share the sender.
  query: { from: FINTUAL_MAIL_SENDER, subject: "Acciones" },
  kindOf(subject) {
    const normalized = normalizeMailSubject(subject);
    return FINTUAL_ACCIONES_DOCS.find((d) => d.matchesSubject(normalized))?.kind ?? null;
  },
  documents(mail) {
    const doc = docOfKind(mail.kind);
    return [
      singlePdfDocument(mail, {
        dir: () => path.join(resolveFintualAccionesDir(), doc.subdir),
        fallbackName: doc.fallbackName,
        shape: "pdf attachment",
      }),
    ];
  },
};
