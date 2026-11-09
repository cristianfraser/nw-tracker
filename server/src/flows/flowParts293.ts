import type { Database as DatabaseType } from "better-sqlite3";
import { CURRENT_MARK_INPUT_SPECS, writeLogTriggerSql } from "../markInputTriggers.js";
import { FLOW_PART_KINDS_SQL, loanPaymentPartRowsSql } from "./flowParts.js";

/**
 * Migration 293 hook (docs/untangle-flow-model.md A2): `flow_parts` gains a kind. The table is
 * rebuilt (SQLite cannot relax a NOT NULL or widen a CHECK in place) with every row on file a
 * `piece`, its write log reinstalled, then the loan payments' parts are seeded from
 * `loan_payments` on the property leg's flow. The seed reports how many payments' parts add up to
 * their payment (± 1 peso) and how many do not — counts only; the cross-check script settles those
 * with the user's accepted differences. `loan_payments` gained `prepayment_charge` in the SQL, so its
 * write log is reinstalled too (an update of the new column alone must reach the caches). Pure: no
 * `db` import (the module graph is still loading when it runs).
 */
export function runFlowPartKinds293(dbi: DatabaseType): void {
  const before = (dbi.prepare(`SELECT COUNT(*) AS c FROM flow_parts`).get() as { c: number }).c;
  dbi.exec(`CREATE TABLE flow_parts_293 (
  flow_id INTEGER NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'piece' CHECK (kind IN (${FLOW_PART_KINDS_SQL})),
  category_id INTEGER REFERENCES cc_expense_categories(id),
  amount_clp INTEGER NOT NULL CHECK (amount_clp > 0),
  note TEXT,
  spent_on TEXT CHECK (spent_on IS NULL OR spent_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  PRIMARY KEY (flow_id, seq),
  CHECK (kind <> 'piece' OR category_id IS NOT NULL)
)`);
  dbi.exec(
    `INSERT INTO flow_parts_293 (flow_id, seq, kind, category_id, amount_clp, note, spent_on)
     SELECT flow_id, seq, 'piece', category_id, amount_clp, note, spent_on FROM flow_parts`
  );
  // The flow delete triggers of the source tables name `flow_parts`: a rename re-parses the whole
  // schema and would refuse while the table is gone (and would rewrite those triggers to the new
  // name), so the swap runs in legacy rename mode — the triggers keep saying `flow_parts`, which the
  // renamed table is again when the rename ends.
  dbi.exec(`DROP TABLE flow_parts`);
  dbi.pragma("legacy_alter_table = ON");
  try {
    dbi.exec(`ALTER TABLE flow_parts_293 RENAME TO flow_parts`);
  } finally {
    dbi.pragma("legacy_alter_table = OFF");
  }
  const copied = (dbi.prepare(`SELECT COUNT(*) AS c FROM flow_parts`).get() as { c: number }).c;
  if (copied !== before) throw new Error(`migration 293: ${before} piece(s) became ${copied}`);
  installWriteLog(dbi, "flow_parts");

  // The loan payments' parts: one movement per property-leg flow, or the parts would land on two
  // payments at once.
  const shared = (
    dbi
      .prepare(
        `SELECT COUNT(*) AS c FROM loan_payments p JOIN movements m ON m.id = p.movement_id
         WHERE p.leg = 'property' AND (m.flow_id IS NULL OR (SELECT COUNT(*) FROM movements x WHERE x.flow_id = m.flow_id) <> 1)`
      )
      .get() as { c: number }
  ).c;
  if (shared > 0) throw new Error(`migration 293: ${shared} property-leg payment(s) whose flow is not their own`);
  dbi.exec(`INSERT INTO flow_parts (flow_id, seq, kind, amount_clp) SELECT flow_id, seq, kind, amount_clp FROM (${loanPaymentPartRowsSql()})`);
  const sums = dbi
    .prepare(
      `SELECT CASE WHEN abs(COALESCE((SELECT SUM(f.amount_clp) FROM flow_parts f WHERE f.flow_id = m.flow_id AND f.kind <> 'piece'), 0) - abs(m.amount)) <= 1
                   THEN 'even' ELSE 'uneven' END AS verdict, COUNT(*) AS c
       FROM loan_payments p JOIN movements m ON m.id = p.movement_id
       WHERE p.leg = 'property' AND lower(trim(p.cuota)) <> 'pie'
       GROUP BY verdict`
    )
    .all() as { verdict: string; c: number }[];
  const even = sums.find((s) => s.verdict === "even")?.c ?? 0;
  const uneven = sums.find((s) => s.verdict === "uneven")?.c ?? 0;
  console.log(
    `migration 293: ${before} piece(s) re-kinded; loan payment parts seeded on ${even + uneven} payment(s), ${even} adding up to the payment (± 1), ${uneven} not (settled by scripts/cross-check-loan-payment-history.ts)`
  );

  // The write log of loan_payments: its update trigger named the columns of migration 258.
  dbi.exec(`DROP TRIGGER IF EXISTS write_log_loan_payments_au`);
  const loanColumns = (dbi.prepare(`SELECT name FROM pragma_table_info('loan_payments')`).all() as { name: string }[]).map((c) => c.name);
  const watch = CURRENT_MARK_INPUT_SPECS.find((s) => s.table === "loan_payments")?.watch;
  if (!watch) throw new Error("migration 293: loan_payments has no mark spec");
  for (const sql of writeLogTriggerSql("loan_payments", loanColumns, watch)) dbi.exec(sql);
}

function installWriteLog(dbi: DatabaseType, table: string): void {
  const columns = (dbi.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[]).map((c) => c.name);
  for (const sql of writeLogTriggerSql(table, columns, null)) dbi.exec(sql);
}
