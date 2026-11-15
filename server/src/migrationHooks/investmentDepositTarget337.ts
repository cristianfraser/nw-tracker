import type { Database as DatabaseType } from "better-sqlite3";
import { writeLogTriggerSql } from "../markInputTriggers.js";
import { reinstallTableTriggersInOrder } from "./tableTriggerReinstall.js";

/** The `portfolio_groups` columns its mark triggers watch when migration 337 runs (frozen). */
const PORTFOLIO_GROUPS_MARK_WATCH_337 = ["slug", "kind_slug", "parent_id"] as const;

/**
 * Migration 337 hook: `portfolio_groups.investment_deposit_target` exists now. Re-create the
 * table's write-log update trigger over the table's columns, so a change of the new role is a
 * logged write (the nav tree memo and the caches built on it follow the log). The table's other
 * triggers keep their text and their order. Pure: no `db` import.
 */
export function runInvestmentDepositTarget337(dbi: DatabaseType): void {
  const columns = (dbi.prepare(`SELECT name FROM pragma_table_info('portfolio_groups')`).all() as { name: string }[]).map(
    (c) => c.name
  );
  const replacements: Record<string, string> = {};
  for (const sql of writeLogTriggerSql("portfolio_groups", columns, PORTFOLIO_GROUPS_MARK_WATCH_337)) {
    replacements[/CREATE TRIGGER (\S+)/.exec(sql)![1]!] = sql;
  }
  reinstallTableTriggersInOrder(dbi, "portfolio_groups", replacements, "migration 337");
}
