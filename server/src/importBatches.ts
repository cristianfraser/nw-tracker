import { db } from "./db.js";

export type ImportBatchKind =
  | "cc_web_paste"
  /** Same lines as a web paste, but fetched from the bank's own API by `ingest/`. */
  | "cc_santander_fetch"
  /** One line per card-paid Lider boleta e-mail (the grocery-receipt importer). */
  | "cc_lider_boleta"
  /** The card's own PAGO / ABONO DE DIVISAS line, planted from a Santander payment receipt mail. */
  | "cc_santander_receipt"
  /** The card's credit line, planted for a card payment entered by hand (`ccManualPayments.ts`). */
  | "cc_manual_payment"
  /** A card's PAGO, planted when cuota purchases on another card paid its facturado. */
  | "cc_financing_payment"
  /** Same lines as a web paste, from the scheduled Lider «últimos movimientos» CSV drop. */
  | "cc_lider_fetch"
  | "cuenta_vista_web_paste"
  | "cc_statement_pdf"
  | "checking_recent_xlsx"
  | "checking_cartola_xlsx"
  | "afp_uno_cert"
  | "fintual_cert"
  | "document";

export function createImportBatch(
  kind: ImportBatchKind,
  filename: string | null,
  summary: Record<string, unknown>
): number {
  const r = db
    .prepare(
      `INSERT INTO import_batches (kind, filename, status, raw_text)
       VALUES (?, ?, 'completed', ?)`
    )
    .run(kind, filename, JSON.stringify(summary));
  return Number(r.lastInsertRowid);
}
