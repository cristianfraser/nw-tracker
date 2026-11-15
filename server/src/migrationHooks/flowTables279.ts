import type { Database as DatabaseType } from "better-sqlite3";
import { normalizeMerchantText } from "nw-tracker-contracts";
import { writeLogTriggerSql } from "../markInputTriggers.js";
import { resolveExpenseKey, type FlowSourceRow, type FlowSourceTable } from "../flows/flowKeyResolve.js";
import {
  EVIDENCE_COLUMNS,
  FLOW_COLUMNS,
  FLOW_SOURCES,
  VOCABULARY_279,
  flowDeleteTriggerSql,
  flowInsertTriggerSql,
} from "../flows/flowTriggerSpecs.js";

/**
 * Migration 279 hook (docs/untangle-flow-identity.md, F9 step 3): seeds the outside parties, one
 * flow per expense identity and one evidence row per document row, then installs the triggers that
 * give every row written later its own flow. Report-first: counts go to the boot log before the
 * hook asserts, and nothing in the report names a party or an amount.
 *
 * Identity in this step is the expense key: every key an assignment table stores becomes one flow
 * (`legacy_key`), and the rows that key names (`flowKeyResolve.ts`) point at it — a plan, its twins
 * and the cuota lines paid against it share their purchase's flow; a checking movement's gastos and
 * deposit portions share the movement's. A key that names no row (its row is gone, or now carries
 * another key) gets no flow: its assignment is archived by the table's own migration. Every other
 * row gets a flow of its own with no key, stamped when an assignment first names it.
 *
 * The SQL that turns a row into a flow lives in `flows/flowTriggerSpecs.ts` (the living trigger
 * definition, shared with the later hooks and the boot check): the seed (alias `r`) and the insert
 * triggers (alias `NEW`) use the same values, so a row written later gets the same flow a row on
 * file got. Pure: no `db` import (the module graph is still loading when it runs).
 */

const ASSIGNMENT_KEY_SOURCES: readonly { table: string; column: string }[] = [
  { table: "cc_expense_unique_purchases", column: "purchase_key" },
  { table: "cc_expense_purchase_notes", column: "purchase_key" },
  { table: "cc_expense_purchase_big_groups", column: "purchase_key" },
  { table: "expense_deposit_links", column: "purchase_key" },
  { table: "real_estate_expense_links", column: "purchase_key" },
  { table: "real_estate_expense_link_rejections", column: "purchase_key" },
  { table: "cc_facturado_financing_link_purchases", column: "financing_purchase_key" },
];

export type FlowSeedReport = {
  parties_by_source: Record<string, number>;
  keys_by_table: Record<string, { stored: number; resolved: number; orphaned: number }>;
  keyed_flows: number;
  keyless_flows: number;
  rows_named_by_two_keys: number;
  flows_by_kind: Record<string, number>;
  evidence_by_source_kind: Record<string, number>;
};

function seedParties(dbi: DatabaseType): void {
  const ins = dbi.prepare(
    `INSERT OR IGNORE INTO outside_parties (kind, name, name_key, rut, source) VALUES (?, ?, ?, ?, ?)`
  );
  ins.run("other", "unknown", "unknown", null, "system");
  ins.run("other", "unrecorded account", "unrecorded account", null, "system");
  const vendors = dbi
    .prepare(`SELECT DISTINCT match_kind, pattern, display FROM vendor_catalog WHERE source IN ('seed', 'user') ORDER BY id`)
    .all() as { match_kind: string; pattern: string; display: string }[];
  for (const v of vendors) {
    const rut = v.match_kind === "rut" ? v.pattern : null;
    ins.run(rut ? "other" : "merchant", v.display, normalizeMerchantText(v.display), rut, "vendor_catalog");
  }
  const counterparties = dbi
    .prepare(`SELECT DISTINCT rut FROM transfer_counterparty_accounts WHERE rut IS NOT NULL ORDER BY rut`)
    .all() as { rut: string }[];
  for (const c of counterparties) ins.run("other", c.rut, c.rut, c.rut, "counterparty");
  const employers = dbi
    .prepare(
      `SELECT DISTINCT employer_name, employer_rut FROM payroll_work_earnings WHERE employer_name IS NOT NULL AND employer_name <> ''`
    )
    .all() as { employer_name: string; employer_rut: string | null }[];
  for (const e of employers) ins.run("employer", e.employer_name, normalizeMerchantText(e.employer_name), e.employer_rut, "employer");
  const payees = dbi
    .prepare(
      `SELECT DISTINCT payee_name, payee_rut FROM payment_processor_receipts WHERE payee_name IS NOT NULL AND payee_name <> ''`
    )
    .all() as { payee_name: string; payee_rut: string | null }[];
  for (const p of payees) {
    const key = normalizeMerchantText(p.payee_name);
    if (key) ins.run("merchant", p.payee_name, key, p.payee_rut, "payee");
  }
}

