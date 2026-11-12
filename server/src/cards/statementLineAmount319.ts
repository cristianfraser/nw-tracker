import type { Database as DatabaseType } from "better-sqlite3";

/**
 * Migration 319 hook (docs/any-currency-plan.md, Phase C3): a card statement line holds its amount
 * in the currency it is stated in — `amount` + `currency` (→ `currencies`) and `cuota_amount` (the
 * monthly cuota of an installment line, same currency) — instead of the two slots `amount_clp` /
 * `amount_usd` and `valor_cuota_mensual_clp` / `_usd`.
 *
 * A line's currency is its own, not always its statement's: an open web-paste bucket is one
 * statement row (currency `clp`) whose dollar lines carried `amount_clp` 0 and the dollars in
 * `amount_usd`. On file no line carries both (checked on a copy of the 2026-11-12 database: 7.198
 * lines, a dollar amount only on dollar lines), so the line's currency is `usd` exactly when
 * `amount_usd` is set.
 *
 * The four legacy names stay as **generated** columns (read-only, derived from the stored ones), so
 * the readers that still speak in pesos and dollars read exactly the values they read before: a
 * peso line's `amount_clp` is its amount (`amount_usd` NULL), a dollar line's `amount_clp` 0 and
 * `amount_usd` its amount; `valor_cuota_mensual_clp` is a peso line's cuota and 0 on a dollar line,
 * `valor_cuota_mensual_usd` a dollar line's cuota. A line in any other currency reads NULL in
 * every legacy column: a reader not yet moved onto `amount` + `currency` sees no amount there. One
 * stored row differs: a dollar line whose `amount_clp` was NULL (an estimated 2019 line) reads 0.
 *
 * The table is rebuilt (columns change type and generated columns cannot be added in place), its
 * rows copied and checked, its indexes re-created and its triggers re-created from the ones on file
 * in their order (SQLite fires one event's triggers newest first): the triggers that read the
 * amounts read `amount` / `currency` / `cuota_amount`, the kind is decided by
 * `cc_line_kind_native` (the same classifier fed the line's own amount and currency), and the flow
 * an inserted line opens takes the line's amount when the line is in its statement's currency (a
 * dollar line in a peso bucket opened its flow with the bucket's 0 pesos before, and still does).
 * The swap runs in legacy rename mode: the mark triggers of `cc_traspaso_deuda_links` name this
 * table and keep naming it. Pure: no `db` import (the module graph is still loading when it runs).
 */

type TriggerRow = { name: string; sql: string };

const TABLE = "cc_statement_lines";

const CREATE = `CREATE TABLE cc_statement_lines_319 (
  id INTEGER PRIMARY KEY,
  statement_id INTEGER NOT NULL REFERENCES cc_statements(id) ON DELETE CASCADE,
  transaction_date TEXT,
  posting_date TEXT,
  place TEXT,
  merchant TEXT,
  description_merged TEXT,
  country TEXT,
  amount_orig REAL,
  orig_currency TEXT,
  amount REAL,
  currency TEXT NOT NULL DEFAULT 'clp' REFERENCES currencies(code),
  installment_flag INTEGER NOT NULL DEFAULT 0 CHECK (installment_flag IN (0, 1)),
  nro_cuota_current INTEGER,
  nro_cuota_total INTEGER,
  cuota_amount REAL,
  interest_rate_text TEXT,
  tipo_cuota TEXT,
  dedupe_key TEXT,
  parser_row_id TEXT,
  raw_line TEXT,
  origin_card_last4 TEXT,
  cuota_purchase_kind TEXT
    CHECK (cuota_purchase_kind IS NULL OR cuota_purchase_kind IN ('cuota_comercio', 'precio_contado')),
  kind TEXT CHECK (kind IS NULL OR kind IN (
    'card_purchase', 'card_refund', 'installment_cuota', 'card_payment', 'card_debt_transfer', 'financing_charge'
  )),
  flow_id INTEGER REFERENCES flows(id) ON DELETE SET NULL,
  amount_clp INTEGER GENERATED ALWAYS AS (CASE currency WHEN 'clp' THEN amount WHEN 'usd' THEN 0 END) VIRTUAL,
  amount_usd REAL GENERATED ALWAYS AS (CASE currency WHEN 'usd' THEN amount END) VIRTUAL,
  valor_cuota_mensual_clp INTEGER GENERATED ALWAYS AS (CASE currency WHEN 'clp' THEN cuota_amount WHEN 'usd' THEN 0 END) VIRTUAL,
  valor_cuota_mensual_usd REAL GENERATED ALWAYS AS (CASE currency WHEN 'usd' THEN cuota_amount END) VIRTUAL
)`;

