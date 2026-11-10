import type { Database as DatabaseType } from "better-sqlite3";
import { OPTION_CONTRACTS_SPEC, runMarkInputChangeTriggers304, writeLogTriggerSql } from "./markInputTriggers.js";

/**
 * Migration 304 hook: the contract terms are a mark input (a change re-values the account's whole
 * history, `OPTION_CONTRACTS_SPEC`), and both new tables get write-log triggers (F2 — a new
 * table's writes reach the caches through the change log). Pure (no `db` import — the module
 * graph is still initializing when it runs).
 */
export function runOptionContracts304(dbi: DatabaseType): void {
  runMarkInputChangeTriggers304(dbi);
  for (const table of ["option_contracts", "option_assignments"] as const) {
    const columns = (dbi.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[]).map((c) => c.name);
    const markWatch = table === OPTION_CONTRACTS_SPEC.table ? OPTION_CONTRACTS_SPEC.watch : null;
    for (const sql of writeLogTriggerSql(table, columns, markWatch)) dbi.exec(sql);
  }
}
