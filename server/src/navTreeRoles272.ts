import type { Database as DatabaseType } from "better-sqlite3";
import { CURRENT_MARK_INPUT_SPECS, writeLogTriggerSql } from "./markInputTriggers.js";

/**
 * Migration 272 hook: seed the nav roles of the existing nodes from the slugs that decided them
 * until now, and re-create `portfolio_groups`' write-log update trigger so the new columns count
 * as writes. Pure (no `db` import — the module graph is still initializing when it runs).
 *
 * Frozen: a later change of the roles is data (or a new migration), never an edit here. A fresh
 * database has no nodes yet; the nav seed creates them with these roles.
 */
export const NAV_ROLES_272 = {
  nwBuckets: ["real_estate", "retirement", "brokerage", "cash_eqs"],
  investmentRoots: ["brokerage", "retirement"],
  /** Group → the group whose total it nets. */
  nets: [
    ["cash_eqs", "liabilities_credit_card"],
    ["cash_savings", "liabilities_credit_card"],
  ],
  propertyOverlay: ["real_estate"],
} as const;

export function runNavTreeRoles272(dbi: DatabaseType): void {
  const set = (column: string, slugs: readonly string[]) => {
    const stmt = dbi.prepare(`UPDATE portfolio_groups SET ${column} = 1 WHERE slug = ?`);
    for (const slug of slugs) stmt.run(slug);
  };
  set("nw_bucket", NAV_ROLES_272.nwBuckets);
  set("investment_root", NAV_ROLES_272.investmentRoots);
  set("property_overlay", NAV_ROLES_272.propertyOverlay);
  const nets = dbi.prepare(
    `UPDATE portfolio_groups SET nets_linked_group_id = (SELECT id FROM portfolio_groups WHERE slug = ?) WHERE slug = ?`
  );
  for (const [slug, linked] of NAV_ROLES_272.nets) nets.run(linked, slug);

  const watch = CURRENT_MARK_INPUT_SPECS.find((s) => s.table === "portfolio_groups")?.watch ?? null;
  const columns = (dbi.prepare(`SELECT name FROM pragma_table_info('portfolio_groups')`).all() as { name: string }[]).map(
    (c) => c.name
  );
  for (const sql of writeLogTriggerSql("portfolio_groups", columns, watch)) {
    const name = /CREATE TRIGGER (\S+)/.exec(sql)![1];
    dbi.exec(`DROP TRIGGER IF EXISTS ${name}`);
    dbi.exec(sql);
  }
}
