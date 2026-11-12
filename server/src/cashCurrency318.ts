import type { Database as DatabaseType } from "better-sqlite3";
import { reinstallMovementFlowInsertTrigger } from "./flows/movementFlowTrigger317.js";
import { accountsTriggerSql318 } from "./markInputTriggers.js";
import { reinstallTableTriggersInOrder } from "./tableTriggerReinstall.js";

/**
 * Migration 318 hook (docs/any-currency-plan.md Phase C1). The SQL added `accounts.cash_currency`
 * and renamed the stored flow kinds named after a currency to currency-neutral ones. Here:
 *
 * 1. every cash ledger account declares the currency its leaf names (`<key>__usd` → usd,
 *    `<key>__clp` → clp; the leaf kind is the leaf portfolio group's, else the slug's last
 *    `__` segment, as `accountBucketKindSlug` reads it);
 * 2. the `accounts` mark and write-log triggers are re-created over the new column (the mark
 *    trigger watches it: a declaration decides how the account's history is valued);
 * 3. the movements flow-insert trigger is re-created with the new kind names in its CASE.
 *
 * Triggers keep their table's creation order. Pure: no `db` import.
 */
export function runCashCurrency318(dbi: DatabaseType): void {
  const rows = dbi
    .prepare(
      `SELECT a.id, g.slug AS leaf_slug, pg.kind_slug AS leaf_kind
       FROM accounts a
       JOIN asset_groups g ON g.id = a.asset_group_id
       LEFT JOIN portfolio_groups pg ON pg.slug = g.slug`
    )
    .all() as { id: number; leaf_slug: string; leaf_kind: string | null }[];
  const named: Record<string, string> = { clp: "clp", usd: "usd" };
  const set = dbi.prepare(`UPDATE accounts SET cash_currency = ? WHERE id = ?`);
  for (const r of rows) {
    const sep = r.leaf_slug.lastIndexOf("__");
    const kind = r.leaf_kind ?? (sep >= 0 ? r.leaf_slug.slice(sep + 2) : r.leaf_slug);
    const currency = named[kind];
    if (currency != null) set.run(currency, r.id);
  }
  reinstallTableTriggersInOrder(dbi, "accounts", accountsTriggerSql318(dbi), "migration 318");
  reinstallMovementFlowInsertTrigger(dbi, "migration 318");
}
