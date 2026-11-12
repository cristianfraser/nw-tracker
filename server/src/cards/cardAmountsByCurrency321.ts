import type { Database as DatabaseType } from "better-sqlite3";
import {
  CC_FEED_BILLING_CLOSE_AMOUNTS_SPEC,
  CREDIT_CARD_CUPOS_SPEC,
  markInputTriggerSql,
  writeLogTriggerSql,
} from "../markInputTriggers.js";

/**
 * Migration 321 hook (docs/any-currency-plan.md, Phase C3): two card amounts kept as a peso and a
 * dollar column become rows per currency.
 *
 * - `credit_card_account_config.cupo_clp` / `cupo_usd` → `credit_card_cupos(account_id, currency,
 *   amount)` (a NULL cupo has no row).
 * - `cc_feed_billing_closes.saldo_inicial_clp` / `_usd` → `cc_feed_billing_close_amounts(close_id,
 *   currency, amount)`: what the feed's SALDO INICIAL row states the close billed in each currency.
 *
 * The old columns are dropped. Both tables' triggers watched them, so the triggers on file are
 * dropped first and re-created after, in their order, without the dropped columns (SQLite fires one
 * event's triggers newest first). The new tables get their own mark and write-log triggers: a cupo
 * re-reads a card's whole history, as the config column did; a close amount re-frames its billing
 * month, as the close did. Foreign keys are checked before the transaction commits.
 */

type TriggerRow = { name: string; sql: string };

