import type { Database as DatabaseType } from "better-sqlite3";
import { writeLogTriggerSql } from "./markInputTriggers.js";

/**
 * Migration 302 hook: the write-log triggers of `tax_residency_periods` (F2 — a new table's writes
 * reach the caches through the change log; the F22 draft, which reads the periods, is built per
 * request, but the home bundle's «próximos pagos» and every other response cache drop on any API
 * write). Pure (no `db` import — the module graph is still initializing when it runs).
 */
export const TAX_RESIDENCY_TABLE_302 = "tax_residency_periods";

export function runTaxResidency302(dbi: DatabaseType): void {
  const columns = (dbi.prepare(`SELECT name FROM pragma_table_info('${TAX_RESIDENCY_TABLE_302}')`).all() as { name: string }[]).map(
    (c) => c.name
  );
  for (const sql of writeLogTriggerSql(TAX_RESIDENCY_TABLE_302, columns, null)) dbi.exec(sql);
}
