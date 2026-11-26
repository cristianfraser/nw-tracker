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

/**
 * A row a document restated in place (a listing line its statement bills, a daily-listing movement
 * its cartola lists) keeps its earlier evidence on its flow as history: the evidence row stays as the
 * listing stated it — its kind, document key, day, amount and wording — under `source_table`
 * `restated:<table>` and `source_row_id` its own id, so it names no live row (every per-row lookup
 * reads `source_table = '<table>'`) and never collides with another. The row then gets a fresh
 * evidence row for the document. The flow delete triggers read history as history (migration 371):
 * it neither holds the flow nor stops its retirement.
 */
export const RESTATED_EVIDENCE_PREFIX = "restated:";

/** SQL: evidence row `alias` names a live source row (not a restated row's history). */
export function liveEvidenceSql(alias: string): string {
  return `${alias}.source_table NOT LIKE '${RESTATED_EVIDENCE_PREFIX}%'`;
}

/**
 * Turns the evidence of `table` row `rowId` into history (see {@link RESTATED_EVIDENCE_PREFIX}).
 * Throws when the row has none.
 */
export function keepEvidenceAsHistory(
  dbHandle: { prepare(sql: string): { run(...params: unknown[]): { changes: number } } },
  table: string,
  rowId: number
): void {
  const changes = dbHandle
    .prepare(
      `UPDATE flow_evidence SET source_table = ?, source_row_id = id WHERE source_table = ? AND source_row_id = ?`
    )
    .run(`${RESTATED_EVIDENCE_PREFIX}${table}`, table, rowId).changes;
  if (changes !== 1) throw new Error(`${table} ${rowId}: no evidence row to keep as history`);
}
