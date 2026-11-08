/**
 * Incremental statement import: skip statements whose content is what was imported last time.
 *
 * The nightly job feeds every parsed statement to the importer, which would otherwise re-import
 * and — more expensively — re-reconcile every statement in history; one unresolvable legacy
 * statement would abort the whole import every night.
 *
 * A statement's fingerprint (`cards/statementStorage.ts`) is a hash of what the ledger stores of
 * it — its stored columns and its lines' — computed from the canonical statement before it is
 * written. Anything that changes what would be stored (a parser fix, a re-downloaded PDF, a new
 * line) changes it and the statement re-imports with the full reconcile.
 *
 * The gate is only ever a *skip* — it never weakens the reconcile for a statement that does
 * import, and `full` bypasses it for a from-scratch reconciliation.
 */
import { cardStatementKey, type CardCanonicalStatement } from "nw-tracker-contracts";
import { cardStatementFingerprint } from "./cards/statementStorage.js";
import { ccCardGroupOrDefault } from "./ccIssuers.js";
import { ccStatementSourceKindOf, isListingSourceKind } from "./ccStatementSourceKind.js";
import { db } from "./db.js";

const selFingerprint = db.prepare(
  `SELECT import_fingerprint AS fp FROM cc_statements
   WHERE account_id = ? AND card_group = ? AND source_pdf = ? AND statement_date = ?`
);

/**
 * Same fallback the importer uses when the source_pdf does not match: a re-downloaded statement
 * arrives under a new filename but fills the SAME facturación slot, so the existing row is
 * updated rather than duplicated. The fingerprint check has to resolve the row the same way, or
 * such a statement re-imports on every run forever.
 */
const selFingerprintByClose = db.prepare(
  `SELECT import_fingerprint AS fp FROM cc_statements
   WHERE account_id = ? AND card_group = ? AND statement_date = ?
   ORDER BY id DESC LIMIT 1`
);

export type CcIncrementalFilterResult = {
  /** Statements that are new or whose content changed — import these. */
  changed: CardCanonicalStatement[];
  /** Statement keys skipped because their fingerprint matched what is already imported. */
  skippedKeys: string[];
};

/**
 * Split an account's statements into "needs importing" and "unchanged since last import".
 *
 * A statement with no stored fingerprint is always treated as changed. Listing buckets are never
 * skipped: they are provisional and get rewritten by their own repair/supersede logic.
 */
export function filterUnchangedStatements(
  accountId: number,
  statements: readonly CardCanonicalStatement[]
): CcIncrementalFilterResult {
  const changed: CardCanonicalStatement[] = [];
  const skippedKeys: string[] = [];
  for (const statement of statements) {
    if (isListingSourceKind(ccStatementSourceKindOf(statement.document))) {
      changed.push(statement);
      continue;
    }
    // The card group as the importer stores it: the row it resolves the statement to.
    const cardGroup = ccCardGroupOrDefault(statement.card_group);
    const row = (selFingerprint.get(accountId, cardGroup, statement.document, statement.close) ??
      selFingerprintByClose.get(accountId, cardGroup, statement.close)) as { fp: string | null } | undefined;
    if (row?.fp && row.fp === cardStatementFingerprint(statement)) {
      skippedKeys.push(cardStatementKey(statement));
      continue;
    }
    changed.push(statement);
  }
  return { changed, skippedKeys };
}
