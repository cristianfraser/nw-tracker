import type { Database as DatabaseType } from "better-sqlite3";
import { LEGACY_FLOW_KIND_MAP, normalizeMerchantText } from "nw-tracker-contracts";
import { writeLogTriggerSql } from "../markInputTriggers.js";
import { resolveExpenseKey, type FlowSourceRow, type FlowSourceTable } from "./flowKeyResolve.js";

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
 * The SQL that turns a row into a flow is built once per table (`*FlowValues`) and used by the
 * seed (alias `r`) and by the insert triggers (alias `NEW`), so a row written later gets the same
 * flow a row on file got. Pure: no `db` import (the module graph is still loading when it runs).
 */

const UNKNOWN_PARTY = `(SELECT id FROM outside_parties WHERE source = 'system' AND name_key = 'unknown')`;
const UNRECORDED_PARTY = `(SELECT id FROM outside_parties WHERE source = 'system' AND name_key = 'unrecorded account')`;

/** `dd/mm/yy` / `dd/mm/yyyy` text → ISO, in SQL (NULL otherwise). */
function isoFromDdMmSql(col: string): string {
  return `(CASE WHEN length(${col}) = 8 THEN '20' || substr(${col}, 7, 2) || '-' || substr(${col}, 4, 2) || '-' || substr(${col}, 1, 2)
     WHEN length(${col}) = 10 THEN substr(${col}, 7, 4) || '-' || substr(${col}, 4, 2) || '-' || substr(${col}, 1, 2) END)`;
}

/** The kind a movement maps to (`LEGACY_FLOW_KIND_MAP.MovementFlowType`; a kind-less row by its sign). */
function movementKindSql(a: string): string {
  const cases = Object.entries(LEGACY_FLOW_KIND_MAP.MovementFlowType)
    .map(([from, to]) => `WHEN '${from}' THEN '${to}'`)
    .join(" ");
  return `COALESCE(CASE ${a}.flow_kind ${cases} END,
    CASE WHEN ${a}.account_id IS NULL THEN 'transfer'
         WHEN ${movementOutgoingSql(a)} THEN 'withdrawal'
         WHEN ${a}.amount > 0 THEN 'deposit'
         ELSE 'transfer' END)`;
}

/** A single-leg row that takes money out of its account (`signedUsdDeltaForAccountMovement`'s rule). */
function movementOutgoingSql(a: string): string {
  return `(${a}.amount < 0 OR (${a}.currency <> 'clp' AND COALESCE(${a}.flow_kind, '') IN ('withdrawal_usd', 'cash_fee')))`;
}

function movementFlowValues(a: string): string {
  return `${movementKindSql(a)},
    CASE WHEN ${a}.account_id IS NULL THEN ${a}.from_account_id WHEN ${movementOutgoingSql(a)} THEN ${a}.account_id END,
    CASE WHEN ${a}.account_id IS NULL THEN ${a}.to_account_id WHEN ${movementOutgoingSql(a)} THEN NULL ELSE ${a}.account_id END,
    CASE WHEN ${a}.account_id IS NOT NULL AND NOT ${movementOutgoingSql(a)} THEN ${UNKNOWN_PARTY} END,
    CASE WHEN ${a}.account_id IS NOT NULL AND ${movementOutgoingSql(a)} THEN ${UNKNOWN_PARTY} END,
    ${a}.occurred_on, abs(${a}.amount), ${a}.currency, ${a}.counter_amount, ${a}.counter_currency, ${a}.note`;
}

function lineAmountSql(a: string): string {
  return `(CASE WHEN (SELECT currency FROM cc_statements WHERE id = ${a}.statement_id) = 'usd' THEN ${a}.amount_usd ELSE ${a}.amount_clp END)`;
}

