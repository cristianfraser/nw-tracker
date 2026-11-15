import type { Database as DatabaseType } from "better-sqlite3";

/**
 * Migration 314 hook: every currency column of these tables names a row of `currencies`
 * (`REFERENCES currencies(code)`) instead of a literal `CHECK (col IN ('clp', 'usd', ...))` list,
 * so a currency the app learns is one `currencies` row, not a table rebuild.
 *
 * Each table is rebuilt from its own CREATE as stored in `sqlite_master`: only the named columns'
 * CHECK list is replaced (or, where a column has none, the reference is appended), every other
 * column, constraint, index and trigger is kept as it was — indexes and triggers are read before the
 * DROP (which takes them with it) and re-created verbatim after the rename. Runs with foreign keys
 * off (db.ts `FOREIGN_KEYS_OFF_MIGRATIONS`): several of these tables are referenced by
 * ON DELETE CASCADE children, and a DROP with foreign keys on would delete them. Pure (no `db`
 * import — the module graph is still initializing when it runs).
 */
export const CURRENCY_REFERENCE_COLUMNS_314: readonly { table: string; columns: readonly string[] }[] = [
  { table: "cc_statements", columns: ["currency"] },
  { table: "cc_bank_cupo_snapshots", columns: ["currency"] },
  { table: "cc_header_payment_legs", columns: ["currency"] },
  { table: "cc_planted_payment_lines", columns: ["currency"] },
  { table: "cc_manual_payments", columns: ["currency"] },
  { table: "cc_owed_anchors", columns: ["currency"] },
  { table: "bank_account_numbers", columns: ["currency"] },
  { table: "bank_account_balance_snapshots", columns: ["currency"] },
  { table: "merchant_receipts", columns: ["currency"] },
  { table: "merchant_subscription_notices", columns: ["currency"] },
  { table: "payroll_work_earnings", columns: ["liquido_currency"] },
  { table: "equity_dividends", columns: ["currency"] },
  { table: "broker_withdrawal_requests", columns: ["currency"] },
  { table: "incoming_wire_notices", columns: ["currency"] },
  { table: "recurring_payments", columns: ["currency"] },
  { table: "movements", columns: ["currency", "counter_currency"] },
  { table: "movement_dividend_details", columns: ["currency"] },
  { table: "loan_payments", columns: ["loan_currency", "payment_currency"] },
  { table: "fund_unit_daily", columns: ["currency"] },
  { table: "pension_fund_unit_official", columns: ["currency"] },
  { table: "flows", columns: ["currency", "counter_currency"] },
];

