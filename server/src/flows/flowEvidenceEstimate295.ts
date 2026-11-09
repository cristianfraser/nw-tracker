import type { Database as DatabaseType } from "better-sqlite3";
import { writeLogTriggerSql } from "../markInputTriggers.js";
import { ESTIMATE_DOCUMENT_PREFIX, ESTIMATE_LINE_ID_PREFIX, reinstallFlowInsertTrigger } from "./flowTables279.js";

/**
 * Migration 295 hook (docs/untangle-flow-model.md C): `flow_evidence.source_kind` gains `estimate`.
 * The CHECK cannot be widened in place, so the table is rebuilt (its rows copied, the lines of the
 * estimate statements on file re-kinded), its write log reinstalled, and the card-line insert
 * trigger re-created from `flowTables279.ts`, whose line evidence now names the kind. Pure: no `db`
 * import (the module graph is still loading when it runs).
 */
export function runFlowEvidenceEstimateKind295(dbi: DatabaseType): void {
  const before = (dbi.prepare(`SELECT COUNT(*) AS c FROM flow_evidence`).get() as { c: number }).c;
  const create = (dbi.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'flow_evidence'`).get() as { sql: string }).sql;
  if (!create.includes("'statement_other', 'listing_open'")) throw new Error("migration 295: flow_evidence's CHECK is not the expected list");
  const rebuilt = create
    .replace(/CREATE TABLE (IF NOT EXISTS )?"?flow_evidence"?/, "CREATE TABLE flow_evidence_295")
    .replace("'statement_other', 'listing_open'", "'statement_other', 'estimate', 'listing_open'");
  dbi.exec(rebuilt);
  const columns = (dbi.prepare(`SELECT name FROM pragma_table_info('flow_evidence')`).all() as { name: string }[]).map((c) => c.name).join(", ");
  dbi.exec(`INSERT INTO flow_evidence_295 (${columns}) SELECT ${columns} FROM flow_evidence`);
  const indexes = dbi.prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'flow_evidence' AND sql IS NOT NULL`).all() as { sql: string }[];
  // The flow delete triggers of the source tables name `flow_evidence`: the swap runs in legacy
  // rename mode so they keep saying so (see migration 293's hook).
  dbi.exec(`DROP TABLE flow_evidence`);
  dbi.pragma("legacy_alter_table = ON");
  try {
    dbi.exec(`ALTER TABLE flow_evidence_295 RENAME TO flow_evidence`);
  } finally {
    dbi.pragma("legacy_alter_table = OFF");
  }
  for (const ix of indexes) dbi.exec(ix.sql);
  const after = (dbi.prepare(`SELECT COUNT(*) AS c FROM flow_evidence`).get() as { c: number }).c;
  if (after !== before) throw new Error(`migration 295: ${before} evidence row(s) became ${after}`);
  const cols = (dbi.prepare(`SELECT name FROM pragma_table_info('flow_evidence')`).all() as { name: string }[]).map((c) => c.name);
  for (const sql of writeLogTriggerSql("flow_evidence", cols, null)) dbi.exec(sql);
  const rekinded = dbi
    .prepare(
      `UPDATE flow_evidence SET source_kind = 'estimate'
       WHERE source_table = 'cc_statement_lines' AND source_row_id IN (
         SELECT l.id FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id
         WHERE s.source_pdf LIKE ? OR l.parser_row_id LIKE ?)`
    )
    .run(`${ESTIMATE_DOCUMENT_PREFIX}%`, `${ESTIMATE_LINE_ID_PREFIX}%`).changes;
  reinstallFlowInsertTrigger(dbi, "cc_statement_lines");
  console.log(`migration 295: flow_evidence rebuilt with the estimate kind (${after} rows); ${rekinded} estimated card line(s) re-kinded`);
}
