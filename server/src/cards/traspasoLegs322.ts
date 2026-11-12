import type { Database as DatabaseType } from "better-sqlite3";

/**
 * Migration 322 hook (docs/any-currency-plan.md, Phase C3): a traspaso de deuda link names its two
 * legs by direction and currency instead of «the CLP leg» and «the USD leg». The debt leaves one
 * sub-balance (`from_line_id`, `from_currency`, `from_amount`: the abono, the dollars so far) and
 * enters another (`to_line_id`, `to_currency`, `to_amount`: the cargo, the pesos so far), the
 * bank's conversion being `to_amount / from_amount`. Every link on file is dollars → pesos.
 *
 * The table is rebuilt (columns renamed and added), its rows copied and counted, its index and
 * triggers re-created from the ones on file in their order with the renamed columns. Nothing
 * references the table. Pure: no `db` import.
 */

type TriggerRow = { name: string; sql: string };

const RENAMES = [
  ["usd_line_id", "from_line_id"],
  ["clp_line_id", "to_line_id"],
  ["amount_usd", "from_amount"],
  ["amount_clp", "to_amount"],
] as const;

export function triggerSql322(t: TriggerRow): string {
  let sql = t.sql;
  for (const [from, to] of RENAMES) sql = sql.split(from).join(to);
  if (t.name === "write_log_cc_traspaso_deuda_links_au") {
    const piece = `(OLD."id" IS NOT NEW."id" OR OLD."created_at" IS NOT NEW."created_at")`;
    if (sql.split(piece).length !== 2) throw new Error(`migration 322: trigger ${t.name} is not the shape on file`);
    sql = sql.replace(
      piece,
      `(OLD."id" IS NOT NEW."id" OR OLD."created_at" IS NOT NEW."created_at" OR OLD."from_currency" IS NOT NEW."from_currency" OR OLD."to_currency" IS NOT NEW."to_currency")`
    );
  }
  return sql;
}

export function runTraspasoLegs322(dbi: DatabaseType): void {
  const table = "cc_traspaso_deuda_links";
  const triggers = dbi
    .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? ORDER BY rowid`)
    .all(table) as TriggerRow[];
  const indexes = dbi
    .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL AND tbl_name = ? ORDER BY rowid`)
    .all(table) as { name: string; sql: string }[];
  const rewritten = triggers.map((t) => ({ name: t.name, sql: triggerSql322(t) }));
  const before = (dbi.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
  dbi.exec(`CREATE TABLE cc_traspaso_deuda_links_322 (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  from_line_id INTEGER NOT NULL UNIQUE REFERENCES cc_statement_lines(id) ON DELETE CASCADE,
  from_currency TEXT NOT NULL REFERENCES currencies(code),
  from_amount REAL NOT NULL CHECK (from_amount > 0),
  to_line_id INTEGER NOT NULL UNIQUE REFERENCES cc_statement_lines(id) ON DELETE CASCADE,
  to_currency TEXT NOT NULL REFERENCES currencies(code),
  to_amount REAL NOT NULL CHECK (to_amount > 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (from_line_id <> to_line_id),
  CHECK (from_currency <> to_currency)
)`);
  dbi.exec(`INSERT INTO cc_traspaso_deuda_links_322
      (id, account_id, from_line_id, from_currency, from_amount, to_line_id, to_currency, to_amount, created_at)
    SELECT id, account_id, usd_line_id, 'usd', amount_usd, clp_line_id, 'clp', amount_clp, created_at FROM ${table}`);
  dbi.exec(`DROP TABLE ${table}`);
  dbi.pragma("legacy_alter_table = ON");
  try {
    dbi.exec(`ALTER TABLE cc_traspaso_deuda_links_322 RENAME TO ${table}`);
  } finally {
    dbi.pragma("legacy_alter_table = OFF");
  }
  const after = (dbi.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
  if (after !== before) throw new Error(`migration 322: ${table} had ${before} row(s), now ${after}`);
  for (const ix of indexes) dbi.exec(ix.sql);
  for (const t of rewritten) dbi.exec(t.sql);
  const fk = dbi.prepare(`PRAGMA foreign_key_check`).all();
  if (fk.length > 0) throw new Error(`migration 322: foreign key check failed: ${JSON.stringify(fk.slice(0, 5))}`);
}
