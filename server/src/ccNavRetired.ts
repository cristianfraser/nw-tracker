import { resolveOperationalAccountId } from "./accountSource.js";
import { db } from "./db.js";

export const CC_NAV_RETIRED_CONFIG_NOTE = "nav_retired";

/** CC master hidden from Pasivos sidebar / issuer nav (historial + group charts remain). */
export function isNavRetiredCcMaster(accountId: number): boolean {
  const masterId = resolveOperationalAccountId(accountId);
  const row = db
    .prepare(`SELECT notes FROM credit_card_account_config WHERE account_id = ?`)
    .get(masterId) as { notes: string | null } | undefined;
  return String(row?.notes ?? "").trim() === CC_NAV_RETIRED_CONFIG_NOTE;
}

export function markCcNavRetired(masterAccountId: number): void {
  const masterId = resolveOperationalAccountId(masterAccountId);
  db.prepare(`UPDATE credit_card_account_config SET notes = ? WHERE account_id = ?`).run(
    CC_NAV_RETIRED_CONFIG_NOTE,
    masterId
  );
}

export function unmarkCcNavRetired(masterAccountId: number): void {
  const masterId = resolveOperationalAccountId(masterAccountId);
  db.prepare(`UPDATE credit_card_account_config SET notes = NULL WHERE account_id = ?`).run(
    masterId
  );
}
