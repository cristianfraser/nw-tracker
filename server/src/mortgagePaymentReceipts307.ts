import type { Database as DatabaseType } from "better-sqlite3";
import { writeLogTriggerSql } from "./markInputTriggers.js";

/**
 * Migration 307 hook: the write-log triggers of `mortgage_payment_receipts` (F2 — a new table's
 * writes reach the caches through the change log). Pure (no `db` import — the module graph is
 * still initializing when it runs).
 */
export const MORTGAGE_PAYMENT_RECEIPTS_TABLE_307 = "mortgage_payment_receipts";

export function runMortgagePaymentReceipts307(dbi: DatabaseType): void {
  const columns = (
    dbi.prepare(`SELECT name FROM pragma_table_info('${MORTGAGE_PAYMENT_RECEIPTS_TABLE_307}')`).all() as { name: string }[]
  ).map((c) => c.name);
  for (const sql of writeLogTriggerSql(MORTGAGE_PAYMENT_RECEIPTS_TABLE_307, columns, null)) dbi.exec(sql);
}