function countBy(dbi: DatabaseType, sql: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of dbi.prepare(sql).all() as { k: string; c: number }[]) out[r.k] = r.c;
  return out;
}

export function runFlowTables279(dbi: DatabaseType): FlowSeedReport {
  seedParties(dbi);

  // 1. One flow per stored key that names a row; its rows point at it.
  const rowFlow = new Map<string, number>();
  const rowKey = (r: FlowSourceRow) => `${r.table}|${r.id}`;
  const keysByTable: FlowSeedReport["keys_by_table"] = {};
  let keyedFlows = 0;
  let conflicts = 0;
  const flowByKey = new Map<string, number>();
  for (const src of ASSIGNMENT_KEY_SOURCES) {
    const stored = dbi.prepare(`SELECT ${src.column} AS k FROM ${src.table}`).all() as { k: string }[];
    const tally = { stored: stored.length, resolved: 0, orphaned: 0 };
    for (const { k } of stored) {
      const resolved = resolveExpenseKey(dbi, k);
      if (resolved == null) throw new Error(`migration 279: ${src.table} holds «${k}», which is not an expense key`);
      if (resolved.rows.length === 0) {
        tally.orphaned += 1;
        continue;
      }
      tally.resolved += 1;
      if (flowByKey.has(resolved.flowKey)) continue;
      const primary = resolved.rows[0]!;
      const spec = FLOW_SOURCES.find((s) => s.table === primary.table)!;
      const id = Number(
        dbi
          .prepare(`INSERT INTO flows (${FLOW_COLUMNS}, legacy_key) SELECT ${spec.flowValues("r")}, ? FROM ${primary.table} r WHERE r.id = ?`)
          .run(resolved.flowKey, primary.id).lastInsertRowid
      );
      flowByKey.set(resolved.flowKey, id);
      keyedFlows += 1;
      for (const row of resolved.rows) {
        const prior = rowFlow.get(rowKey(row));
        if (prior != null && prior !== id) {
          conflicts += 1;
          continue;
        }
        rowFlow.set(rowKey(row), id);
      }
    }
    keysByTable[src.table] = tally;
  }

  // 2. Point every keyed row at its flow; every other row gets a flow of its own (a cuota line paid
  //    against a plan joins the plan's).
  for (const [k, flowId] of rowFlow) {
    const [table, id] = k.split("|") as [FlowSourceTable, string];
    const spec = FLOW_SOURCES.find((s) => s.table === table)!;
    if (spec.hasFlowColumn) dbi.prepare(`UPDATE ${table} SET flow_id = ? WHERE id = ?`).run(flowId, Number(id));
  }
  let keylessFlows = 0;
  for (const spec of FLOW_SOURCES) {
    const where = [spec.where?.("r")].filter(Boolean);
    const ids = (
      dbi.prepare(`SELECT r.id FROM ${spec.table} r ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY r.id`).all() as {
        id: number;
      }[]
    ).map((r) => r.id);
    for (const id of ids) {
      if (rowFlow.has(`${spec.table}|${id}`)) continue;
      if (spec.table === "cc_statement_lines") {
        const plan = dbi
          .prepare(
            `SELECT MIN(p.flow_id) AS f FROM cc_statement_lines l
             JOIN cc_installment_payments pay ON pay.parser_row_id = l.parser_row_id
             JOIN cc_installment_purchases p ON p.id = pay.purchase_id
             WHERE l.id = ? AND l.installment_flag = 1`
          )
          .get(id) as { f: number | null };
        if (plan.f != null) {
          dbi.prepare(`UPDATE cc_statement_lines SET flow_id = ? WHERE id = ?`).run(plan.f, id);
          rowFlow.set(`${spec.table}|${id}`, plan.f);
          continue;
        }
      }
      const flowId = Number(
        dbi.prepare(`INSERT INTO flows (${FLOW_COLUMNS}) SELECT ${spec.flowValues("r")} FROM ${spec.table} r WHERE r.id = ?`).run(id)
          .lastInsertRowid
      );
      keylessFlows += 1;
      rowFlow.set(`${spec.table}|${id}`, flowId);
      if (spec.hasFlowColumn) dbi.prepare(`UPDATE ${spec.table} SET flow_id = ? WHERE id = ?`).run(flowId, id);
    }
  }

  // 3. One evidence row per document row.
  for (const spec of FLOW_SOURCES) {
    const where = [spec.where?.("r")].filter(Boolean);
    const ids = (
      dbi.prepare(`SELECT r.id FROM ${spec.table} r ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`).all() as { id: number }[]
    ).map((r) => r.id);
    const ins = dbi.prepare(
      `INSERT INTO flow_evidence (flow_id, ${EVIDENCE_COLUMNS}) SELECT ?, ${spec.evidenceValues("r", VOCABULARY_279)} FROM ${spec.table} r WHERE r.id = ?`
    );
    for (const id of ids) ins.run(rowFlow.get(`${spec.table}|${id}`)!, id);
  }

  // 4. Triggers: rows written later; the write log of the new tables.
  for (const spec of FLOW_SOURCES) {
    dbi.exec(flowInsertTriggerSql(spec, VOCABULARY_279));
    dbi.exec(flowDeleteTriggerSql(spec, []));
  }
  for (const table of ["outside_parties", "flows", "flow_evidence", "flow_orphan_assignments"]) {
    const columns = (dbi.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[]).map((c) => c.name);
    for (const sql of writeLogTriggerSql(table, columns, null)) dbi.exec(sql);
  }

  const report: FlowSeedReport = {
    parties_by_source: countBy(dbi, `SELECT source AS k, COUNT(*) AS c FROM outside_parties GROUP BY source`),
    keys_by_table: keysByTable,
    keyed_flows: keyedFlows,
    keyless_flows: keylessFlows,
    rows_named_by_two_keys: conflicts,
    flows_by_kind: countBy(dbi, `SELECT kind AS k, COUNT(*) AS c FROM flows GROUP BY kind`),
    evidence_by_source_kind: countBy(dbi, `SELECT source_kind AS k, COUNT(*) AS c FROM flow_evidence GROUP BY source_kind`),
  };
  console.log(`migration 279 (flows): ${JSON.stringify(report)}`);

  // Every row that must be a flow is one; every flow has its evidence or its key.
  for (const spec of FLOW_SOURCES.filter((s) => s.hasFlowColumn)) {
    const where = [`r.flow_id IS NULL`, spec.where?.("r")].filter(Boolean).join(" AND ");
    const missing = dbi.prepare(`SELECT r.id FROM ${spec.table} r WHERE ${where} LIMIT 5`).all() as { id: number }[];
    if (missing.length > 0) {
      throw new Error(`migration 279: ${spec.table} rows without a flow: ${missing.map((m) => m.id).join(", ")}`);
    }
  }
  const bare = dbi
    .prepare(
      `SELECT id FROM flows f WHERE f.legacy_key IS NULL AND NOT EXISTS (SELECT 1 FROM flow_evidence e WHERE e.flow_id = f.id) LIMIT 5`
    )
    .all() as { id: number }[];
  if (bare.length > 0) throw new Error(`migration 279: flows with neither key nor evidence: ${bare.map((b) => b.id).join(", ")}`);
  if (conflicts > 0) throw new Error(`migration 279: ${conflicts} row(s) named by two keys`);
  return report;
}