function lineFlowValues(a: string): string {
  const amount = lineAmountSql(a);
  const negative = `(COALESCE(${amount}, 0) < 0)`;
  const account = `(SELECT account_id FROM cc_statements WHERE id = ${a}.statement_id)`;
  return `COALESCE(${a}.kind, cc_line_kind(${a}.installment_flag, ${a}.merchant, ${a}.amount_clp, ${a}.amount_usd,
      (SELECT currency FROM cc_statements WHERE id = ${a}.statement_id))),
    CASE WHEN ${negative} THEN NULL ELSE ${account} END,
    CASE WHEN ${negative} THEN ${account} END,
    CASE WHEN ${negative} THEN ${UNKNOWN_PARTY} END,
    CASE WHEN ${negative} THEN NULL ELSE ${UNKNOWN_PARTY} END,
    COALESCE(${isoFromDdMmSql(`${a}.transaction_date`)}, ${isoFromDdMmSql(`${a}.posting_date`)},
      ${isoFromDdMmSql(`(SELECT statement_date FROM cc_statements WHERE id = ${a}.statement_id)`)}),
    abs(COALESCE(${amount}, 0)), (SELECT currency FROM cc_statements WHERE id = ${a}.statement_id), NULL, NULL, ${a}.merchant`;
}

function planFlowValues(a: string): string {
  return `'card_purchase', ${a}.account_id, NULL, NULL, ${UNKNOWN_PARTY}, ${a}.purchase_date, ${a}.total_amount_clp, 'clp',
    NULL, NULL, ${a}.merchant`;
}

function manualFlowValues(a: string): string {
  return `'card_purchase', NULL, NULL, ${UNRECORDED_PARTY}, ${UNKNOWN_PARTY}, ${a}.spent_on, ${a}.amount_clp, 'clp',
    NULL, NULL, ${a}.merchant`;
}

function incomeFlowValues(a: string): string {
  return `'other_income', NULL, NULL, ${UNKNOWN_PARTY}, ${UNKNOWN_PARTY}, ${a}.received_on, ${a}.amount_clp, 'clp',
    NULL, NULL, ${a}.source`;
}

function gapMirrorFlowValues(a: string): string {
  const to = `(SELECT account_id FROM movements WHERE id = ${a}.deposit_movement_id)`;
  return `'transfer', ${a}.account_id, ${to}, NULL, CASE WHEN ${to} IS NULL THEN ${UNKNOWN_PARTY} END,
    ${a}.occurred_on, ${a}.amount_clp, 'clp', NULL, NULL, ${a}.note`;
}

const FLOW_COLUMNS = `kind, from_account_id, to_account_id, from_party_id, to_party_id, occurred_on, amount, currency,
  counter_amount, counter_currency, description`;

/** Evidence of a movement: its document by its note's provenance (the note stays human text). */
function movementEvidenceValues(a: string): string {
  const mail = `(${a}.note LIKE 'import:santander-mail|%' OR ${a}.note LIKE 'import:mach-mail|%' OR ${a}.note LIKE 'import:bancochile-mail|%')`;
  const kind = `CASE
    WHEN ${a}.note LIKE 'import:cartola|anchor|%' THEN 'cartola_anchor'
    WHEN ${a}.note LIKE 'import:cartola-partial|%' THEN 'daily_listing'
    WHEN ${a}.note LIKE 'import:cartola|%' THEN 'cartola'
    WHEN ${mail} AND EXISTS (SELECT 1 FROM transfer_notice_movements t WHERE t.movement_id = ${a}.id) THEN 'mail_notice'
    WHEN ${mail} THEN 'mail_rebuilt'
    WHEN ${a}.note LIKE 'import:fintual|%' OR ${a}.note LIKE 'import:racional%' THEN 'broker_document'
    WHEN ${a}.note LIKE 'import:buda|%' OR ${a}.note LIKE 'import:excel|%' OR ${a}.note LIKE 'import:dap|%' THEN 'legacy_import'
    ELSE 'manual' END`;
  return `${kind}, 'movements', ${a}.id, NULL, ${a}.occurred_on, ${a}.amount, ${a}.currency, ${a}.note,
    CASE ${kind} WHEN 'cartola' THEN 3 WHEN 'cartola_anchor' THEN 3 WHEN 'daily_listing' THEN 2 WHEN 'mail_notice' THEN 2 ELSE 1 END`;
}

