import type { Database as DatabaseType } from "better-sqlite3";
import { movementDocumentKeySql, movementEvidenceAuthoritySql, movementEvidenceKindSql } from "./flowTables279.js";

/**
 * Migration 291 hook: a movement's evidence follows its note (the one place the note grammar is
 * read). Pure: no `db` import.
 */
function evidenceSetSql(a: string): string {
  return `source_kind = ${movementEvidenceKindSql(a)}, document_key = ${movementDocumentKeySql(a)},
    authority = ${movementEvidenceAuthoritySql(a)}, stated_description = ${a}.note`;
}

export const MOVEMENT_EVIDENCE_NOTE_TRIGGER_SQL = `CREATE TRIGGER flow_movements_evidence_au AFTER UPDATE OF note ON movements BEGIN
  UPDATE flow_evidence SET ${evidenceSetSql("NEW")}
  WHERE source_table = 'movements' AND source_row_id = NEW.id;
END`;

export function runMovementEvidenceKind291(dbi: DatabaseType): void {
  dbi.exec(`DROP TRIGGER IF EXISTS flow_movements_evidence_au`);
  dbi.exec(MOVEMENT_EVIDENCE_NOTE_TRIGGER_SQL);
  const changed = dbi
    .prepare(
      `UPDATE flow_evidence SET ${evidenceSetSql("m")}
       FROM movements m
       WHERE flow_evidence.source_table = 'movements' AND flow_evidence.source_row_id = m.id
         AND (flow_evidence.source_kind IS NOT ${movementEvidenceKindSql("m")}
           OR flow_evidence.document_key IS NOT ${movementDocumentKeySql("m")})`
    )
    .run().changes;
  console.log(`migration 291: ${changed} movement evidence row(s) re-derived from a rewritten note`);
}
