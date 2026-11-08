/**
 * What a document says about a row, read from its evidence (docs/untangle-flow-identity.md, F9
 * step 4: provenance in columns). A movement's evidence row carries its document kind — a cartola
 * row, the cartola's opening anchor, a daily listing row, a mail-written row, a broker document, a
 * legacy import, a hand entry — kept in step with the row by the migration 279/291 triggers, so a
 * reader asks the kind instead of testing note prefixes.
 */

/** SQL for the document kind of the movement aliased `alias` (`flow_evidence.source_kind`). */
export function movementSourceKindSql(alias: string): string {
  return `(SELECT e.source_kind FROM flow_evidence e WHERE e.source_table = 'movements' AND e.source_row_id = ${alias}.id)`;
}

/** The kinds a checking account's own bank documents and mails list (`listCheckingMovements`). */
export const CHECKING_LISTED_SOURCE_KINDS = ["cartola", "daily_listing", "mail_notice", "mail_rebuilt"] as const;

/** SQL: the movement is one of `kinds`. */
export function movementSourceKindInSql(alias: string, kinds: readonly string[]): string {
  return `${movementSourceKindSql(alias)} IN (${kinds.map((k) => `'${k}'`).join(", ")})`;
}

/** SQL: the movement is not an opening balance a cartola import derived (the ledger anchor). */
export function movementNotAnchorSql(alias: string): string {
  return `${movementSourceKindSql(alias)} <> 'cartola_anchor'`;
}