const KEPT = [
  "id", "statement_id", "transaction_date", "posting_date", "place", "merchant", "description_merged", "country",
  "amount_orig", "orig_currency", "installment_flag", "nro_cuota_current", "nro_cuota_total", "interest_rate_text",
  "tipo_cuota", "dedupe_key", "parser_row_id", "raw_line", "origin_card_last4", "cuota_purchase_kind", "kind", "flow_id",
] as const;

const COPY = `INSERT INTO cc_statement_lines_319 (${KEPT.join(", ")}, amount, currency, cuota_amount)
  SELECT ${KEPT.join(", ")},
    CASE WHEN amount_usd IS NOT NULL THEN amount_usd ELSE amount_clp END,
    CASE WHEN amount_usd IS NOT NULL THEN 'usd' ELSE 'clp' END,
    CASE WHEN amount_usd IS NOT NULL THEN valor_cuota_mensual_usd ELSE valor_cuota_mensual_clp END
  FROM cc_statement_lines`;

const OLD_KIND_CALL = (row: "NEW" | "") =>
  `cc_line_kind(${row ? `${row}.` : ""}installment_flag, ${row ? `${row}.` : ""}merchant, ${row ? `${row}.` : ""}amount_clp, ${row ? `${row}.` : ""}amount_usd,`;
const NEW_KIND_CALL = (row: "NEW" | "") =>
  `cc_line_kind_native(${row ? `${row}.` : ""}installment_flag, ${row ? `${row}.` : ""}merchant, ${row ? `${row}.` : ""}amount, ${row ? `${row}.` : ""}currency,`;

const OLD_LINE_AMOUNT =
  "(CASE WHEN (SELECT currency FROM cc_statements WHERE id = NEW.statement_id) = 'usd' THEN NEW.amount_usd ELSE NEW.amount_clp END)";
const NEW_LINE_AMOUNT =
  "(CASE WHEN NEW.currency = (SELECT currency FROM cc_statements WHERE id = NEW.statement_id) THEN NEW.amount ELSE 0 END)";

/** The trigger reading the stored amount columns; throws when its shape is not the one on file. */
export function triggerSql319(t: TriggerRow): string {
  let sql = t.sql;
  const replaceExactly = (from: string, to: string, times: number): void => {
    const n = sql.split(from).length - 1;
    if (n !== times) throw new Error(`migration 319: trigger ${t.name} names «${from}» ${n} time(s), expected ${times}`);
    sql = sql.split(from).join(to);
  };
  switch (t.name) {
    case "mark_input_cc_statement_lines_ai":
    case "mark_input_cc_statement_lines_ad":
    case "flow_cc_statement_lines_ad":
      break;
    case "mark_input_cc_statement_lines_au":
      replaceExactly(
        "OLD.amount_clp IS NOT NEW.amount_clp OR OLD.amount_usd IS NOT NEW.amount_usd",
        "OLD.amount IS NOT NEW.amount OR OLD.currency IS NOT NEW.currency",
        1
      );
      break;
    case "write_log_cc_statement_lines_au":
      replaceExactly(
        "OLD.amount_clp IS NEW.amount_clp AND OLD.amount_usd IS NEW.amount_usd",
        "OLD.amount IS NEW.amount AND OLD.currency IS NEW.currency",
        1
      );
      replaceExactly(
        `OLD."valor_cuota_mensual_clp" IS NOT NEW."valor_cuota_mensual_clp" OR OLD."valor_cuota_mensual_usd" IS NOT NEW."valor_cuota_mensual_usd"`,
        `OLD."cuota_amount" IS NOT NEW."cuota_amount"`,
        1
      );
      break;
    case "cc_statement_lines_kind_ai":
      replaceExactly(OLD_KIND_CALL("NEW"), NEW_KIND_CALL("NEW"), 1);
      break;
    case "cc_statement_lines_kind_au":
      replaceExactly(
        "AFTER UPDATE OF installment_flag, merchant, amount_clp, amount_usd ON",
        "AFTER UPDATE OF installment_flag, merchant, amount, currency ON",
        1
      );
      replaceExactly(OLD_KIND_CALL("NEW"), NEW_KIND_CALL("NEW"), 1);
      break;
    case "flow_cc_statement_lines_ai":
      replaceExactly(OLD_KIND_CALL("NEW"), NEW_KIND_CALL("NEW"), 1);
      replaceExactly(OLD_LINE_AMOUNT, NEW_LINE_AMOUNT, 6);
      break;
    default:
      throw new Error(`migration 319: unexpected trigger ${t.name} on ${TABLE}`);
  }
  if (/amount_clp|amount_usd|valor_cuota_mensual/.test(sql)) {
    throw new Error(`migration 319: trigger ${t.name} still names a legacy amount column`);
  }
  return sql;
}

