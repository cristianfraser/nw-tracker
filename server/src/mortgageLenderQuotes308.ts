import type { Database as DatabaseType } from "better-sqlite3";
import { writeLogTriggerSql } from "./markInputTriggers.js";

/**
 * Migration 308 hook: the write-log triggers of `mortgage_lender_quotes` (F2 — a new table's
 * writes reach the caches through the change log: «Próximos pagos» and the mortgage scenarios read
 * the quote). Pure (no `db` import — the module graph is still initializing when it runs).
 */
export const MORTGAGE_LENDER_QUOTES_TABLE_308 = "mortgage_lender_quotes";

export function runMortgageLenderQuotes308(dbi: DatabaseType): void {
  const columns = (
    dbi.prepare(`SELECT name FROM pragma_table_info('${MORTGAGE_LENDER_QUOTES_TABLE_308}')`).all() as { name: string }[]
  ).map((c) => c.name);
  for (const sql of writeLogTriggerSql(MORTGAGE_LENDER_QUOTES_TABLE_308, columns, null)) dbi.exec(sql);
}
