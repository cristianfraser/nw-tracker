import type { Database as DatabaseType } from "better-sqlite3";
import { LEGACY_FLOW_KIND_MAP } from "nw-tracker-contracts";
import type { FlowSourceTable } from "./flowKeyResolve.js";

/**
 * The flow triggers of the source tables, as the current code specifies them (docs/untangle-flow-identity.md,
 * F9 step 3): the SQL that turns a document row (a movement, a card line, a plan, a manual expense,
 * an income entry) into its flow and its evidence row. Built once per table (`*FlowValues`) and used
 * by migration 279's seed (alias `r`) and by the insert triggers (alias `NEW`), so a row written
 * later gets the same flow a row on file got.
 *
 * This is the living definition: the hooks that install or re-create these triggers
 * (`migrationHooks/flowTables279.ts`, 280–295, 317, 318) read it, and the boot check
 * (`flowTriggerCheck.ts`) holds the installed movements trigger to it. A change here needs a
 * migration that reinstalls the trigger it changes. Pure: no `db` import (it loads with `db.ts`).
 *
 * The manual-expense and income-entry triggers are the exception: migration 316 installed its own
 * text for them (see the comment on `manualFlowValues`), so `currentFlowInsertTriggerSql` is the
 * installed trigger only for `movements`, `cc_statement_lines` and `cc_installment_purchases`.
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

/** A single-leg row that takes money out of its account (`signedNativeDeltaForAccountMovement`'s rule). */
function movementOutgoingSql(a: string): string {
  return `(${a}.amount < 0 OR (${a}.currency <> 'clp' AND COALESCE(${a}.flow_kind, '') IN ('withdrawal', 'cash_fee')))`;
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

/*
 * The manual-expense and income-entry values below speak the schema migrations 279–315 knew
 * (`amount_clp`, always pesos). Migration 316 gave both tables `amount` + `currency` and rewrote the
 * installed insert triggers to read them (`expenseAmountCurrency316.ts`); a later migration that
 * re-installs one of those triggers must write its own values, not reuse these.
 */
function manualFlowValues(a: string): string {
  return `'purchase', NULL, NULL, ${UNRECORDED_PARTY}, ${UNKNOWN_PARTY}, ${a}.spent_on, ${a}.amount_clp, 'clp',
    NULL, NULL, ${a}.merchant`;
}

function incomeFlowValues(a: string): string {
  return `'other_income', NULL, NULL, ${UNKNOWN_PARTY}, ${UNKNOWN_PARTY}, ${a}.received_on, ${a}.amount_clp, 'clp',
    NULL, NULL, ${a}.source`;
}

export const FLOW_COLUMNS = `kind, from_account_id, to_account_id, from_party_id, to_party_id, occurred_on, amount, currency,
  counter_amount, counter_currency, description`;

/**
 * A movement's document kind, from its note's provenance (the one place the note grammar is read;
 * readers read `flow_evidence.source_kind`). Migration 291 keeps it in step when a note is rewritten.
 */
export function movementEvidenceKindSql(a: string): string {
  const mail = `(${a}.note LIKE 'import:santander-mail|%' OR ${a}.note LIKE 'import:mach-mail|%' OR ${a}.note LIKE 'import:bancochile-mail|%')`;
  return `CASE
    WHEN ${a}.note LIKE 'import:cartola|anchor|%' OR ${a}.note LIKE 'import:cartola|opening|%' THEN 'cartola_anchor'
    WHEN ${a}.note LIKE 'import:cartola-partial|%' THEN 'daily_listing'
    WHEN ${a}.note LIKE 'import:cartola|%' THEN 'cartola'
    WHEN ${mail} AND EXISTS (SELECT 1 FROM transfer_notice_movements t WHERE t.movement_id = ${a}.id) THEN 'mail_notice'
    WHEN ${mail} THEN 'mail_rebuilt'
    WHEN ${a}.note LIKE 'import:fintual|%' OR ${a}.note LIKE 'import:racional%' THEN 'broker_document'
    WHEN ${a}.note LIKE 'import:buda|%' OR ${a}.note LIKE 'import:excel|%' OR ${a}.note LIKE 'import:dap|%' THEN 'legacy_import'
    ELSE 'manual' END`;
}

/**
 * A bank document's row is identified by the row its importer writes (the cartola identity, the
 * daily listing's): the document key adoption looks for when the row comes back (migration 290).
 */
export function movementDocumentKeySql(a: string): string {
  return `CASE WHEN ${movementEvidenceKindSql(a)} IN ('cartola', 'cartola_anchor', 'daily_listing') THEN ${a}.note END`;
}

export function movementEvidenceAuthoritySql(a: string): string {
  return `CASE ${movementEvidenceKindSql(a)} WHEN 'cartola' THEN 3 WHEN 'cartola_anchor' THEN 3 WHEN 'daily_listing' THEN 2
    WHEN 'mail_notice' THEN 2 ELSE 1 END`;
}

/** Evidence of a movement: its document by its note's provenance (the note stays human text). */
export function movementEvidenceValues(a: string): string {
  return `${movementEvidenceKindSql(a)}, 'movements', ${a}.id, ${movementDocumentKeySql(a)}, ${a}.occurred_on, ${a}.amount,
    ${a}.currency, ${a}.note, ${movementEvidenceAuthoritySql(a)}`;
}

/** The document prefix of a card statement estimated from receipts (docs/untangle-flow-model.md C). */
export const ESTIMATE_DOCUMENT_PREFIX = "import:estimate|";
/** The line id prefix of a card line written from a receipt (into an estimate statement or a rebuilt one). */
export const ESTIMATE_LINE_ID_PREFIX = "estimate:";

/**
 * Which kinds the evidence expression may name. Migration 279 creates `flow_evidence` without
 * `estimate` (migration 295 adds it and re-kinds the lines of the estimate statements on file), so
 * 279's replay and the triggers it installs speak 279's vocabulary; 295's reinstalled trigger and
 * every later caller name `estimate`. The live database held three estimate statements before 279
 * ran (2026-11-09), which the newer vocabulary turned into a CHECK failure at boot.
 */
export type EvidenceVocabulary = { estimateKind: boolean };
const CURRENT_VOCABULARY: EvidenceVocabulary = { estimateKind: true };
/** What `flow_evidence` accepts right after migration 279's own SQL. */
export const VOCABULARY_279: EvidenceVocabulary = { estimateKind: false };

function lineEvidenceValues(a: string, vocabulary: EvidenceVocabulary = CURRENT_VOCABULARY): string {
  const sk = `(SELECT source_kind FROM cc_statements WHERE id = ${a}.statement_id)`;
  const doc = `(SELECT source_pdf FROM cc_statements WHERE id = ${a}.statement_id)`;
  const other = vocabulary.estimateKind
    ? `CASE WHEN ${doc} LIKE '${ESTIMATE_DOCUMENT_PREFIX}%' OR ${a}.parser_row_id LIKE '${ESTIMATE_LINE_ID_PREFIX}%' THEN 'estimate' ELSE 'statement_other' END`
    : `'statement_other'`;
  return `CASE ${sk} WHEN 'listing_open' THEN 'listing_open' WHEN 'statement_json' THEN 'statement_json'
      WHEN 'statement_pdf' THEN 'statement_pdf'
      WHEN 'statement_other' THEN ${other}
      ELSE 'statement_other' END,
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

export const EVIDENCE_COLUMNS = `source_kind, source_table, source_row_id, document_key, stated_on, stated_amount, stated_currency,
  stated_description, authority`;

export type SourceSpec = {
  table: FlowSourceTable | "income_entries";
  flowValues: (a: string) => string;
  evidenceValues: (a: string, vocabulary?: EvidenceVocabulary) => string;
  /** Rows that are not flows (a real-estate bill is a link target). */
  where?: (a: string) => string;
  /** The row carries `flow_id` (the gap mirrors are named by their evidence only). */
  hasFlowColumn: boolean;
};

export const FLOW_SOURCES: readonly SourceSpec[] = [
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
];

/** The insert trigger: a row written later gets its own flow and its evidence row. */
export function flowInsertTriggerSql(spec: SourceSpec, vocabulary: EvidenceVocabulary = CURRENT_VOCABULARY): string {
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
  INSERT INTO flow_evidence (flow_id, ${EVIDENCE_COLUMNS}) SELECT ${evidenceFlow}, ${spec.evidenceValues("NEW", vocabulary)};
END`;
}

/**
 * The delete trigger: a row deleted takes its evidence along, and its flow goes too when nothing
 * else holds it — no key, no other evidence, no row in `keepIfIn` (the row-named assignments a
 * re-key mover still has to carry: a line's pieces).
 */
export function flowDeleteTriggerSql(spec: SourceSpec, keepIfIn: readonly string[]): string {
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

/** The insert trigger `table` would get from the current specs (migration 317 compares it with the installed one). */
export function currentFlowInsertTriggerSql(table: SourceSpec["table"]): string {
  const spec = FLOW_SOURCES.find((s) => s.table === table);
  if (!spec) throw new Error(`no flow source ${table}`);
  return flowInsertTriggerSql(spec);
}

/** Re-creates one table's insert trigger (its flow values changed: migration 288). */
export function reinstallFlowInsertTrigger(dbi: DatabaseType, table: SourceSpec["table"]): void {
  const spec = FLOW_SOURCES.find((s) => s.table === table);
  if (!spec) throw new Error(`no flow source ${table}`);
  dbi.exec(`DROP TRIGGER IF EXISTS flow_${table}_ai`);
  dbi.exec(flowInsertTriggerSql(spec));
}

/** Re-creates the delete triggers so a flow holding a row of `keepIfIn` outlives its rows (migration 283). */
export function reinstallFlowDeleteTriggers(dbi: DatabaseType, keepIfIn: readonly string[]): void {
  for (const spec of FLOW_SOURCES) {
    dbi.exec(`DROP TRIGGER IF EXISTS flow_${spec.table}_ad`);
    dbi.exec(flowDeleteTriggerSql(spec, keepIfIn));
  }
}

/**
 * The assignment tables that keep a flow alive once its rows are gone (the delete triggers of
 * migration 290 and card-line adoption read it).
 */
export const FLOW_HOLDING_TABLES = [
  "flow_categories",
  "flow_notes",
  "flow_big_groups",
  "flow_parts",
  "flow_link_rejections",
  "flow_refunds",
  "flow_income_overrides",
] as const;
