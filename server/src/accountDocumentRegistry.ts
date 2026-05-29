import { accountBucketKindSlug } from "./accountBucket.js";
import { db } from "./db.js";

export type DocumentImportType = "afp_uno_cert";

export type DocumentImportSpec = {
  type: DocumentImportType;
  labelKey: string;
  accept: string;
  categorySlugs: string[];
};

export const DOCUMENT_IMPORT_SPECS: DocumentImportSpec[] = [
  {
    type: "afp_uno_cert",
    labelKey: "accountDetail.import.afpUnoCert",
    accept: ".pdf,.csv,.txt",
    categorySlugs: ["afp"],
  },
];

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
