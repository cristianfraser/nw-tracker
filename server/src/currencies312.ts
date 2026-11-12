import type { Database as DatabaseType } from "better-sqlite3";
import { FX_RATES_SPEC, runMarkInputChangeTriggers312, writeLogTriggerSql } from "./markInputTriggers.js";

/**
 * Migration 312 hook: `fx_rates` is a rate table (a row re-values the accounts whose peso figure
 * is built with rates, `FX_RATES_SPEC`), and both new tables get write-log triggers. Pure (no
 * `db` import — the module graph is still initializing when it runs).
 */
export function runCurrencies312(dbi: DatabaseType): void {
  runMarkInputChangeTriggers312(dbi);
  for (const table of ["currencies", "fx_rates"] as const) {
    const columns = (dbi.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[]).map((c) => c.name);
    const markWatch = table === FX_RATES_SPEC.table ? FX_RATES_SPEC.watch : null;
    for (const sql of writeLogTriggerSql(table, columns, markWatch)) dbi.exec(sql);
  }
}
