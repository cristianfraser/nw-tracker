import type { Database as DatabaseType } from "better-sqlite3";
import { FLOW_SOURCES, reinstallFlowInsertTrigger, type SourceSpec } from "./flowTables279.js";

/**
 * Migration 290 hook (docs/untangle-flow-identity.md, F9 step 4): a flow is retired, not deleted,
 * when its last evidence row goes while something still hangs off it, and a key naming its row by
 * id is detached from it. Pure: no `db` import (the module graph is still loading when it runs).
 */

/** The assignment tables that keep a flow alive once its rows are gone. */
export const FLOW_HOLDING_TABLES = [
  "flow_categories",
  "flow_notes",
  "flow_big_groups",
  "flow_parts",
  "flow_link_rejections",
  "flow_refunds",
  "flow_income_overrides",
] as const;

/** The key family that names a row of the table by its id (reused ids must not reach the old flow). */
const ID_KEY_PREFIX: Partial<Record<SourceSpec["table"], string>> = {
  movements: "checking-mv:",
  cc_statement_lines: "line:",
  cc_installment_purchases: "installment:",
  expense_entries: "manual:",
  checking_gap_deposit_mirrors: "synthetic-checking-gap-mirror:",
};

function holdsSomethingSql(flow: string): string {
  return [
    ...FLOW_HOLDING_TABLES.map((t) => `EXISTS (SELECT 1 FROM ${t} h WHERE h.flow_id = ${flow})`),
    `EXISTS (SELECT 1 FROM flow_links h WHERE h.flow_id = ${flow})`,
  ].join(" OR ");
}

/**
 * The delete trigger: the row's evidence goes; a key naming the row by id is detached; a flow left
 * with no evidence is deleted when bare (no key, nothing hanging off it) and retired otherwise,
 * remembering the document its last evidence named.
 */
export function flowRetireDeleteTriggerSql(spec: SourceSpec): string {
  const t = spec.table;
  const oldFlow = spec.hasFlowColumn
    ? `OLD.flow_id`
    : `(SELECT flow_id FROM flow_evidence WHERE source_table = '${t}' AND source_row_id = OLD.id)`;
  const otherEvidence = `EXISTS (SELECT 1 FROM flow_evidence e WHERE e.flow_id = flows.id
      AND NOT (e.source_table = '${t}' AND e.source_row_id = OLD.id))`;
  const prefix = ID_KEY_PREFIX[t];
  const detach = prefix
    ? `UPDATE flows SET retired_key = legacy_key, legacy_key = NULL WHERE id = ${oldFlow} AND legacy_key = '${prefix}' || OLD.id;`
    : "";
  return `CREATE TRIGGER flow_${t}_ad AFTER DELETE ON ${t} BEGIN
  ${detach}
  UPDATE flows SET retired_on = date('now'), retired_source_table = '${t}',
      retired_document_key = (SELECT document_key FROM flow_evidence WHERE source_table = '${t}' AND source_row_id = OLD.id)
    WHERE id = ${oldFlow} AND NOT ${otherEvidence} AND (legacy_key IS NOT NULL OR ${holdsSomethingSql("flows.id")});
  DELETE FROM flows WHERE id = ${oldFlow} AND retired_on IS NULL AND legacy_key IS NULL AND NOT ${otherEvidence}
    AND NOT (${holdsSomethingSql("flows.id")});
  DELETE FROM flow_evidence WHERE source_table = '${t}' AND source_row_id = OLD.id;
END`;
}

export function installFlowRetireDeleteTriggers(dbi: DatabaseType): void {
  for (const spec of FLOW_SOURCES) {
    dbi.exec(`DROP TRIGGER IF EXISTS flow_${spec.table}_ad`);
    dbi.exec(flowRetireDeleteTriggerSql(spec));
  }
}

function count(dbi: DatabaseType, sql: string): number {
  return (dbi.prepare(sql).get() as { n: number }).n;
}

export function runFlowRetirement290(dbi: DatabaseType): void {
  installFlowRetireDeleteTriggers(dbi);
  reinstallFlowInsertTrigger(dbi, "movements");
  const documentKeys = dbi
    .prepare(
      `UPDATE flow_evidence SET document_key = (SELECT note FROM movements m WHERE m.id = flow_evidence.source_row_id)
       WHERE source_table = 'movements' AND source_kind IN ('cartola', 'cartola_anchor', 'daily_listing')`
    )
    .run().changes;
  // Keys naming a row by id whose row is gone, or now points at another flow (a reused id).
  let detached = 0;
  for (const [table, prefix] of Object.entries(ID_KEY_PREFIX) as [SourceSpec["table"], string][]) {
    const spec = FLOW_SOURCES.find((s) => s.table === table)!;
    const rowFlow = spec.hasFlowColumn
      ? `(SELECT r.flow_id FROM ${table} r WHERE r.id = CAST(substr(f.legacy_key, ${prefix.length + 1}) AS INTEGER))`
      : `(SELECT e.flow_id FROM flow_evidence e WHERE e.source_table = '${table}'
           AND e.source_row_id = CAST(substr(f.legacy_key, ${prefix.length + 1}) AS INTEGER))`;
    detached += dbi
      .prepare(
        `UPDATE flows SET retired_key = legacy_key, legacy_key = NULL
         WHERE id IN (SELECT f.id FROM flows f WHERE substr(f.legacy_key, 1, ${prefix.length}) = '${prefix}'
           AND IFNULL(${rowFlow}, -1) <> f.id)`
      )
      .run().changes;
  }
  const retired = dbi
    .prepare(
      `UPDATE flows SET retired_on = date('now')
       WHERE retired_on IS NULL AND NOT EXISTS (SELECT 1 FROM flow_evidence e WHERE e.flow_id = flows.id)`
    )
    .run().changes;
  const bare = count(
    dbi,
    `SELECT COUNT(*) AS n FROM flows WHERE retired_on IS NOT NULL AND legacy_key IS NULL AND NOT (${holdsSomethingSql("flows.id")})`
  );
  console.log(
    `migration 290: ${documentKeys} movement evidence row(s) keyed by their document; ${detached} id-named key(s) detached; ` +
      `${retired} flow(s) with no evidence retired (${bare} holding nothing)`
  );
}
