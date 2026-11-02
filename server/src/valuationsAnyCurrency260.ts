import type { Database as DatabaseType } from "better-sqlite3";
import { runMarkInputChangeTriggers260 } from "./markInputChangeTriggers211.js";

/**
 * Migration 260 hook (pure: no `db` import — the module graph is still initializing). After the
 * SQL rebuilt `valuations` with a currency-agnostic CHECK:
 *
 * - The property appraisals of migration 258 become the property account's `valuations` rows,
 *   in their currency (UF). A property account's valuations are its appraisals: its value is
 *   net equity, derived by the depto ledger from the appraisal and the loan balance. Its peso
 *   rows (month-end figures of the spreadsheet era) are deleted first — UNIQUE(account, date)
 *   holds one currency per account and date, and nothing read them as the value (the depto
 *   ledger valued every date they cover; the property chart's month-ends are derived from its
 *   ledger since this migration).
 * - `property_appraisals` is dropped.
 * - The mark-input triggers are re-installed (the rebuild dropped the ones on `valuations`, and
 *   the ones on `property_appraisals` go with the table).
 */
export function runValuationsAnyCurrency260(dbi: DatabaseType): void {
  movePropertyAppraisalsIntoValuations260(dbi);
  runMarkInputChangeTriggers260(dbi);
}

/** The data step of {@link runValuationsAnyCurrency260} (tested on its own). */
export function movePropertyAppraisalsIntoValuations260(dbi: DatabaseType): void {
  const hasAppraisals = dbi
    .prepare(`SELECT 1 AS o FROM sqlite_master WHERE type = 'table' AND name = 'property_appraisals'`)
    .get();
  if (hasAppraisals) {
    const accounts = dbi
      .prepare(`SELECT DISTINCT account_id AS id FROM property_appraisals ORDER BY account_id`)
      .all() as { id: number }[];
    const del = dbi.prepare(`DELETE FROM valuations WHERE account_id = ?`);
    for (const { id } of accounts) del.run(id);
    dbi.exec(
      `INSERT INTO valuations (account_id, as_of_date, value, currency)
         SELECT account_id, as_of_date, value, currency FROM property_appraisals ORDER BY account_id, as_of_date`
    );
    const left = (
      dbi.prepare(`SELECT COUNT(*) AS c FROM property_appraisals`).get() as { c: number }
    ).c;
    const moved = (
      dbi
        .prepare(
          `SELECT COUNT(*) AS c FROM valuations v
           JOIN property_appraisals p ON p.account_id = v.account_id AND p.as_of_date = v.as_of_date
             AND p.value = v.value AND p.currency = v.currency`
        )
        .get() as { c: number }
    ).c;
    if (moved !== left) {
      throw new Error(`migration 260: ${left - moved} property appraisal(s) did not reach valuations`);
    }
    dbi.exec(`DROP TABLE property_appraisals`);
  }
}
