import type { Database as DatabaseType } from "better-sqlite3";
import { writeLogTriggerSql } from "./markInputTriggers.js";

export const CC_PLANTED_CHARGE_LINES_TABLE_328 = "cc_planted_charge_lines";

/**
 * Migration 328 hook: the new table's write-log triggers, and the planted charge lines already on
 * file registered from the receipts that wrote them — a lender receipt's charge (its card, its
 * paid day, its pesos) and a grocery receipt whose line the importer created (`card_line_status =
 * 'created'`: its card, purchase day, pesos paid by card). Only a listing-bucket line that alone
 * carries those facts is registered; any other count leaves the receipt unregistered. Pure (no `db`
 * import — the module graph is still initializing when it runs).
 */
export function runPlantedChargeLines328(dbi: DatabaseType): void {
  const table = CC_PLANTED_CHARGE_LINES_TABLE_328;
  const columns = (dbi.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[]).map((c) => c.name);
  if (columns.length === 0) throw new Error(`migration 328: table ${table} does not exist`);
  for (const sql of writeLogTriggerSql(table, columns, null)) dbi.exec(sql);

  // A listing line's day as stored: d/m/yyyy, each part with or without its leading zero.
  const renderings = (iso: string): string[] => {
    const [y, m, d] = [iso.slice(0, 4), iso.slice(5, 7), iso.slice(8, 10)];
    const days = [...new Set([d, String(Number(d))])];
    const months = [...new Set([m, String(Number(m))])];
    return days.flatMap((dd) => months.map((mm) => `${dd}/${mm}/${y}`));
  };
  const bucketLines = dbi.prepare(
    `SELECT l.id FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id
     WHERE s.account_id = ? AND s.source_kind IN ('listing_open', 'listing_other')
       AND l.installment_flag = 0 AND l.currency = 'clp' AND l.amount = ?
       AND l.transaction_date IN (?, ?, ?, ?)`
  );
  const ins = dbi.prepare(
    `INSERT OR IGNORE INTO cc_planted_charge_lines (line_id, account_id, source) VALUES (?, ?, ?)`
  );
  const register = (accountId: number | null, amount: number | null, iso: string | null, source: string) => {
    if (accountId == null || amount == null || amount <= 0 || !iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return;
    const days = renderings(iso.slice(0, 10));
    while (days.length < 4) days.push(days[0]!);
    const hits = bucketLines.all(accountId, amount, ...days) as { id: number }[];
    if (hits.length === 1) ins.run(hits[0]!.id, accountId, source);
  };
  const lender = dbi
    .prepare(`SELECT card_account_id, amount_clp, paid_on FROM mortgage_payment_receipts`)
    .all() as { card_account_id: number; amount_clp: number; paid_on: string }[];
  for (const r of lender) register(r.card_account_id, r.amount_clp, r.paid_on, "cc_lender_receipt");
  const boletas = dbi
    .prepare(
      `SELECT card_line_account_id, card_paid_clp, purchased_at FROM grocery_receipts WHERE card_line_status = 'created'`
    )
    .all() as { card_line_account_id: number | null; card_paid_clp: number | null; purchased_at: string | null }[];
  for (const r of boletas) register(r.card_line_account_id, r.card_paid_clp, r.purchased_at, "cc_lider_boleta");
}
