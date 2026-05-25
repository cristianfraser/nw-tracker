import { db } from "./db.js";

export type ImportBatchKind =
  | "cc_web_paste"
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
