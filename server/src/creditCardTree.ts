import { isSupersededSantanderCcMaster } from "./ccConsolidatedCards.js";
import { ccIssuerSlugForMasterAccount } from "./ccIssuerForAccount.js";
import { ccIssuerBySlug, type CcIssuerSlug } from "./ccIssuers.js";
import { db } from "./db.js";

/** Operational CC masters in asset group `credit_cards` (Gastos, category PATCH allowlist). */
export function listCreditCardMasterAccountIds(): number[] {
  const rows = db
    .prepare(
      `SELECT a.id
       FROM accounts a
       JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE (g.slug = 'credit_card' OR g.slug LIKE '%__credit_card')
         AND a.import_key LIKE 'credit_card_master|%'
       ORDER BY a.import_key`
    )
    .all() as { id: number }[];
  return rows
    .map((r) => r.id)
    .filter((id) => !isSupersededSantanderCcMaster(id));
}

/**
 * The masters Pasivos › tarjeta de crédito lists, in its order: by issuer (`CC_ISSUERS`
 * `sort_order`), then as `listCreditCardMasterAccountIds` lists them. The liabilities seed links
 * them as the group's account items.
 */
export function listCreditCardMasterAccountIdsInNavOrder(): number[] {
  const issuerOrder = (id: number) => ccIssuerBySlug(ccIssuerSlugForMasterAccount(id))!.sort_order;
  return listCreditCardMasterAccountIds()
    .map((id, index) => ({ id, index, order: issuerOrder(id) }))
    .sort((a, b) => a.order - b.order || a.index - b.index)
    .map((r) => r.id);
}

/** The operational masters of one issuer (`credit_card_account_config.issuer`). */
export function listCreditCardMasterAccountIdsForIssuer(issuer: CcIssuerSlug): number[] {
  return listCreditCardMasterAccountIds().filter((id) => ccIssuerSlugForMasterAccount(id) === issuer);
}

export function resolveMasterAccountIdForCardLast4(last4: string): number | null {
  const l4 = String(last4 ?? "").trim();
  if (!l4) return null;
  const row = db
    .prepare(
      `SELECT a.id
       FROM accounts a
       JOIN credit_card_account_config c ON c.account_id = a.id
       WHERE c.card_last4 = ?
       LIMIT 1`
    )
    .get(l4) as { id: number } | undefined;
  if (row) return row.id;
  // `credit_card_account_config.card_last4` is the card identity — a master without a
  // config row is a data problem, not a case for note archaeology.
  return null;
}
