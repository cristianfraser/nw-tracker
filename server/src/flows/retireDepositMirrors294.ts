import type { Database as DatabaseType } from "better-sqlite3";
import { FLOW_HOLDING_TABLES } from "./flowRetirement290.js";

/**
 * Migration 294 hook (docs/untangle-flow-model.md B): the synthetic checking mirrors and the cuenta
 * de ahorro funding splits are retired. Every mirror flow (its evidence names the mirror table) goes
 * with its evidence and its `synthetic` deposit links; a mirror flow carrying anything else (a
 * category, a note, a big group, a piece, a refund mark) is a surprise and fails the migration.
 * Counts only in the report. Pure: no `db` import.
 */
export function runRetireDepositMirrors294(dbi: DatabaseType): void {
  const has = (table: string) => dbi.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) != null;
  const count = (sql: string) => (dbi.prepare(sql).get() as { c: number }).c;
  const mirrors = has("checking_gap_deposit_mirrors") ? count(`SELECT COUNT(*) AS c FROM checking_gap_deposit_mirrors`) : 0;
  const splits = has("cuenta_ahorro_deposit_splits") ? count(`SELECT COUNT(*) AS c FROM cuenta_ahorro_deposit_splits`) : 0;
  const mirrorFlows = `(SELECT flow_id FROM flow_evidence WHERE source_table = 'checking_gap_deposit_mirrors')`;
  for (const t of FLOW_HOLDING_TABLES) {
    const held = count(`SELECT COUNT(*) AS c FROM ${t} WHERE flow_id IN ${mirrorFlows}`);
    if (held > 0) throw new Error(`migration 294: ${held} ${t} row(s) hang off a mirror flow`);
  }
  const strayLinks = count(
    `SELECT COUNT(*) AS c FROM flow_links WHERE (flow_id IN ${mirrorFlows} OR counterpart_flow_id IN ${mirrorFlows}) AND link_source IS NOT 'synthetic'`
  );
  if (strayLinks > 0) throw new Error(`migration 294: ${strayLinks} non-synthetic link(s) touch a mirror flow`);
  const synthetic = dbi.prepare(`DELETE FROM flow_links WHERE kind = 'funded_deposit' AND link_source = 'synthetic'`).run().changes;
  const flows = count(`SELECT COUNT(*) AS c FROM flows WHERE id IN ${mirrorFlows}`);
  dbi.prepare(`DELETE FROM flows WHERE id IN ${mirrorFlows}`).run();
  dbi.prepare(`DELETE FROM flow_evidence WHERE source_table = 'checking_gap_deposit_mirrors'`).run();
  dbi.exec(`DROP TABLE IF EXISTS checking_gap_deposit_mirrors`);
  dbi.exec(`DROP TABLE IF EXISTS cuenta_ahorro_deposit_splits`);
  console.log(
    `migration 294: ${mirrors} mirror(s) and ${splits} funding split(s) retired; ${flows} mirror flow(s) and ${synthetic} synthetic deposit link(s) removed`
  );
}
