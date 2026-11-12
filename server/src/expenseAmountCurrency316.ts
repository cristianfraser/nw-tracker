import type { Database as DatabaseType } from "better-sqlite3";

/**
 * Migration 316 hook (docs/any-currency-plan.md, Phase B): `expense_entries`, `income_entries` and
 * `flow_parts` hold `amount` in a currency instead of a peso-only `amount_clp`.
 *
 * - `expense_entries`: `amount` + `currency` (→ `currencies`); a place bill (`expense_account_id`
 *   set) is in pesos by CHECK — the bill matchers compare it with a purchase's pesos.
 * - `income_entries`: `amount` + `currency` (legacy rows, all pesos).
 * - `flow_parts`: `amount` in the currency of the flow the part is of (`flows.currency`); REAL, so a
 *   piece of a dollar line is dollars to the cent. A part on file is on a peso flow (asserted: the
 *   old column was pesos whatever the flow, and a dollar flow's pesos cannot be turned back into its
 *   dollars here).
 *
 * Each table is rebuilt (a CHECK cannot be added in place), its rows copied and counted, its
 * indexes re-created, and its triggers re-created from the ones on file in their order (SQLite
 * fires one event's triggers newest first, which the flow triggers rely on): the flow insert
 * triggers read the row's amount and currency where they named `amount_clp` and `'clp'`, the
 * write-log update triggers watch `amount` and `currency`. The swap runs in legacy rename mode, as
 * migration 293's does: the flow delete triggers of other tables name `flow_parts` and keep naming
 * it. Pure: no `db` import (the module graph is still loading when it runs).
 */

type TriggerRow = { name: string; sql: string };

const TABLES = ["expense_entries", "income_entries", "flow_parts"] as const;
type RebuiltTable = (typeof TABLES)[number];

const CREATE: Record<RebuiltTable, string> = {
  expense_entries: `CREATE TABLE expense_entries_316 (
  id INTEGER PRIMARY KEY,
  amount REAL NOT NULL CHECK (amount >= 0),
  currency TEXT NOT NULL DEFAULT 'clp' REFERENCES currencies(code),
  spent_on TEXT NOT NULL,
  category TEXT,
  note TEXT,
  import_batch_id INTEGER,
  expense_account_id INTEGER REFERENCES expense_accounts(id),
  kwh REAL,
  m3 REAL,
  months_covered INTEGER NOT NULL DEFAULT 1 CHECK (months_covered >= 1),
  merchant TEXT,
  flow_id INTEGER REFERENCES flows(id) ON DELETE SET NULL,
  CHECK (expense_account_id IS NULL OR currency = 'clp')
)`,
  income_entries: `CREATE TABLE income_entries_316 (
  id INTEGER PRIMARY KEY,
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'clp' REFERENCES currencies(code),
  received_on TEXT NOT NULL,
  source TEXT,
  note TEXT,
  flow_id INTEGER REFERENCES flows(id) ON DELETE SET NULL
)`,
  flow_parts: `CREATE TABLE flow_parts_316 (
  flow_id INTEGER NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'piece' CHECK (kind IN ('piece', 'principal', 'extra_principal', 'interest', 'insurance_fire', 'insurance_life', 'prepayment_charge', 'bank_fee')),
  category_id INTEGER REFERENCES cc_expense_categories(id),
  amount REAL NOT NULL CHECK (amount > 0),
  note TEXT,
  spent_on TEXT CHECK (spent_on IS NULL OR spent_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  PRIMARY KEY (flow_id, seq),
  CHECK (kind <> 'piece' OR category_id IS NOT NULL)
)`,
};

