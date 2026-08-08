/**
 * Statement-source ownership («JSON leads, PDF import guarded»).
 *
 * `cc_statements` is UNIQUE on (account_id, card_group, source_pdf, statement_date), so the
 * same facturación arriving from two sources would create two statement rows and double the
 * ledger. Ownership is period-level, over (statement close, currency), and **the PDF outranks
 * the JSON** (2026-08-06):
 *
 *  - The JSON importer skips PDF-owned closes entirely (report-only cross-check — the diff that
 *    has already caught real PDF data loss).
 *  - An incoming PDF for a JSON-owned close SUPERSEDES it: the JSON statement rows are deleted
 *    and the PDF is written in their place (`mergeCcAccountFromParsedRows`).
 *
 * The asymmetry is deliberate. JSON is the fast first writer — it can publish a facturación the
 * day it closes — but it is not the authoritative document: the international endpoint is
 * dateless and returns all-NULL headers, so a JSON USD statement carries lines only. The real
 * statement PDF arrives by e-mail a day or two later, and under plain first-writer-wins it would
 * have been dropped forever, leaving the ledger permanently on the thinner source.
 *
 * Web-paste buckets are provisional evidence and never own a close.
 */
import { db } from "./db.js";

export const SANTANDER_JSON_SOURCE_PREFIX = "import:santander-json|";

export function isSantanderJsonSource(sourcePdf: string | null | undefined): boolean {
  return String(sourcePdf ?? "").trim().startsWith(SANTANDER_JSON_SOURCE_PREFIX);
}

/** Stable synthetic source id for a JSON-written statement (one per close + currency). */
export function santanderJsonSourcePdf(currency: "clp" | "usd", statementDate: string): string {
  return `${SANTANDER_JSON_SOURCE_PREFIX}${currency}|${padCcStatementDate(statementDate)}`;
}

/** `23/7/2026` → `23/07/2026` — stored statement dates are zero-padded. */
export function padCcStatementDate(date: string): string {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(date ?? "").trim());
  if (!m) return String(date ?? "").trim();
  return `${m[1]!.padStart(2, "0")}/${m[2]!.padStart(2, "0")}/${m[3]}`;
}

const listOwningSources = db.prepare(
  `SELECT source_pdf FROM cc_statements
   WHERE account_id = ? AND statement_date = ? AND currency = ?
     AND source_pdf NOT LIKE 'import:web-paste%'`
);

export type CcStatementSourceOwner = "json" | "pdf" | null;

/** Which source owns this (close, currency), if any. */
export function statementSourceOwnerForClose(
  accountId: number,
  statementDate: string,
  currency: "clp" | "usd"
): CcStatementSourceOwner {
  const rows = listOwningSources.all(accountId, padCcStatementDate(statementDate), currency) as {
    source_pdf: string;
  }[];
  if (rows.length === 0) return null;
  return rows.some((r) => isSantanderJsonSource(r.source_pdf)) ? "json" : "pdf";
}

const listJsonOwnedCloses = db.prepare(
  `SELECT DISTINCT statement_date, currency FROM cc_statements
   WHERE account_id = ? AND source_pdf LIKE 'import:santander-json|%'`
);

/** `${padded statement_date}\t${currency}` closes the JSON importer owns on this account. */
export function jsonOwnedClosesForAccount(accountId: number): Set<string> {
  const rows = listJsonOwnedCloses.all(accountId) as { statement_date: string; currency: string }[];
  return new Set(rows.map((r) => `${padCcStatementDate(r.statement_date)}\t${r.currency}`));
}

export type JsonOwnedStatementRow = {
  id: number;
  card_group: string;
  source_pdf: string;
  statement_date: string;
  currency: string;
};

const listJsonOwnedStatements = db.prepare(
  `SELECT id, card_group, source_pdf, statement_date, currency FROM cc_statements
   WHERE account_id = ? AND source_pdf LIKE 'import:santander-json|%'`
);

/** The JSON-written statement rows on this account, for PDF supersession. */
export function listJsonOwnedStatementsForAccount(accountId: number): JsonOwnedStatementRow[] {
  return listJsonOwnedStatements.all(accountId) as JsonOwnedStatementRow[];
}

/** Reconcile/replacement key for a statement row (`card_group \t source_pdf \t statement_date`). */
export function statementReplaceKey(row: {
  card_group: string;
  source_pdf: string;
  statement_date: string;
}): string {
  return `${row.card_group}\t${row.source_pdf}\t${row.statement_date}`;
}

const deleteStatementById = db.prepare(`DELETE FROM cc_statements WHERE id = ?`);

/** Drop JSON statement rows a PDF is taking over (lines cascade via the FK). */
export function deleteJsonStatementsByIds(ids: readonly number[]): number {
  let deleted = 0;
  for (const id of ids) deleted += deleteStatementById.run(id).changes;
  return deleted;
}
