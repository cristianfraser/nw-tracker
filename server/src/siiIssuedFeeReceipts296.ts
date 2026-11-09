import type { Database as DatabaseType } from "better-sqlite3";
import { writeLogTriggerSql } from "./markInputTriggers.js";

/**
 * Migration 296 hook: the write-log triggers of `sii_issued_fee_receipts` (F2 — a new table's
 * writes reach the caches through the change log; the F22 draft reads it). Pure (no `db` import —
 * the module graph is still initializing when it runs).
 */
export function runSiiIssuedFeeReceipts296(dbi: DatabaseType): void {
  const columns = (
    dbi.prepare(`SELECT name FROM pragma_table_info('sii_issued_fee_receipts')`).all() as { name: string }[]
  ).map((c) => c.name);
  for (const sql of writeLogTriggerSql("sii_issued_fee_receipts", columns, null)) dbi.exec(sql);
}
