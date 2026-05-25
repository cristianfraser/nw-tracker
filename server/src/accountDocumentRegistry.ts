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
      `SELECT c.slug AS category_slug FROM accounts a JOIN categories c ON c.id = a.category_id WHERE a.id = ?`
    )
    .get(accountId) as { category_slug: string } | undefined;
  if (!row) return [];
  return DOCUMENT_IMPORT_SPECS.filter((s) => s.categorySlugs.includes(row.category_slug));
}

export function listDocumentImportTypesForAccount(accountId: number): DocumentImportType[] {
  return documentImportSpecsForAccount(accountId).map((s) => s.type);
}
