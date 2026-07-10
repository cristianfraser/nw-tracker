import { accountBucketKindSlug } from "./accountBucket.js";
import { db } from "./db.js";

/**
 * Per-account document-upload types. Empty since the AFP UNO cert upload was retired
 * (2026-07, cuota ledger certificate-rebuilt); the client renders upload buttons from
 * DOCUMENT_IMPORT_SPECS, so an empty list means no upload UI. Future document types
 * (e.g. EUR card statements) add entries here.
 */
export type DocumentImportType = string;

export type DocumentImportSpec = {
  type: DocumentImportType;
  labelKey: string;
  accept: string;
  categorySlugs: string[];
};

export const DOCUMENT_IMPORT_SPECS: DocumentImportSpec[] = [];

export function documentImportSpecsForAccount(accountId: number): DocumentImportSpec[] {
  const row = db
    .prepare(
      `SELECT g.slug AS bucket_slug FROM accounts a JOIN asset_groups g ON g.id = a.asset_group_id WHERE a.id = ?`
    )
    .get(accountId) as { bucket_slug: string } | undefined;
  if (!row) return [];
  const kind = accountBucketKindSlug(row.bucket_slug);
  return DOCUMENT_IMPORT_SPECS.filter((s) => s.categorySlugs.includes(kind));
}

export function listDocumentImportTypesForAccount(accountId: number): DocumentImportType[] {
  return documentImportSpecsForAccount(accountId).map((s) => s.type);
}