function lineEvidenceValues(a: string): string {
  const sk = `(SELECT source_kind FROM cc_statements WHERE id = ${a}.statement_id)`;
  return `CASE ${sk} WHEN 'listing_open' THEN 'listing_open' WHEN 'statement_json' THEN 'statement_json'
      WHEN 'statement_pdf' THEN 'statement_pdf' ELSE 'statement_other' END,
    'cc_statement_lines', ${a}.id, COALESCE(${a}.parser_row_id, ${a}.dedupe_key),
    COALESCE(${isoFromDdMmSql(`${a}.transaction_date`)}, ${isoFromDdMmSql(`${a}.posting_date`)}), ${lineAmountSql(a)},
    (SELECT currency FROM cc_statements WHERE id = ${a}.statement_id), ${a}.merchant,
    CASE ${sk} WHEN 'listing_open' THEN 2 ELSE 3 END`;
}

function planEvidenceValues(a: string): string {
  return `'plan', 'cc_installment_purchases', ${a}.id, ${a}.dedupe_key, ${a}.purchase_date, ${a}.total_amount_clp, 'clp',
    ${a}.merchant, CASE WHEN ${a}.source = 'manual' THEN 1 ELSE 3 END`;
}

function manualEvidenceValues(a: string): string {
  return `'manual', 'expense_entries', ${a}.id, NULL, ${a}.spent_on, ${a}.amount_clp, 'clp', ${a}.merchant, 1`;
}

function incomeEvidenceValues(a: string): string {
  return `'manual', 'income_entries', ${a}.id, NULL, ${a}.received_on, ${a}.amount_clp, 'clp', ${a}.source, 1`;
}

function gapMirrorEvidenceValues(a: string): string {
  return `'gap_mirror', 'checking_gap_deposit_mirrors', ${a}.id, NULL, ${a}.occurred_on, ${a}.amount_clp, 'clp', ${a}.note, 1`;
}

const EVIDENCE_COLUMNS = `source_kind, source_table, source_row_id, document_key, stated_on, stated_amount, stated_currency,
  stated_description, authority`;

type SourceSpec = {
  table: FlowSourceTable | "income_entries";
  flowValues: (a: string) => string;
  evidenceValues: (a: string) => string;
  /** Rows that are not flows (a real-estate bill is a link target). */
  where?: (a: string) => string;
  /** The row carries `flow_id` (the gap mirrors are named by their evidence only). */
  hasFlowColumn: boolean;
};

const SOURCES: readonly SourceSpec[] = [
  { table: "cc_installment_purchases", flowValues: planFlowValues, evidenceValues: planEvidenceValues, hasFlowColumn: true },
  { table: "cc_statement_lines", flowValues: lineFlowValues, evidenceValues: lineEvidenceValues, hasFlowColumn: true },
  { table: "movements", flowValues: movementFlowValues, evidenceValues: movementEvidenceValues, hasFlowColumn: true },
  {
    table: "expense_entries",
    flowValues: manualFlowValues,
    evidenceValues: manualEvidenceValues,
    where: (a) => `${a}.expense_account_id IS NULL`,
    hasFlowColumn: true,
  },
  { table: "income_entries", flowValues: incomeFlowValues, evidenceValues: incomeEvidenceValues, hasFlowColumn: true },
  {
    table: "checking_gap_deposit_mirrors",
    flowValues: gapMirrorFlowValues,
    evidenceValues: gapMirrorEvidenceValues,
    hasFlowColumn: false,
  },
];

