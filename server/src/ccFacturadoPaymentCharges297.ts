import type { Database as DatabaseType } from "better-sqlite3";
import { writeLogTriggerSql } from "./markInputTriggers.js";

/**
 * Migration 297 hook: the write-log triggers of `cc_facturado_payment_charges` (F2 — a new table's
 * writes reach the caches through the change log; the expense lines' financing projection reads
 * it). Pure (no `db` import — the module graph is still initializing when it runs).
 */
export function runFacturadoPaymentCharges297(dbi: DatabaseType): void {
  const columns = (
    dbi.prepare(`SELECT name FROM pragma_table_info('cc_facturado_payment_charges')`).all() as { name: string }[]
  ).map((c) => c.name);
  for (const sql of writeLogTriggerSql("cc_facturado_payment_charges", columns, null)) dbi.exec(sql);
}