export function runStatementLineAmount319(dbi: DatabaseType): void {
  const both = (
    dbi
      .prepare(`SELECT COUNT(*) AS c FROM cc_statement_lines WHERE amount_usd IS NOT NULL AND COALESCE(amount_clp, 0) <> 0`)
      .get() as { c: number }
  ).c;
  if (both > 0) throw new Error(`migration 319: ${both} card line(s) carry both pesos and dollars — one currency per line`);
  const usdCuotaOnPesoSlot = (
    dbi
      .prepare(
        `SELECT COUNT(*) AS c FROM cc_statement_lines
         WHERE (amount_usd IS NOT NULL AND COALESCE(valor_cuota_mensual_clp, 0) <> 0)
            OR (amount_usd IS NULL AND valor_cuota_mensual_usd IS NOT NULL)`
      )
      .get() as { c: number }
  ).c;
  if (usdCuotaOnPesoSlot > 0) {
    throw new Error(`migration 319: ${usdCuotaOnPesoSlot} card line(s) carry a cuota in another currency than their amount`);
  }

  const triggers = dbi
    .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? ORDER BY rowid`)
    .all(TABLE) as TriggerRow[];
  const indexes = dbi
    .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL AND tbl_name = ? ORDER BY rowid`)
    .all(TABLE) as { name: string; sql: string }[];
  const rewritten = triggers.map((t) => ({ name: t.name, sql: triggerSql319(t) }));

  // What the legacy columns read before, to check the generated ones read the same.
  dbi.exec(`CREATE TEMP TABLE cc_statement_lines_319_before AS
    SELECT id, amount_clp, amount_usd, valor_cuota_mensual_clp, valor_cuota_mensual_usd FROM cc_statement_lines`);

  const before = (dbi.prepare(`SELECT COUNT(*) AS c FROM ${TABLE}`).get() as { c: number }).c;
  dbi.exec(CREATE);
  dbi.exec(COPY);
  dbi.exec(`DROP TABLE ${TABLE}`);
  dbi.pragma("legacy_alter_table = ON");
  try {
    dbi.exec(`ALTER TABLE cc_statement_lines_319 RENAME TO ${TABLE}`);
  } finally {
    dbi.pragma("legacy_alter_table = OFF");
  }
  const after = (dbi.prepare(`SELECT COUNT(*) AS c FROM ${TABLE}`).get() as { c: number }).c;
  if (after !== before) throw new Error(`migration 319: ${TABLE} had ${before} row(s), now ${after}`);

  const differing = dbi
    .prepare(
      `SELECT b.id, b.amount_clp AS old_clp, l.amount_clp AS new_clp FROM cc_statement_lines_319_before b
       JOIN cc_statement_lines l ON l.id = b.id
       WHERE NOT (b.amount_usd IS l.amount_usd AND b.valor_cuota_mensual_clp IS l.valor_cuota_mensual_clp
         AND b.valor_cuota_mensual_usd IS l.valor_cuota_mensual_usd
         AND (b.amount_clp IS l.amount_clp OR (b.amount_clp IS NULL AND l.currency = 'usd')))`
    )
    .all() as { id: number }[];
  if (differing.length > 0) {
    throw new Error(`migration 319: ${differing.length} line(s) read differently: ${JSON.stringify(differing.slice(0, 5))}`);
  }
  dbi.exec(`DROP TABLE cc_statement_lines_319_before`);

  for (const ix of indexes) dbi.exec(ix.sql);
  for (const t of rewritten) dbi.exec(t.sql);

  const fk = dbi.prepare(`PRAGMA foreign_key_check`).all();
  if (fk.length > 0) throw new Error(`migration 319: foreign key check failed: ${JSON.stringify(fk.slice(0, 5))}`);
}