/** The insert trigger: a row written later gets its own flow and its evidence row. */
function flowInsertTriggerSql(spec: SourceSpec): string {
  const t = spec.table;
  const when = spec.where ? ` WHEN ${spec.where("NEW")}` : "";
  const setFlow = spec.hasFlowColumn
    ? `UPDATE ${t} SET flow_id = last_insert_rowid() WHERE id = NEW.id AND flow_id IS NULL;`
    : "";
  const evidenceFlow = spec.hasFlowColumn ? `(SELECT flow_id FROM ${t} WHERE id = NEW.id)` : `last_insert_rowid()`;
  const insertWhen = spec.hasFlowColumn ? `${when ? `${when} AND` : " WHEN"} NEW.flow_id IS NULL` : when;
  return `CREATE TRIGGER flow_${t}_ai AFTER INSERT ON ${t}${insertWhen} BEGIN
  INSERT INTO flows (${FLOW_COLUMNS}) SELECT ${spec.flowValues("NEW")};
  ${setFlow}
  INSERT INTO flow_evidence (flow_id, ${EVIDENCE_COLUMNS}) SELECT ${evidenceFlow}, ${spec.evidenceValues("NEW")};
END`;
}

/**
 * The delete trigger: a row deleted takes its evidence along, and its flow goes too when nothing
 * else holds it — no key, no other evidence, no row in `keepIfIn` (the row-named assignments a
 * re-key mover still has to carry: a line's pieces).
 */
function flowDeleteTriggerSql(spec: SourceSpec, keepIfIn: readonly string[]): string {
  const t = spec.table;
  const oldFlow = spec.hasFlowColumn
    ? `OLD.flow_id`
    : `(SELECT flow_id FROM flow_evidence WHERE source_table = '${t}' AND source_row_id = OLD.id)`;
  const keep = keepIfIn.map((k) => `\n    AND NOT EXISTS (SELECT 1 FROM ${k} a WHERE a.flow_id = flows.id)`).join("");
  return `CREATE TRIGGER flow_${t}_ad AFTER DELETE ON ${t} BEGIN
  DELETE FROM flows WHERE id = ${oldFlow} AND legacy_key IS NULL
    AND NOT EXISTS (SELECT 1 FROM flow_evidence e WHERE e.flow_id = flows.id AND NOT (e.source_table = '${t}' AND e.source_row_id = OLD.id))${keep};
  DELETE FROM flow_evidence WHERE source_table = '${t}' AND source_row_id = OLD.id;
END`;
}

/** Re-creates the delete triggers so a flow holding a row of `keepIfIn` outlives its rows (migration 283). */
export function reinstallFlowDeleteTriggers(dbi: DatabaseType, keepIfIn: readonly string[]): void {
  for (const spec of SOURCES) {
    dbi.exec(`DROP TRIGGER IF EXISTS flow_${spec.table}_ad`);
    dbi.exec(flowDeleteTriggerSql(spec, keepIfIn));
  }
}

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
      const spec = SOURCES.find((s) => s.table === primary.table)!;
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
    const spec = SOURCES.find((s) => s.table === table)!;
    if (spec.hasFlowColumn) dbi.prepare(`UPDATE ${table} SET flow_id = ? WHERE id = ?`).run(flowId, Number(id));
  }
  let keylessFlows = 0;
  for (const spec of SOURCES) {
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
  for (const spec of SOURCES) {
    const where = [spec.where?.("r")].filter(Boolean);
    const ids = (
      dbi.prepare(`SELECT r.id FROM ${spec.table} r ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`).all() as { id: number }[]
    ).map((r) => r.id);
    const ins = dbi.prepare(
      `INSERT INTO flow_evidence (flow_id, ${EVIDENCE_COLUMNS}) SELECT ?, ${spec.evidenceValues("r")} FROM ${spec.table} r WHERE r.id = ?`
    );
    for (const id of ids) ins.run(rowFlow.get(`${spec.table}|${id}`)!, id);
  }

  // 4. Triggers: rows written later; the write log of the new tables.
  for (const spec of SOURCES) {
    dbi.exec(flowInsertTriggerSql(spec));
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
  for (const spec of SOURCES.filter((s) => s.hasFlowColumn)) {
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
