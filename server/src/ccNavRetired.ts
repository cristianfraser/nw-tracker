import { db } from "./db.js";

/** CC master hidden from Pasivos sidebar / issuer nav (historial + group charts remain). */
export function isNavRetiredCcMaster(accountId: number): boolean {
  const row = db
    .prepare(`SELECT nav_retired FROM credit_card_account_config WHERE account_id = ?`)
    .get(accountId) as { nav_retired: number } | undefined;
  return row?.nav_retired === 1;
}