const REFERENCE = "REFERENCES currencies(code)";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The table's CREATE with each column's currency CHECK list replaced by the reference. */
export function withCurrencyReferences(createSql: string, table: string, columns: readonly string[]): string {
  let sql = createSql;
  for (const column of columns) {
    const col = escapeRegExp(column);
    // `col TEXT [NOT NULL] [DEFAULT 'x'] [CHECK (col IN (...))]` up to the comma or closing paren
    // that ends the column definition (the CHECK may sit on its own line).
    const definition = new RegExp(
      `(^|[\\s(,])(${col}\\s+TEXT(?:\\s+NOT\\s+NULL)?(?:\\s+DEFAULT\\s+'[a-z]+')?)` +
        `(\\s+CHECK\\s*\\(\\s*${col}\\s+IN\\s*\\([^()]*\\)\\s*\\))?(?=\\s*[,)])`,
      "g"
    );
    const matches = [...sql.matchAll(definition)];
    if (matches.length !== 1) {
      throw new Error(`migration 314: ${table}.${column}: expected one column definition, found ${matches.length}`);
    }
    const m = matches[0]!;
    const start = m.index! + m[1]!.length;
    const end = m.index! + m[0].length;
    sql = `${sql.slice(0, start)}${m[2]} ${REFERENCE}${sql.slice(end)}`;
    if (new RegExp(`CHECK\\s*\\(\\s*${col}\\s+IN\\s*\\(`).test(sql)) {
      throw new Error(`migration 314: ${table}.${column}: a currency CHECK list is left after the rewrite`);
    }
  }
  return sql;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function rebuildTable(dbi: DatabaseType, table: string, columns: readonly string[]): void {
  const row = dbi.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as
    | { sql: string }
    | undefined;
  if (!row) throw new Error(`migration 314: table ${table} does not exist`);
  const temp = `${table}__currency_ref_314`;
  const created = withCurrencyReferences(row.sql, table, columns);
  const head = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("[^"]+"|\S+)/i.exec(created);
  if (!head) throw new Error(`migration 314: ${table}: cannot read the CREATE TABLE head`);
  const newSql = `CREATE TABLE ${quoteIdent(temp)}${created.slice(head[0].length)}`;

  const indexes = (
    dbi
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY rowid")
      .all(table) as { sql: string }[]
  ).map((r) => r.sql);
  // In creation order: SQLite fires a table's triggers for one event in the reverse of the order
  // they were created, and the change log reads that order (a movement logs its own row last).
  const triggers = (
    dbi.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? ORDER BY rowid").all(table) as {
      sql: string;
    }[]
  ).map((r) => r.sql);
  const columnList = (dbi.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[])
    .map((c) => quoteIdent(c.name))
    .join(", ");
  const count = (name: string): number =>
    (dbi.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(name)}`).get() as { n: number }).n;

  dbi.exec(newSql);
  dbi.exec(`INSERT INTO ${quoteIdent(temp)} (${columnList}) SELECT ${columnList} FROM ${quoteIdent(table)}`);
  const before = count(table);
  const after = count(temp);
  if (before !== after) throw new Error(`migration 314: ${table}: row count drifted (${before} -> ${after})`);
  dbi.exec(`DROP TABLE ${quoteIdent(table)}`);
  // Legacy rename: triggers on other tables name this one in their bodies (movements: the loan
  // payment and mirror-merge mark triggers, the card-to-card delete trigger); a modern RENAME
  // re-checks every schema object and fails on them while the table is dropped. Nothing names
  // the temporary table, so nothing needs rewriting.
  dbi.exec(`ALTER TABLE ${quoteIdent(temp)} RENAME TO ${quoteIdent(table)}`);
  const stored = (dbi.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as {
    sql: string;
  }).sql;
  if (!stored.includes(REFERENCE)) throw new Error(`migration 314: ${table}: the reference did not survive the rename`);
  for (const sql of indexes) dbi.exec(sql);
  for (const sql of triggers) dbi.exec(sql);

  const references = new Set(
    (dbi.prepare(`SELECT "from", "table", "to" FROM pragma_foreign_key_list(?)`).all(table) as {
      from: string;
      table: string;
      to: string;
    }[])
      .filter((fk) => fk.table === "currencies" && fk.to === "code")
      .map((fk) => fk.from)
  );
  for (const column of columns) {
    if (!references.has(column)) throw new Error(`migration 314: ${table}.${column} does not reference currencies`);
  }
}

export function runCurrencyReferences314(dbi: DatabaseType): void {
  if (dbi.pragma("foreign_keys", { simple: true }) !== 0) {
    throw new Error(
      "migration 314 requires foreign_keys=OFF for the table rebuilds " +
        "(DROP TABLE would cascade-delete child-table rows); db.ts must list it in FOREIGN_KEYS_OFF_MIGRATIONS"
    );
  }
  const legacy = dbi.pragma("legacy_alter_table", { simple: true });
  dbi.pragma("legacy_alter_table = ON");
  try {
    for (const { table, columns } of CURRENCY_REFERENCE_COLUMNS_314) rebuildTable(dbi, table, columns);
  } finally {
    dbi.pragma(`legacy_alter_table = ${legacy ? "ON" : "OFF"}`);
  }
  const fkViolations = dbi.pragma("foreign_key_check") as unknown[];
  if (fkViolations.length > 0) {
    throw new Error(`migration 314: foreign_key_check reports ${fkViolations.length} violation(s) after the rebuilds`);
  }
}
