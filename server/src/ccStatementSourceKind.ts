/**
 * What kind of document a `cc_statements` row is (`cc_statements.source_kind`, migration 274).
 * Readers read the column (or a row's `source_kind`) through these predicates; nothing tests a
 * `source_pdf` prefix. {@link ccStatementSourceKindOf} is the same classification for a source id
 * not stored yet (an incoming parsed record) — it must equal the migration's generated column,
 * which `ccStatementSourceKind.test.ts` checks row by row.
 */

export const CC_STATEMENT_SOURCE_KINDS = [
  "statement_pdf",
  "statement_json",
  "statement_other",
  "listing_open",
  "listing_other",
] as const;

export type CcStatementSourceKind = (typeof CC_STATEMENT_SOURCE_KINDS)[number];

/** SQL list of the bank-listing kinds, for `source_kind IN …` / `NOT IN …`. */
export const LISTING_SOURCE_KINDS_SQL = "('listing_open', 'listing_other')";

/** The kind a source id names (for a record not stored yet; stored rows carry the column). */
export function ccStatementSourceKindOf(sourcePdf: string | null | undefined): CcStatementSourceKind {
  const t = String(sourcePdf ?? "").trim();
  if (t.startsWith("import:web-paste|open|")) return "listing_open";
  if (t.startsWith("import:web-paste")) return "listing_other";
  if (t.startsWith("import:santander-json|")) return "statement_json";
  if (t.startsWith("import:") || t === "") return "statement_other";
  return "statement_pdf";
}

function requireKind(kind: string | null | undefined): CcStatementSourceKind {
  if (!(CC_STATEMENT_SOURCE_KINDS as readonly string[]).includes(String(kind))) {
    throw new Error(`cc_statements.source_kind «${kind}» is not a known kind — select the column`);
  }
  return kind as CcStatementSourceKind;
}

/** A bank listing (the open bucket or an older paste), not a statement. */
export function isListingSourceKind(kind: string | null | undefined): boolean {
  const k = requireKind(kind);
  return k === "listing_open" || k === "listing_other";
}

/** A statement the bank issued (PDF, JSON or rebuilt), as opposed to a bank listing. */
export function isStatementSourceKind(kind: string | null | undefined): boolean {
  return !isListingSourceKind(kind);
}

/** A statement from the PDF corpus (a file on disk). */
export function isCorpusPdfSourceKind(kind: string | null | undefined): boolean {
  return requireKind(kind) === "statement_pdf";
}

/** The Santander statement JSON. */
export function isJsonStatementSourceKind(kind: string | null | undefined): boolean {
  return requireKind(kind) === "statement_json";
}