function triggersOf(dbi: DatabaseType, table: string): TriggerRow[] {
  return dbi
    .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? ORDER BY rowid`)
    .all(table) as TriggerRow[];
}

/** `sql` with each piece replaced exactly `times` times; throws when the trigger's shape is not the one on file. */
function edit(name: string, sql: string, pieces: readonly (readonly [string, string, number])[]): string {
  let out = sql;
  for (const [from, to, times] of pieces) {
    const n = out.split(from).length - 1;
    if (n !== times) throw new Error(`migration 321: trigger ${name} names «${from}» ${n} time(s), expected ${times}`);
    out = out.split(from).join(to);
  }
  return out;
}

function rebuildTriggersWithout(
  dbi: DatabaseType,
  table: string,
  dropped: readonly string[],
  rewrite: (t: TriggerRow) => string
): void {
  const triggers = triggersOf(dbi, table).map((t) => ({ name: t.name, sql: rewrite(t) }));
  for (const t of triggers) {
    if (dropped.some((c) => t.sql.includes(c))) throw new Error(`migration 321: trigger ${t.name} still names a dropped column`);
  }
  for (const t of triggersOf(dbi, table)) dbi.exec(`DROP TRIGGER "${t.name}"`);
  for (const c of dropped) dbi.exec(`ALTER TABLE ${table} DROP COLUMN ${c}`);
  for (const t of triggers) dbi.exec(t.sql);
}

function installNewTableTriggers(dbi: DatabaseType, spec: typeof CREDIT_CARD_CUPOS_SPEC): void {
  for (const sql of markInputTriggerSql(spec)) dbi.exec(sql);
  const columns = (dbi.prepare(`SELECT name FROM pragma_table_info(?)`).all(spec.table) as { name: string }[]).map((c) => c.name);
  for (const sql of writeLogTriggerSql(spec.table, columns, spec.watch)) dbi.exec(sql);
}

export function runCardAmountsByCurrency321(dbi: DatabaseType): void {
  // Cupos.
  dbi.exec(`CREATE TABLE credit_card_cupos (
    account_id INTEGER NOT NULL REFERENCES credit_card_account_config(account_id) ON DELETE CASCADE,
    currency TEXT NOT NULL REFERENCES currencies(code),
    amount REAL NOT NULL CHECK (amount >= 0),
    PRIMARY KEY (account_id, currency)
  )`);
  const cuposBefore = (
    dbi
      .prepare(
        `SELECT (SELECT COUNT(*) FROM credit_card_account_config WHERE cupo_clp IS NOT NULL)
              + (SELECT COUNT(*) FROM credit_card_account_config WHERE cupo_usd IS NOT NULL) AS c`
      )
      .get() as { c: number }
  ).c;
  dbi.exec(`INSERT INTO credit_card_cupos (account_id, currency, amount)
    SELECT account_id, 'clp', cupo_clp FROM credit_card_account_config WHERE cupo_clp IS NOT NULL
    UNION ALL SELECT account_id, 'usd', cupo_usd FROM credit_card_account_config WHERE cupo_usd IS NOT NULL`);
  const cuposAfter = (dbi.prepare(`SELECT COUNT(*) AS c FROM credit_card_cupos`).get() as { c: number }).c;
  if (cuposAfter !== cuposBefore) throw new Error(`migration 321: ${cuposBefore} cupo(s), ${cuposAfter} copied`);
  rebuildTriggersWithout(dbi, "credit_card_account_config", ["cupo_clp", "cupo_usd"], (t) => {
    if (t.name === "mark_input_credit_card_account_config_au") {
      return edit(t.name, t.sql, [["OLD.cupo_clp IS NOT NEW.cupo_clp OR OLD.cupo_usd IS NOT NEW.cupo_usd OR ", "", 1]]);
    }
    if (t.name === "write_log_credit_card_account_config_au") {
      return edit(t.name, t.sql, [["OLD.cupo_clp IS NEW.cupo_clp AND OLD.cupo_usd IS NEW.cupo_usd AND ", "", 1]]);
    }
    return t.sql;
  });
  installNewTableTriggers(dbi, CREDIT_CARD_CUPOS_SPEC);

  // Feed SALDO INICIAL per currency.
  dbi.exec(`CREATE TABLE cc_feed_billing_close_amounts (
    close_id INTEGER NOT NULL REFERENCES cc_feed_billing_closes(id) ON DELETE CASCADE,
    currency TEXT NOT NULL REFERENCES currencies(code),
    amount REAL NOT NULL,
    PRIMARY KEY (close_id, currency)
  )`);
  const amountsBefore = (
    dbi
      .prepare(
        `SELECT (SELECT COUNT(*) FROM cc_feed_billing_closes WHERE saldo_inicial_clp IS NOT NULL)
              + (SELECT COUNT(*) FROM cc_feed_billing_closes WHERE saldo_inicial_usd IS NOT NULL) AS c`
      )
      .get() as { c: number }
  ).c;
  dbi.exec(`INSERT INTO cc_feed_billing_close_amounts (close_id, currency, amount)
    SELECT id, 'clp', saldo_inicial_clp FROM cc_feed_billing_closes WHERE saldo_inicial_clp IS NOT NULL
    UNION ALL SELECT id, 'usd', saldo_inicial_usd FROM cc_feed_billing_closes WHERE saldo_inicial_usd IS NOT NULL`);
  const amountsAfter = (dbi.prepare(`SELECT COUNT(*) AS c FROM cc_feed_billing_close_amounts`).get() as { c: number }).c;
  if (amountsAfter !== amountsBefore) throw new Error(`migration 321: ${amountsBefore} SALDO INICIAL amount(s), ${amountsAfter} copied`);
  rebuildTriggersWithout(dbi, "cc_feed_billing_closes", ["saldo_inicial_clp", "saldo_inicial_usd"], (t) => {
    if (t.name === "mark_input_cc_feed_billing_closes_au") {
      return edit(t.name, t.sql, [[" OR OLD.saldo_inicial_clp IS NOT NEW.saldo_inicial_clp OR OLD.saldo_inicial_usd IS NOT NEW.saldo_inicial_usd", "", 1]]);
    }
    if (t.name === "write_log_cc_feed_billing_closes_au") {
      return edit(t.name, t.sql, [[" AND OLD.saldo_inicial_clp IS NEW.saldo_inicial_clp AND OLD.saldo_inicial_usd IS NEW.saldo_inicial_usd", "", 1]]);
    }
    return t.sql;
  });
  installNewTableTriggers(dbi, CC_FEED_BILLING_CLOSE_AMOUNTS_SPEC);

  const fk = dbi.prepare(`PRAGMA foreign_key_check`).all();
  if (fk.length > 0) throw new Error(`migration 321: foreign key check failed: ${JSON.stringify(fk.slice(0, 5))}`);
}