const COPY: Record<RebuiltTable, string> = {
  expense_entries: `INSERT INTO expense_entries_316 (id, amount, currency, spent_on, category, note, import_batch_id,
      expense_account_id, kwh, m3, months_covered, merchant, flow_id)
    SELECT id, amount_clp, 'clp', spent_on, category, note, import_batch_id, expense_account_id, kwh, m3, months_covered,
      merchant, flow_id FROM expense_entries`,
  income_entries: `INSERT INTO income_entries_316 (id, amount, currency, received_on, source, note, flow_id)
    SELECT id, amount_clp, 'clp', received_on, source, note, flow_id FROM income_entries`,
  flow_parts: `INSERT INTO flow_parts_316 (flow_id, seq, kind, category_id, amount, note, spent_on)
    SELECT flow_id, seq, kind, category_id, amount_clp, note, spent_on FROM flow_parts`,
};

/** The trigger with its amount read from the row and its currency; throws when its shape is not the one on file. */
export function triggerSql316(t: TriggerRow): string {
  let sql = t.sql;
  const replaceExactly = (from: string, to: string, times: number): void => {
    const n = sql.split(from).length - 1;
    if (n !== times) throw new Error(`migration 316: trigger ${t.name} names «${from}» ${n} time(s), expected ${times}`);
    sql = sql.split(from).join(to);
  };
  if (t.name === "flow_expense_entries_ai" || t.name === "flow_income_entries_ai") {
    replaceExactly(`NEW.amount_clp, 'clp'`, `NEW.amount, NEW.currency`, 2);
  } else if (t.name === "write_log_flow_parts_au") {
    // A part's currency is its flow's: the table has no column of its own.
    replaceExactly(`OLD."amount_clp" IS NOT NEW."amount_clp"`, `OLD."amount" IS NOT NEW."amount"`, 1);
  } else if (t.name.startsWith("write_log_") && t.name.endsWith("_au")) {
    replaceExactly(`OLD."amount_clp" IS NOT NEW."amount_clp"`, `OLD."amount" IS NOT NEW."amount" OR OLD."currency" IS NOT NEW."currency"`, 1);
  }
  if (sql.includes("amount_clp")) throw new Error(`migration 316: trigger ${t.name} still names amount_clp`);
  return sql;
}

export function runExpenseAmountCurrency316(dbi: DatabaseType): void {
  const onForeignFlow = (
    dbi
      .prepare(`SELECT COUNT(*) AS c FROM flow_parts p JOIN flows f ON f.id = p.flow_id WHERE f.currency <> 'clp'`)
      .get() as { c: number }
  ).c;
  if (onForeignFlow > 0) {
    throw new Error(`migration 316: ${onForeignFlow} flow part(s) on a flow not in pesos — their pesos cannot be restated in the flow's currency`);
  }

  const triggers = dbi
    .prepare(
      `SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN (${TABLES.map((t) => `'${t}'`).join(", ")}) ORDER BY rowid`
    )
    .all() as TriggerRow[];
  const indexes = dbi
    .prepare(
      `SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL AND tbl_name IN (${TABLES.map((t) => `'${t}'`).join(", ")}) ORDER BY rowid`
    )
    .all() as { name: string; sql: string }[];
  const rewritten = triggers.map((t) => ({ name: t.name, sql: triggerSql316(t) }));

  for (const table of TABLES) {
    const before = (dbi.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
    dbi.exec(CREATE[table]);
    dbi.exec(COPY[table]);
    dbi.exec(`DROP TABLE ${table}`);
    dbi.pragma("legacy_alter_table = ON");
    try {
      dbi.exec(`ALTER TABLE ${table}_316 RENAME TO ${table}`);
    } finally {
      dbi.pragma("legacy_alter_table = OFF");
    }
    const after = (dbi.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
    if (after !== before) throw new Error(`migration 316: ${table} had ${before} row(s), now ${after}`);
  }
  for (const ix of indexes) dbi.exec(ix.sql);
  for (const t of rewritten) dbi.exec(t.sql);

  const fk = dbi.prepare(`PRAGMA foreign_key_check`).all();
  if (fk.length > 0) throw new Error(`migration 316: foreign key check failed: ${JSON.stringify(fk.slice(0, 5))}`);
}
